/**
 * 候选行动定义
 *
 * 每个行动由若干「考虑项」组成：
 *   原始输入 → 响应曲线 → 0~1 效用 → 加权平均 → 性格亲和度乘子 → 最终分
 * 硬门控（付不起钱 / 设施满员）直接归零，并在调试页标明 blocked。
 *
 * 行动效果（effects）是压力值口径的改变量：负数 = 缓解该需求。
 */

import type { ActionDef, ActionContext, Traits, NeedId } from './types';

/** 钱够不够付（门控用） */
const canAfford = (cost: number) => (ctx: ActionContext): boolean => ctx.money >= cost;

/** 设施还有空槽（门控用）；无设施行动不挂这个门控 */
const hasSlot = (ctx: ActionContext): boolean => ctx.slotsFree > 0;

/** 取压力值的小工具 */
const need = (id: NeedId) => (ctx: ActionContext): number => ctx.needs[id];

/**
 * 付费行动通用的「钱」考虑项：
 * 输入恒为 1、曲线恒输出 1，只承载硬门控（付不起直接归零并给出解释）。
 * 钱不参与效用加权——否则低需求时光「有钱」就会白送分数，压不住闲逛兜底；
 * 消费意愿的差异化交给性格亲和度（frugal）处理。
 */
const moneyConsideration = (cost: number) => ({
  label: '手头铜钱',
  input: (): number => 1,
  curveId: 'resp.constantOne',
  weight: 0.5,
  gateOnly: true,
  gate: canAfford(cost),
  gateLabel: `铜钱不足（需 ${cost} 文）`,
});

/**
 * 设施类行动通用的空位考虑项：
 * 硬门控保证满员直接归零；软分只在「快满」时才明显下降，
 * 全空时接近 1 但不额外注水（可用性是约束，不是需求驱动）。
 */
const slotConsideration = {
  label: '设施空位',
  input: (ctx: ActionContext): number =>
    ctx.slotsTotal > 0 ? ctx.slotsFree / ctx.slotsTotal : 1,
  curveId: 'resp.availability',
  weight: 0.6,
  gateOnly: true,
  gate: hasSlot,
  gateLabel: '设施已满，需要排队',
};

export const ACTION_DEFS: ActionDef[] = [
  {
    id: 'eat',
    name: '吃饭',
    icon: '🍚',
    facility: 'tavern',
    durationMin: 45,
    cost: 20,
    effects: { hunger: -55, fatigue: -3, stress: -8, horseHunger: 0 },
    affinity: (t: Traits) => 1 + (1 - t.frugal) * 0.15,
    considerations: [
      { label: '饥饿程度', input: need('hunger'), curveId: 'eat.hunger', weight: 1.4 },
      moneyConsideration(20),
      slotConsideration,
    ],
  },
  {
    id: 'tea',
    name: '喝茶',
    icon: '🍵',
    facility: 'teahouse',
    durationMin: 30,
    cost: 8,
    effects: { hunger: -10, fatigue: -5, stress: -22, horseHunger: 0 },
    affinity: (t: Traits) => 1 + t.sociable * 0.1,
    considerations: [
      { label: '压力程度', input: need('stress'), curveId: 'tea.stress', weight: 1.1 },
      { label: '饥饿(轻度)', input: need('hunger'), curveId: 'tea.hunger', weight: 0.4 },
      moneyConsideration(8),
      slotConsideration,
    ],
  },
  {
    id: 'feedHorse',
    name: '喂马',
    icon: '🌾',
    facility: 'stable',
    durationMin: 20,
    cost: 12,
    effects: { hunger: 0, fatigue: 0, stress: 0, horseHunger: -65 },
    affinity: (t: Traits) => 1 + t.dutiful * 0.25,
    considerations: [
      { label: '马的饥饿', input: need('horseHunger'), curveId: 'feed.horse', weight: 1.3 },
      moneyConsideration(12),
      slotConsideration,
    ],
  },
  {
    id: 'lodging',
    name: '住店',
    icon: '🛏️',
    facility: 'inn',
    durationMin: 360,
    cost: 50,
    effects: { hunger: 5, fatigue: -70, stress: -18, horseHunger: 0 },
    affinity: (t: Traits) => 1 + (1 - t.frugal) * 0.1,
    considerations: [
      { label: '疲劳程度', input: need('fatigue'), curveId: 'lodging.fatigue', weight: 1.5 },
      moneyConsideration(50),
      slotConsideration,
    ],
  },
  {
    id: 'gossip',
    name: '打听消息',
    icon: '💬',
    facility: 'teahouse',
    durationMin: 25,
    cost: 2,
    effects: { hunger: 0, fatigue: 0, stress: -14, horseHunger: 0 },
    affinity: (t: Traits) => 1 + t.sociable * 0.3,
    considerations: [
      { label: '压力程度', input: need('stress'), curveId: 'gossip.stress', weight: 0.9 },
      moneyConsideration(2),
      slotConsideration,
    ],
  },
  {
    id: 'argue',
    name: '吵架',
    icon: '😡',
    facility: 'argueSpot',
    durationMin: 15,
    cost: 0,
    effects: { hunger: 0, fatigue: 2, stress: -20, horseHunger: 0 },
    affinity: (t: Traits) => 1 + t.aggressive * 0.35 - (1 - t.aggressive) * 0.15,
    considerations: [
      { label: '压力程度', input: need('stress'), curveId: 'argue.stress', weight: 1.2 },
      // 街头吵架点也是有限容量
      slotConsideration,
    ],
  },
  {
    id: 'wander',
    name: '闲逛',
    icon: '🚶',
    facility: null,
    durationMin: 20,
    cost: 0,
    effects: { hunger: 2, fatigue: 1, stress: -4, horseHunger: 0 },
    // 兜底行动：性格影响很小，保证人人都可能闲逛
    affinity: () => 1,
    considerations: [
      { label: '压力(兜底)', input: need('stress'), curveId: 'wander.stress', weight: 1 },
    ],
  },
];

/** id → 定义 的快速查表（热路径用） */
export const ACTION_BY_ID: Readonly<Record<string, ActionDef>> = Object.fromEntries(
  ACTION_DEFS.map((a) => [a.id, a]),
);

/** 单个行动最多的考虑项数量，决定 NPC 预分配打分数组的长度 */
export const MAX_CONSIDERATIONS = ACTION_DEFS.reduce(
  (m, a) => Math.max(m, a.considerations.length),
  0,
);
