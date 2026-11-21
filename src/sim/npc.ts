/**
 * 旅客 NPC
 *
 * 数据布局刻意「扁平 + 预分配」：
 * - 打分明细是 TypedArray，决策热路径零内存分配，2000 人同时在线不触发 GC 抖动
 * - 决策记录只对「当前被调试页选中的 NPC」开启环形缓冲（见 world.ts），
 *   避免 2000 × 300 条记录的常驻内存开销
 */

import { ACTION_DEFS, MAX_CONSIDERATIONS } from '../core/actions';
import type {
  ActionContext,
  DecisionReason,
  Needs,
  NpcMode,
  Traits,
} from '../core/types';
import type { ScorerNpc } from '../core/utility';
import type { DecisionLogEntry } from '../core/types';
import { clampNeed } from '../core/curves';
import { makeName, type Rng } from './rng';

const N_ACTIONS = ACTION_DEFS.length;

export class Npc implements ScorerNpc {
  readonly id: number;
  name: string;

  // —— 位置与移动 ——
  x: number;
  y: number;
  private tx: number;
  private ty: number;
  /** 当前移动速度（像素/秒），受饥饿曲线影响，每帧由 world 刷新 */
  speed = 60;

  // —— 状态机 ——
  mode: NpcMode = 'idle';
  /** 当前执行的行动下标（ACTION_DEFS） */
  currentActionIndex = -1;
  /** 行动剩余游戏分钟 */
  actionRemaining = 0;
  /** 占用的设施与槽位（-1 表示无） */
  facilityId: string | null = null;
  slot = -1;

  // —— 需求与性格 ——
  readonly needs: Needs;
  money: number;
  readonly traits: Traits;

  // —— 决策调度（错峰用）——
  nextDecideAt: number;

  // —— 评分器预分配输出 ——
  readonly actionScore = new Float32Array(N_ACTIONS);
  readonly consInput = new Float32Array(N_ACTIONS * MAX_CONSIDERATIONS);
  readonly consScore = new Float32Array(N_ACTIONS * MAX_CONSIDERATIONS);
  readonly consGated = new Uint8Array(N_ACTIONS * MAX_CONSIDERATIONS);
  readonly consGateMsg: string[] = new Array(N_ACTIONS * MAX_CONSIDERATIONS).fill('');
  decidedActionIndex = -1;
  decidedReason: DecisionReason = 'highest';
  decidedScore = 0;

  /** 评分器复用的上下文对象（热路径零分配的关键），构造函数里初始化 */
  readonly ctx: ActionContext;

  // —— 决策记录环形缓冲（仅被追踪的 NPC 使用）——
  readonly logCapacity: number;
  readonly log: DecisionLogEntry[] = [];
  private logHead = 0;
  loggingEnabled = false;

  constructor(id: number, rng: Rng, spawn: { x: number; y: number }, clockMin: number) {
    this.id = id;
    this.name = makeName(rng);
    this.x = spawn.x;
    this.y = spawn.y;
    this.tx = spawn.x;
    this.ty = spawn.y;

    this.needs = {
      hunger: rng.range(15, 70),
      fatigue: rng.range(10, 65),
      stress: rng.range(10, 60),
      horseHunger: rng.range(10, 60),
    };
    this.money = rng.int(40, 260);
    this.traits = {
      frugal: rng.next(),
      aggressive: rng.next(),
      sociable: rng.next(),
      dutiful: rng.next(),
    };

    // 错峰：首次决策时间均匀打散在开局的 100 个游戏分钟内
    this.nextDecideAt = clockMin + rng.range(0, 100);
    this.logCapacity = 300;

    // needs 就绪后再建复用上下文，整条决策链路共享这一个对象
    this.ctx = {
      npc: this,
      needs: this.needs,
      money: 0,
      slotsFree: 1,
      slotsTotal: 1,
      clockMin: 0,
    };
  }

  /** 设置移动目标点 */
  setTarget(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
    this.mode = 'moving';
  }

  get targetX(): number {
    return this.tx;
  }

  get targetY(): number {
    return this.ty;
  }

  /** 是否抵达目标（像素距离） */
  hasArrived(epsilon = 4): boolean {
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    return dx * dx + dy * dy <= epsilon * epsilon;
  }

  /** 开始执行行动：先赶路（moving），抵达后由 world 切到 acting */
  beginAction(actionIndex: number, facilityId: string | null, slot: number): void {
    this.currentActionIndex = actionIndex;
    this.facilityId = facilityId;
    this.slot = slot;
    this.actionRemaining = ACTION_DEFS[actionIndex].durationMin;
    this.mode = 'moving';
  }

  /** 抵达目标，开始结算行动时间 */
  startActing(): void {
    this.mode = 'acting';
  }

  /** 行动结束/中断，回到待决策状态 */
  endAction(): void {
    this.currentActionIndex = -1;
    this.facilityId = null;
    this.slot = -1;
    this.actionRemaining = 0;
    this.mode = 'idle';
  }

  /** 应用需求增量并钳制（钱不钳制） */
  applyNeeds(delta: Needs): void {
    const n = this.needs;
    n.hunger = clampNeed(n.hunger + delta.hunger);
    n.fatigue = clampNeed(n.fatigue + delta.fatigue);
    n.stress = clampNeed(n.stress + delta.stress);
    n.horseHunger = clampNeed(n.horseHunger + delta.horseHunger);
  }

  /** 追加一条决策记录（环形覆盖最旧的） */
  appendLog(entry: DecisionLogEntry): void {
    if (!this.loggingEnabled) return;
    if (this.log.length < this.logCapacity) {
      this.log.push(entry);
    } else {
      this.log[this.logHead] = entry;
      this.logHead = (this.logHead + 1) % this.logCapacity;
    }
  }

  /** 按时间顺序导出记录（环形缓冲还原顺序） */
  exportLog(): DecisionLogEntry[] {
    if (this.log.length < this.logCapacity) return this.log.slice();
    const out: DecisionLogEntry[] = [];
    for (let k = 0; k < this.logCapacity; k++) {
      out.push(this.log[(this.logHead + k) % this.logCapacity]);
    }
    return out;
  }

  /** 最近一条决策记录（无记录时 undefined） */
  lastLog(): DecisionLogEntry | undefined {
    if (this.log.length === 0) return undefined;
    if (this.log.length < this.logCapacity) return this.log[this.log.length - 1];
    return this.log[(this.logHead - 1 + this.logCapacity) % this.logCapacity];
  }

  clearLog(): void {
    this.log.length = 0;
    this.logHead = 0;
  }
}
