/**
 * 分段线性曲线库
 *
 * 策划配曲线的统一载体：一组有序控制点 (x, y)，相邻点之间线性插值。
 * - 响应曲线：x = 考虑项原始输入（0~100 或 0~1），y = 效用 0~1
 * - 时辰曲线：x = 游戏内分钟（0~1440），y = 需求增长倍率
 * - 移速曲线：x = 饥饿 0~100，y = 速度倍率
 *
 * 求值是 O(log n) 的二分查找，控制点通常只有 2~4 个，实测几乎免费。
 * 曲线对象在热路径中只读取不分配，调试页拖拽时走 replacePoint 原地改。
 */

export interface CurvePoint {
  x: number;
  y: number;
}

export class PiecewiseCurve {
  /** 控制点，按 x 升序 */
  readonly points: CurvePoint[];
  /** 输入域下界（曲线编辑器横轴起点） */
  readonly domainMin: number;
  /** 输入域上界（曲线编辑器横轴终点） */
  readonly domainMax: number;
  /** 值域下界 */
  readonly rangeMin: number;
  /** 值域上界 */
  readonly rangeMax: number;
  /** 调试页展示用的中文名 */
  label: string;

  constructor(
    label: string,
    points: CurvePoint[],
    domain: [number, number],
    range: [number, number],
  ) {
    if (points.length < 2) throw new Error(`曲线 ${label} 至少需要 2 个控制点`);
    this.label = label;
    this.points = points.map((p) => ({ ...p }));
    this.points.sort((a, b) => a.x - b.x);
    this.domainMin = domain[0];
    this.domainMax = domain[1];
    this.rangeMin = range[0];
    this.rangeMax = range[1];
  }

  /** 求 y(x)；超出定义域按端点钳制（clamp，不外推） */
  eval(x: number): number {
    const pts = this.points;
    if (x <= pts[0].x) return pts[0].y;
    const last = pts.length - 1;
    if (x >= pts[last].x) return pts[last].y;

    // 二分找右侧段
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x <= x) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const t = (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }

  /** 替换某个控制点（编辑器拖拽时调用，保持 x 有序与域钳制） */
  replacePoint(index: number, x: number, y: number): void {
    const p = this.points[index];
    p.x = clamp(x, this.domainMin, this.domainMax);
    p.y = clamp(y, this.rangeMin, this.rangeMax);
    // 拖拽可能破坏 x 顺序，重新排序；外部持有的 index 会失效，编辑器按对象引用找回
    this.points.sort((a, b) => a.x - b.x);
  }

  /** 新增控制点（编辑器双击空白处），返回插入后的索引 */
  addPoint(x: number, y: number): number {
    const px = clamp(x, this.domainMin, this.domainMax);
    const py = clamp(y, this.rangeMin, this.rangeMax);
    this.points.push({ x: px, y: py });
    this.points.sort((a, b) => a.x - b.x);
    return this.points.findIndex((p) => p.x === px && p.y === py);
  }

  /** 删除控制点（编辑器双击点），至少保留 2 个 */
  removePoint(index: number): boolean {
    if (this.points.length <= 2) return false;
    this.points.splice(index, 1);
    return true;
  }

  /** 深拷贝（重置 / 导入导出用） */
  clone(): PiecewiseCurve {
    return new PiecewiseCurve(
      this.label,
      this.points,
      [this.domainMin, this.domainMax],
      [this.rangeMin, this.rangeMax],
    );
  }

  toJSON(): CurvePoint[] {
    return this.points.map((p) => ({ ...p }));
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 把 0~100 的压力值钳制在合法区间 */
export function clampNeed(v: number): number {
  return clamp(v, 0, 100);
}
