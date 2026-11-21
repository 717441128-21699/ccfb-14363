/**
 * Utility AI 评分器（热路径）
 *
 * 性能约定：
 * - 决策不创建任何对象/数组：打分明细写进 NPC 构造时预分配的 TypedArray，
 *   上下文 ctx 也是 NPC 持有的同一个对象，每次只改字段
 * - 曲线求值是二分查找，7 个行动 × 最多 4 个考虑项 ≈ 20 次求值/决策
 * - 2000 NPC 的决策被 world 层时间分片，单帧只处理到期的一小批
 *
 * 决策规则：
 *   考虑项输入 → 响应曲线 → 效用(0~1) → 加权平均 → 性格乘子 → 最终分
 *   硬门控失败的行动最终分归零（明细照常计算并标注 blocked，方便调试）
 *   选非兜底行动中的最高分；全部低于 FALLBACK_THRESHOLD 或被门控时选闲逛
 */

import { ACTION_DEFS, MAX_CONSIDERATIONS } from './actions';
import type { CurveLibrary } from './config';
import type {
  ActionContext,
  DecisionReason,
  Needs,
  Traits,
} from './types';

/** 非兜底行动最高有效分低于该值时，闲逛兜底生效 */
export const FALLBACK_THRESHOLD = 0.45;

/** 评分器视角的设施（结构类型，避免与 sim 层循环依赖） */
export interface ScorerFacility {
  readonly slotsFree: number;
  readonly slotsTotal: number;
}

/** 评分器视角的世界 */
export interface ScorerWorld {
  readonly curves: CurveLibrary;
  readonly facilityMap: ReadonlyMap<string, ScorerFacility>;
  readonly clockMin: number;
}

/** 评分器视角的 NPC：携带预分配输出缓冲 */
export interface ScorerNpc {
  readonly needs: Needs;
  money: number;
  readonly traits: Traits;

  /** 每个行动的最终分，长度 = ACTION_DEFS.length */
  readonly actionScore: Float32Array;
  /** 考虑项原始输入 / 曲线输出 / 门控标记，按 action * MAX_CONSIDERATIONS + j 索引 */
  readonly consInput: Float32Array;
  readonly consScore: Float32Array;
  readonly consGated: Uint8Array;
  /** 门控解释文案，未门控位置为空串 */
  readonly consGateMsg: string[];

  /** 本次决策结果（写回字段，不 new 对象） */
  decidedActionIndex: number;
  decidedReason: DecisionReason;
  decidedScore: number;
}

const N_ACTIONS = ACTION_DEFS.length;
const WANDER_INDEX = ACTION_DEFS.findIndex((d) => d.id === 'wander');

/**
 * 对一个 NPC 执行完整决策，结果写回 npc 的预分配字段。
 * 世界循环按错峰时间表调用本函数，保证每帧只决策到期的一小批。
 */
export function decide(world: ScorerWorld, npc: ScorerNpc, ctx: ActionContext): void {
  const curves = world.curves;
  const facilities = world.facilityMap;

  let bestIndex = -1;
  let bestScore = -1;
  let allNonWanderGated = true;
  const topTwo: number[] = [-1, -1]; // 并列检测：最高的两个非兜底行动下标

  for (let ai = 0; ai < N_ACTIONS; ai++) {
    const def = ACTION_DEFS[ai];
    const base = ai * MAX_CONSIDERATIONS;

    // 填充上下文（复用同一对象，零分配）
    ctx.needs = npc.needs;
    ctx.money = npc.money;
    if (def.facility === null) {
      ctx.slotsFree = 1;
      ctx.slotsTotal = 1;
    } else {
      const f = facilities.get(def.facility);
      ctx.slotsFree = f ? f.slotsFree : 0;
      ctx.slotsTotal = f ? f.slotsTotal : 0;
    }
    ctx.clockMin = world.clockMin;

    // 1) 逐个考虑项：输入 → 曲线效用；同时跑硬门控
    let weightedSum = 0;
    let weightTotal = 0;
    let gated = false;
    let gateMsg = '';
    const n = def.considerations.length;

    for (let j = 0; j < n; j++) {
      const cd = def.considerations[j];
      const raw = cd.input(ctx);
      const util = curves.get(cd.curveId).eval(raw);
      const idx = base + j;
      npc.consInput[idx] = raw;
      npc.consScore[idx] = util;
      // 纯门控项只做拦截，不往加权平均里注水
      if (!cd.gateOnly) {
        weightedSum += util * cd.weight;
        weightTotal += cd.weight;
      }

      if (cd.gate && !cd.gate(ctx)) {
        gated = true;
        gateMsg = cd.gateLabel ?? '门控未通过';
        npc.consGated[idx] = 1;
        npc.consGateMsg[idx] = gateMsg;
      } else {
        npc.consGated[idx] = 0;
        npc.consGateMsg[idx] = '';
      }
    }

    // 2) 加权平均 × 性格亲和度
    let finalScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
    finalScore *= def.affinity(npc.traits);
    if (finalScore > 1) finalScore = 1;
    if (gated) finalScore = 0;
    npc.actionScore[ai] = finalScore;

    if (def.id === 'wander') continue; // 兜底行动不参与正常最高分评选

    if (!gated) {
      allNonWanderGated = false;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestIndex = ai;
        topTwo[1] = topTwo[0];
        topTwo[0] = ai;
      }
    }
  }

  // 3) 兜底规则与原因判定
  let reason: DecisionReason;
  if (allNonWanderGated) {
    // 所有正经行动都被门控（全员破产/满员的极端情况）
    bestIndex = WANDER_INDEX;
    reason = 'allGated';
  } else if (bestScore < FALLBACK_THRESHOLD) {
    // 没有任何行动足够迫切 → 闲逛，避免 NPC 站着不动
    bestIndex = WANDER_INDEX;
    reason = 'fallback';
  } else if (
    topTwo[1] >= 0 &&
    npc.actionScore[topTwo[1]] === npc.actionScore[topTwo[0]]
  ) {
    reason = 'tieBreak';
  } else {
    reason = 'highest';
  }

  npc.decidedActionIndex = bestIndex;
  npc.decidedReason = reason;
  npc.decidedScore = npc.actionScore[bestIndex];
}
