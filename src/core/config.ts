/**
 * 策划配置层：曲线库 + 需求增长参数
 *
 * 曲线分三类：
 * 1. resp.*  响应曲线：考虑项原始输入 → 0~1 效用
 * 2. growth.* 时辰曲线：游戏分钟 0~1440 → 该分钟需求增长倍率
 * 3. speed.hunger 饥饿 → 移动速度倍率（美术要求：快饿晕时明显变慢）
 *
 * 调试页所有拖拽修改都落在这个库的同一份实例上，即时生效；
 * 可导出/导入 JSON，也可一键恢复默认。
 */

import { PiecewiseCurve, type CurvePoint } from './curves';
import type { NeedId } from './types';

/** 每种需求的基础增长参数（每游戏分钟），实际增量 = baseRate × 时辰曲线倍率 */
export interface NeedConfig {
  id: NeedId;
  name: string;
  /** 每游戏分钟基础增长量（时辰倍率≈1 时） */
  baseRate: number;
  /** 时辰曲线 id */
  growthCurveId: string;
}

export const NEED_CONFIG: NeedConfig[] = [
  { id: 'hunger',      name: '饥饿',   baseRate: 0.060, growthCurveId: 'growth.hunger' },
  { id: 'fatigue',     name: '疲劳',   baseRate: 0.050, growthCurveId: 'growth.fatigue' },
  { id: 'stress',      name: '压力',   baseRate: 0.025, growthCurveId: 'growth.stress' },
  { id: 'horseHunger', name: '马饥饿', baseRate: 0.035, growthCurveId: 'growth.horseHunger' },
];

/** 响应曲线输入域：压力类 0~100；钱 0~200 文；可用性 0~1 */
const NEED_DOMAIN: [number, number] = [0, 100];
const MONEY_DOMAIN: [number, number] = [0, 200];
const UNIT_DOMAIN: [number, number] = [0, 1];
const CLOCK_DOMAIN: [number, number] = [0, 1440];
const UTIL_RANGE: [number, number] = [0, 1];

function resp(label: string, points: CurvePoint[], domain = NEED_DOMAIN): PiecewiseCurve {
  return new PiecewiseCurve(label, points, domain, UTIL_RANGE);
}

/** 构造一套默认曲线（深拷贝，保证「恢复默认」与初始状态严格一致） */
export function createDefaultCurves(): Record<string, PiecewiseCurve> {
  const c: Record<string, PiecewiseCurve> = {};

  // ---------- 通用门控曲线 ----------
  // 门控专用恒通曲线：考虑项只负责跑硬门控，效用恒为 1，不给加权平均注水
  c['resp.constantOne'] = resp('门控·恒通', [
    { x: 0, y: 1 }, { x: 1, y: 1 },
  ], UNIT_DOMAIN);

  // 手头铜钱的参考曲线（保留给策划查看/自定义消费意愿；默认行动定义用恒通门控）
  c['resp.money'] = resp('钱→消费意愿(参考)', [
    { x: 0, y: 0 }, { x: 15, y: 0.3 }, { x: 60, y: 0.85 }, { x: 200, y: 1 },
  ], MONEY_DOMAIN);

  // 设施空位比例 → 可用性效用：全空≈1 不注水，只剩 20% 时才明显降权，0 时趋近 0
  c['resp.availability'] = resp('空位→可用性', [
    { x: 0, y: 0 }, { x: 0.2, y: 0.5 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 },
  ], UNIT_DOMAIN);

  // ---------- 吃饭 ----------
  c['eat.hunger'] = resp('吃饭·饥饿响应', [
    { x: 0, y: 0.02 }, { x: 40, y: 0.15 }, { x: 70, y: 0.6 }, { x: 100, y: 1 },
  ]);

  // ---------- 喝茶（解饿很弱，主要解压） ----------
  c['tea.hunger'] = resp('喝茶·饥饿响应(弱)', [
    { x: 0, y: 0.05 }, { x: 60, y: 0.3 }, { x: 100, y: 0.55 },
  ]);
  // ---------- 喝茶（宽甜区：55 起爬升，70+ 高位并保持到满压；温和派的解压首选） ----------
  c['tea.stress'] = resp('喝茶·压力响应', [
    { x: 0, y: 0.03 }, { x: 40, y: 0.2 }, { x: 55, y: 0.55 }, { x: 70, y: 0.85 }, { x: 100, y: 0.97 },
  ]);

  // ---------- 喂马 ----------
  c['feed.horse'] = resp('喂马·马饥饿响应', [
    { x: 0, y: 0.02 }, { x: 40, y: 0.2 }, { x: 75, y: 0.7 }, { x: 100, y: 1 },
  ]);

  // ---------- 住店 ----------
  c['lodging.fatigue'] = resp('住店·疲劳响应', [
    { x: 0, y: 0.02 }, { x: 40, y: 0.2 }, { x: 70, y: 0.65 }, { x: 100, y: 1 },
  ]);

  // ---------- 打听消息（廉价社交：低中压力（<55）的首选，55 后快速让位喝茶） ----------
  c['gossip.stress'] = resp('打听·压力响应', [
    { x: 0, y: 0.02 }, { x: 25, y: 0.5 }, { x: 50, y: 0.66 }, { x: 65, y: 0.45 }, { x: 100, y: 0.3 },
  ]);

  // ---------- 吵架（免费但门槛高：85+ 才进入高位，且亲和度对性格极敏感，温和派不会选） ----------
  c['argue.stress'] = resp('吵架·压力响应', [
    { x: 0, y: 0.02 }, { x: 75, y: 0.25 }, { x: 90, y: 0.7 }, { x: 100, y: 0.95 },
  ]);

  // ---------- 闲逛（兜底，曲线整体很低，只在别的行动都不划算时胜出） ----------
  c['wander.stress'] = resp('闲逛·压力响应(兜底)', [
    { x: 0, y: 0.1 }, { x: 100, y: 0.35 },
  ]);

  // ---------- 时辰曲线：需求随游戏时间的增长倍率 ----------
  c['growth.hunger'] = new PiecewiseCurve('饥饿·时辰倍率', [
    { x: 0, y: 0.7 }, { x: 360, y: 0.6 }, { x: 420, y: 1.0 }, { x: 540, y: 0.7 },
    { x: 720, y: 1.2 }, { x: 840, y: 0.7 }, { x: 1080, y: 1.3 }, { x: 1200, y: 0.7 },
    { x: 1440, y: 0.8 },
  ], CLOCK_DOMAIN, [0.4, 1.6]);

  c['growth.fatigue'] = new PiecewiseCurve('疲劳·时辰倍率', [
    { x: 0, y: 1.2 }, { x: 360, y: 0.9 }, { x: 720, y: 1.0 },
    { x: 1080, y: 1.2 }, { x: 1320, y: 1.5 }, { x: 1440, y: 1.4 },
  ], CLOCK_DOMAIN, [0.5, 1.8]);

  c['growth.stress'] = new PiecewiseCurve('压力·时辰倍率', [
    { x: 0, y: 0.8 }, { x: 720, y: 1.0 }, { x: 1200, y: 1.3 }, { x: 1440, y: 1.1 },
  ], CLOCK_DOMAIN, [0.5, 1.6]);

  c['growth.horseHunger'] = new PiecewiseCurve('马饥饿·时辰倍率', [
    { x: 0, y: 0.9 }, { x: 1440, y: 1.1 },
  ], CLOCK_DOMAIN, [0.5, 1.5]);

  // ---------- 饥饿→移速倍率：快饿晕时走路明显变慢 ----------
  c['speed.hunger'] = new PiecewiseCurve('饥饿→移速倍率', [
    { x: 0, y: 1.0 }, { x: 50, y: 0.95 }, { x: 75, y: 0.75 },
    { x: 95, y: 0.5 }, { x: 100, y: 0.45 },
  ], NEED_DOMAIN, [0.3, 1.2]);

  return c;
}

/** 曲线库单例包装：查询、持久化、重置 */
export class CurveLibrary {
  private curves: Record<string, PiecewiseCurve>;

  constructor() {
    this.curves = createDefaultCurves();
  }

  get(id: string): PiecewiseCurve {
    const curve = this.curves[id];
    if (!curve) throw new Error(`未知曲线 id: ${id}`);
    return curve;
  }

  /** 编辑器与下拉框用 */
  ids(): string[] {
    return Object.keys(this.curves).sort();
  }

  /** 序列化为可存档/导出的纯数据 */
  serialize(): Record<string, CurvePoint[]> {
    const out: Record<string, CurvePoint[]> = {};
    for (const id of Object.keys(this.curves)) out[id] = this.curves[id].toJSON();
    return out;
  }

  /** 从存档数据恢复（只改控制点，保留域定义） */
  load(data: Record<string, CurvePoint[]>): void {
    for (const id of Object.keys(data)) {
      if (!this.curves[id] || !Array.isArray(data[id]) || data[id].length < 2) continue;
      const target = this.curves[id];
      target.points.length = 0;
      for (const p of data[id]) {
        target.points.push({
          x: Math.min(Math.max(p.x, target.domainMin), target.domainMax),
          y: Math.min(Math.max(p.y, target.rangeMin), target.rangeMax),
        });
      }
      target.points.sort((a, b) => a.x - b.x);
    }
  }

  /** 恢复出厂默认 */
  reset(): void {
    this.curves = createDefaultCurves();
  }
}
