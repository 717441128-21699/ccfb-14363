/**
 * 全局共享类型定义
 *
 * 设计约定：
 * - 饥饿/疲劳/压力(=100-心情)/马饥饿 都是 0~100 的「压力值」，越高越迫切
 * - 钱是独立维度（可负可超百），不参与 0~100 归一化
 * - 所有曲线都用分段线性函数（见 curves.ts），策划可在调试页拖拽修改
 */

/** 四类需求（压力值口径，0 轻松 ~ 100 迫切） */
export type NeedId = 'hunger' | 'fatigue' | 'stress' | 'horseHunger';

/** 七个候选行动 */
export type ActionId =
  | 'eat'          // 吃饭
  | 'tea'          // 喝茶
  | 'feedHorse'    // 喂马
  | 'lodging'      // 住店
  | 'gossip'       // 打听消息
  | 'argue'        // 吵架
  | 'wander';      // 闲逛（兜底，保证 NPC 不会变摆设）

/** 行动进入下一个状态的原因码，写进决策记录，供调试页解释「为什么选它」 */
export type DecisionReason =
  | 'highest'      // 综合得分最高
  | 'fallback'     // 其它行动全被门控/分数过低，兜底闲逛
  | 'blocked'      // 被硬门控挡住（没钱/设施满），仅供打分明细展示
  | 'allGated'     // 所有非兜底行动被门控
  | 'tieBreak';    // 并列时按性格倾向打破

/** 需求向量，SoA（结构数组）友好 */
export interface Needs {
  /** 饥饿 0~100 */
  hunger: number;
  /** 疲劳 0~100 */
  fatigue: number;
  /** 压力 0~100（心情 = 100 - 压力） */
  stress: number;
  /** 马的饥饿 0~100 */
  horseHunger: number;
}

/** 性格倾向，每个维度 0~1，对行动权重做乘性修正 */
export interface Traits {
  /** 节俭：越高越舍不得花钱 */
  frugal: number;
  /** 好斗：吵架倾向 */
  aggressive: number;
  /** 健谈：打听消息倾向 */
  sociable: number;
  /** 尽责：对马的照顾倾向 */
  dutiful: number;
}

/** 单个考虑项（Consideration）的定义：从 NPC 上下文取输入，再过一条响应曲线 */
export interface ConsiderationDef {
  /** 考虑项名称，调试页直接展示 */
  label: string;
  /** 从当前上下文取原始输入（一般是 0~100 的压力值，或 0~1 的门控量） */
  input: (ctx: ActionContext) => number;
  /** 曲线 id，查 CurveLibrary 得到分段线性曲线，把输入映射为 0~1 效用 */
  curveId: string;
  /** 权重，默认 1；最终分 = 各考虑项加权平均 */
  weight: number;
  /**
   * 纯门控项：只执行 gate 拦截，不参与效用加权平均。
   * 钱、空位这类「约束」而不是「动机」的考虑项应置 true，
   * 否则恒为 1 的门控分会稀释真实需求分，导致低需求时行动压不住兜底。
   */
  gateOnly?: boolean;
  /** 硬门控：返回 false 时该行动直接 0 分（并记录 blocked 原因），默认无门控 */
  gate?: (ctx: ActionContext) => boolean;
  /** 门控被挡时给调试页看的解释文案 */
  gateLabel?: string;
}

/** 行动定义 */
export interface ActionDef {
  id: ActionId;
  /** 中文名（气泡 / 调试页用） */
  name: string;
  /** 气泡里的 emoji 图标 */
  icon: string;
  /** 使用到的设施 id；无设施（闲逛/吵架街头）为 null */
  facility: string | null;
  /** 行动持续的游戏分钟数 */
  durationMin: number;
  /** 花费铜钱（在行动开始时扣除） */
  cost: number;
  /** 行动结束后对需求的改变量（压力值口径，负数=缓解） */
  effects: Needs;
  /** 性格亲和度修正：返回 0.8~1.2 左右的乘子，用于并列打破与个性化 */
  affinity: (traits: Traits) => number;
  /** 组成该行动效用分的考虑项 */
  considerations: ConsiderationDef[];
}

/** 打分时传给考虑项的运行时上下文（只读快照，热路径中复用同一对象，零分配） */
export interface ActionContext {
  npc: unknown;
  needs: Needs;
  /** 钱（铜钱），独立维度 */
  money: number;
  /** 目标设施当前空闲槽位数（无设施行动恒为 1） */
  slotsFree: number;
  /** 目标设施总槽位数（无设施行动恒为 1） */
  slotsTotal: number;
  /** 游戏内时间 0~1440 分钟 */
  clockMin: number;
}

/** 一条决策记录（导出 CSV/JSON 的最小单元） */
export interface DecisionLogEntry {
  /** 第几天（从 1 开始） */
  day: number;
  /** 游戏内分钟 0~1439 */
  clock: number;
  /** 行动 id */
  action: ActionId;
  /** 行动中文名 */
  actionName: string;
  /** 最终得分 */
  score: number;
  /** 入选原因 */
  reason: DecisionReason;
  hunger: number;
  fatigue: number;
  stress: number;
  horseHunger: number;
  money: number;
  /** 当时身上的钱是否够付这次行动 */
  affordable: boolean;
  /** 设施空闲槽位 */
  slotsFree: number;
}

/** NPC 可见状态机 */
export type NpcMode = 'idle' | 'moving' | 'acting';
