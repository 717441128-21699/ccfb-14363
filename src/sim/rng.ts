/**
 * 可种子化随机数（Mulberry32）
 *
 * 同一种子 + 同一初始数据 → 完全可复现的一天，方便测试回放 bug。
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) 浮点 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [lo, hi) 浮点 */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** [lo, hi] 闭区间整数 */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** 从数组中等概率挑一个 */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/** 中文旅客名素材（随便造的数据） */
const SURNAMES = ['赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈', '褚', '卫', '蒋', '沈', '韩', '杨', '朱', '秦', '许', '何'];
const GIVEN = ['大壮', '三娘', '进宝', '守义', '有福', '长青', '万山', '小七', '老栓', '明远', '杏花', '铁柱', '婉娘', '安生', '万里', '知秋', '百顺', '怀安', '广田', '小满'];

export function makeName(rng: Rng): string {
  return rng.pick(SURNAMES) + rng.pick(GIVEN);
}
