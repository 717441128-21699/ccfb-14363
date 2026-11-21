/**
 * 世界模拟主循环
 *
 * 时间口径：
 * - 现实 1 秒 = gameSpeed 个游戏分钟（1x 时一整天 1440 分钟 = 现实 24 分钟）
 * - 所有需求增长 / 行动持续都按游戏分钟结算
 *
 * 性能口径（对应测试的 3ms 预算）：
 * - NPC 决策错峰调度：每帧只处理 nextDecideAt 到期的人，
 *   2000 人的决策平均摊到 ~90 个游戏分钟的重估周期里
 * - 决策热路径零分配（见 utility.ts / npc.ts）
 * - stats.lastDecisionMs 记录最近一帧决策阶段真实耗时，HUD 直接展示
 */

import { ACTION_DEFS } from '../core/actions';
import { CurveLibrary, NEED_CONFIG } from '../core/config';
import { clampNeed } from '../core/curves';
import { decide } from '../core/utility';
import type {
  ActionId,
  DecisionLogEntry,
  DecisionReason,
  Needs,
} from '../core/types';
import { createFacilities, Facility, WORLD_H, WORLD_W } from './facility';
import { Npc } from './npc';
import { Rng } from './rng';

/** 现实 1 秒对应多少游戏分钟（1x 速度） */
export const MINUTES_PER_SECOND = 60;
/** 决策重估间隔（游戏分钟），实际在 ±30 内随机错峰 */
const REDECIDE_INTERVAL = 90;
/** 闲逛目标区域（中央空地） */
const WANDER_RECT = { x: 400, y: 330, w: 480, h: 200 };

export interface WorldStats {
  /** 最近一帧做了多少次决策 */
  decisionsLastFrame: number;
  /** 最近一帧决策阶段耗时（毫秒） */
  lastDecisionMs: number;
  /** 决策耗时的滑动平均（毫秒） */
  avgDecisionMs: number;
  /** 累计决策次数 */
  totalDecisions: number;
}

export interface WorldOptions {
  npcCount: number;
  seed: number;
  /** 设施容量放大倍数（2000 人压测用） */
  capacityScale: number;
}

export class World {
  readonly curves = new CurveLibrary();
  readonly facilities: Facility[];
  readonly facilityMap: Map<string, Facility>;
  readonly npcs: Npc[];
  readonly rng: Rng;

  /** 当前游戏内分钟（0~1440 循环） */
  clockMin = 6 * 60; // 清晨六点开局
  /** 第几天 */
  day = 1;
  /** 游戏速度倍率（现实秒 → 游戏分钟的倍数） */
  gameSpeed = 1;
  paused = false;

  readonly stats: WorldStats = {
    decisionsLastFrame: 0,
    lastDecisionMs: 0,
    avgDecisionMs: 0,
    totalDecisions: 0,
  };

  /** 被调试页追踪的 NPC（其决策写入环形日志） */
  private trackedNpc: Npc | null = null;

  constructor(opts: WorldOptions) {
    this.rng = new Rng(opts.seed);
    this.facilities = createFacilities(opts.capacityScale);
    this.facilityMap = new Map(this.facilities.map((f) => [f.id, f]));
    this.npcs = [];

    for (let i = 0; i < opts.npcCount; i++) {
      const spawn = {
        x: this.rng.range(WANDER_RECT.x, WANDER_RECT.x + WANDER_RECT.w),
        y: this.rng.range(WANDER_RECT.y, WANDER_RECT.y + WANDER_RECT.h),
      };
      this.npcs.push(new Npc(i, this.rng, spawn, this.clockMin));
    }
  }

  get tracked(): Npc | null {
    return this.trackedNpc;
  }

  /** 开启对某 NPC 的全天决策记录（同时只追踪一个） */
  trackNpc(npc: Npc | null): void {
    if (this.trackedNpc) this.trackedNpc.loggingEnabled = false;
    this.trackedNpc = npc;
    if (npc) {
      npc.loggingEnabled = true;
      npc.clearLog();
    }
  }

  /**
   * 推进一帧。
   * @param realDt 现实帧间隔（秒）
   */
  update(realDt: number): void {
    if (this.paused) return;
    const dtMin = realDt * MINUTES_PER_SECOND * this.gameSpeed;
    if (dtMin <= 0) return;

    // —— 1. 时钟推进（跨天）——
    const before = this.clockMin;
    this.clockMin += dtMin;
    let wrapped = false;
    if (this.clockMin >= 1440) {
      this.clockMin %= 1440;
      this.day++;
      wrapped = true;
    }
    if (wrapped) this.onDayRollOver();

    // —— 2. 决策阶段（错峰，只处理到期且空闲的 NPC）——
    const t0 = performance.now();
    let decided = 0;
    for (const npc of this.npcs) {
      if (npc.mode !== 'idle') continue;
      if (npc.nextDecideAt <= this.clockMin || this.crossed(before, npc.nextDecideAt)) {
        this.runDecision(npc);
        decided++;
      }
    }
    const decisionMs = performance.now() - t0;
    this.stats.decisionsLastFrame = decided;
    this.stats.lastDecisionMs = decisionMs;
    this.stats.totalDecisions += decided;
    // 滑动平均（alpha 滤波），无决策的帧不参与
    if (decided > 0) {
      this.stats.avgDecisionMs =
        this.stats.avgDecisionMs === 0
          ? decisionMs
          : this.stats.avgDecisionMs * 0.9 + decisionMs * 0.1;
    }

    // —— 3. 需求自然增长（时辰曲线驱动）——
    this.growNeeds(dtMin);

    // —— 4. 移动与行动执行 ——
    this.updateMovement(realDt);
    this.updateActions(dtMin);
  }

  /** 判断时钟跨天时是否越过某个调度点 */
  private crossed(before: number, point: number): boolean {
    return before > this.clockMin && point <= this.clockMin;
  }

  /**
   * 跨天处理：
   * 1. 发放每日盘缠（旅客打零工/托汇，保证经济循环不断流），节俭的人攒得多一点
   * 2. 修正回绕前就到期、但本帧没被处理的调度点，让空闲 NPC 立刻重估，
   *    避免他们在新的一天里干等到深夜
   */
  private onDayRollOver(): void {
    for (const npc of this.npcs) {
      const stipend = 70 + Math.round(npc.traits.frugal * 40);
      npc.money += stipend;
      if (npc.mode === 'idle' && npc.nextDecideAt > this.clockMin) {
        npc.nextDecideAt = this.clockMin - 1;
      }
    }
  }

  /** 对单个 NPC 跑一次完整 Utility 决策并落实结果 */
  private runDecision(npc: Npc): void {
    decide(this, npc, npc.ctx);
    const ai = npc.decidedActionIndex;
    const def = ACTION_DEFS[ai];

    // 设施槽位：评分看到的空槽此刻仍有效（同帧内按顺序抢占）
    let slot = -1;
    if (def.facility !== null) {
      const f = this.facilityMap.get(def.facility);
      if (f) slot = f.reserveRandom(this.rng);
      // 极端竞态：刚被别人占满 → 本次放弃，短间隔后重估
      if (slot < 0) {
        npc.nextDecideAt = this.clockMin + this.rng.range(5, 15);
        return;
      }
    }

    // 扣费（门控已保证付得起，这里是防御性钳制）
    npc.money -= def.cost;

    // 设定走向
    if (def.facility !== null) {
      const pos = this.facilityMap.get(def.facility)!.slotPosition(slot);
      npc.setTarget(pos.x, pos.y);
    } else {
      npc.setTarget(
        this.rng.range(WANDER_RECT.x, WANDER_RECT.x + WANDER_RECT.w),
        this.rng.range(WANDER_RECT.y, WANDER_RECT.y + WANDER_RECT.h),
      );
    }
    npc.beginAction(ai, def.facility, slot);
    // 目标点恰好在脚下（罕见）：直接进入执行，避免卡在 moving
    if (npc.hasArrived()) npc.startActing();
    // 移动/行动期间不再重估；下一次重估放在行动结束之后安排
    npc.nextDecideAt = this.clockMin + REDECIDE_INTERVAL + this.rng.range(-30, 30);

    this.writeLog(npc, def.id, def.name);
  }

  /** 写一条决策日志（仅被追踪 NPC 落盘） */
  private writeLog(npc: Npc, actionId: ActionId, actionName: string): void {
    if (!npc.loggingEnabled) return;
    const def = ACTION_DEFS[npc.decidedActionIndex];
    const entry: DecisionLogEntry = {
      day: this.day,
      clock: Math.round(this.clockMin),
      action: actionId,
      actionName,
      score: npc.decidedScore,
      reason: npc.decidedReason as DecisionReason,
      hunger: npc.needs.hunger,
      fatigue: npc.needs.fatigue,
      stress: npc.needs.stress,
      horseHunger: npc.needs.horseHunger,
      money: npc.money,
      affordable: npc.money >= 0,
      slotsFree: def.facility
        ? this.facilityMap.get(def.facility)?.slotsFree ?? 0
        : 1,
    };
    npc.appendLog(entry);
  }

  /** 需求随游戏分钟增长：基础速率 × 时辰曲线倍率 */
  private growNeeds(dtMin: number): void {
    const growthCurves = NEED_CONFIG.map((cfg) => this.curves.get(cfg.growthCurveId));
    const speedCurve = this.curves.get('speed.hunger');

    for (const npc of this.npcs) {
      const n = npc.needs;
      for (let k = 0; k < NEED_CONFIG.length; k++) {
        const cfg = NEED_CONFIG[k];
        const mult = growthCurves[k].eval(this.clockMin);
        n[cfg.id] = clampNeed(n[cfg.id] + cfg.baseRate * mult * dtMin);
      }
      // 饥饿影响移速（美术要求：快饿晕明显变慢）
      npc.speed = 60 * speedCurve.eval(n.hunger);
    }
  }

  /** 位置推进：直线走向目标，抵达后停下等行动计时 */
  private updateMovement(realDt: number): void {
    for (const npc of this.npcs) {
      if (npc.mode !== 'moving') continue;
      const dx = npc.targetX - npc.x;
      const dy = npc.targetY - npc.y;
      const dist = Math.hypot(dx, dy);
      const step = npc.speed * realDt;
      if (dist <= step || npc.hasArrived()) {
        npc.x = npc.targetX;
        npc.y = npc.targetY;
        // 抵达：从赶路切到执行，行动计时开始
        npc.startActing();
      } else {
        npc.x += (dx / dist) * step;
        npc.y += (dy / dist) * step;
      }
    }
  }

  /** 行动计时：抵达目标后才开始扣行动时间，结束后释放槽位并立刻重估 */
  private updateActions(dtMin: number): void {
    for (const npc of this.npcs) {
      if (npc.mode !== 'acting') continue;
      if (!npc.hasArrived()) continue; // 还在赶路，不计时

      npc.actionRemaining -= dtMin;
      if (npc.actionRemaining > 0) continue;

      // —— 行动完成：结算效果、释放槽位 ——
      const def = ACTION_DEFS[npc.currentActionIndex];
      const delta: Needs = { ...def.effects };
      // 住店期间疲劳仍在自然涨，效果在结束时一次性反向结算
      npc.applyNeeds(delta);
      if (npc.facilityId !== null && npc.slot >= 0) {
        this.facilityMap.get(npc.facilityId)?.release(npc.slot);
      }
      npc.endAction();
      // 立刻参与下一帧决策（nextDecideAt 设为过去）
      npc.nextDecideAt = this.clockMin - 1;
    }
  }

  /** 曲线被策划改动后：让所有空闲 NPC 尽快按新曲线重估 */
  invalidateDecisions(): void {
    for (const npc of this.npcs) {
      if (npc.mode === 'idle') npc.nextDecideAt = this.clockMin - 1;
    }
  }

  /** 按屏幕坐标找 NPC（点击拾取，返回最上层的一个） */
  pickNpc(px: number, py: number, radius = 10): Npc | null {
    let hit: Npc | null = null;
    let bestD = radius * radius;
    for (const npc of this.npcs) {
      const dx = npc.x - px;
      const dy = npc.y - py;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        hit = npc;
      }
    }
    return hit;
  }
}
