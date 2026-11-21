/**
 * 设施与槽位
 *
 * 设施是一块矩形区域 + 若干容量槽位（饭馆桌子、客栈床铺、马厩马位……）。
 * NPC 决定使用某设施时抢占一个空槽，走到槽位上执行行动，结束后释放。
 * 容量数据直接暴露给评分器（slotsFree/slotsTotal）参与可用性打分。
 */

import type { ScorerFacility } from '../core/utility';
import type { Rng } from './rng';

export interface FacilityDef {
  id: string;
  name: string;
  icon: string;
  /** 世界坐标矩形 */
  x: number;
  y: number;
  w: number;
  h: number;
  slots: number;
  /** 渲染底色 */
  color: string;
}

export class Facility implements ScorerFacility {
  readonly def: FacilityDef;
  /** 每个槽位是否被占用 */
  private readonly taken: boolean[];
  private freeCount: number;

  constructor(def: FacilityDef) {
    this.def = def;
    this.taken = new Array(def.slots).fill(false);
    this.freeCount = def.slots;
  }

  get id(): string {
    return this.def.id;
  }

  get slotsTotal(): number {
    return this.def.slots;
  }

  get slotsFree(): number {
    return this.freeCount;
  }

  /** 随机占一个空槽，返回槽号；满员返回 -1 */
  reserveRandom(rng: Rng): number {
    if (this.freeCount === 0) return -1;
    // 容量通常很小（≤ 几十），线性扫描即可
    const start = rng.int(0, this.def.slots - 1);
    for (let k = 0; k < this.def.slots; k++) {
      const i = (start + k) % this.def.slots;
      if (!this.taken[i]) {
        this.taken[i] = true;
        this.freeCount--;
        return i;
      }
    }
    return -1;
  }

  release(slot: number): void {
    if (slot < 0 || slot >= this.taken.length || !this.taken[slot]) return;
    this.taken[slot] = false;
    this.freeCount++;
  }

  /** 槽位在世界坐标中的站位（矩形内网格排布） */
  slotPosition(slot: number): { x: number; y: number } {
    const d = this.def;
    const cols = Math.max(1, Math.ceil(Math.sqrt(d.slots * (d.w / d.h))));
    const rows = Math.ceil(d.slots / cols);
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const padX = d.w * 0.18;
    const padY = d.h * 0.22;
    return {
      x: d.x + padX + (cols === 1 ? 0 : (col * (d.w - padX * 2)) / (cols - 1)),
      y: d.y + padY + (rows === 1 ? 0 : (row * (d.h - padY * 2)) / (rows - 1)),
    };
  }
}

/** 世界尺寸（像素，固定场景；2000 人压测时同一布局放大容量） */
export const WORLD_W = 1280;
export const WORLD_H = 832;

/**
 * 驿站布局（随便造但成体系）：
 * 北房客栈、东侧茶摊、西侧饭馆、南角马厩、街心吵架点、中央空地闲逛。
 * capacityScale 供 2000 人压测时整体放大容量。
 */
export function createFacilities(capacityScale = 1): Facility[] {
  const s = (n: number) => Math.max(1, Math.round(n * capacityScale));
  const defs: FacilityDef[] = [
    { id: 'inn',       name: '客栈', icon: '🛏️', x: 430,  y: 40,  w: 420, h: 150, slots: s(12), color: '#8d6e63' },
    { id: 'tavern',    name: '饭馆', icon: '🍚', x: 60,   y: 120, w: 280, h: 170, slots: s(10), color: '#e07a5f' },
    { id: 'teahouse',  name: '茶摊', icon: '🍵', x: 940,  y: 120, w: 280, h: 190, slots: s(14), color: '#81b29a' },
    { id: 'stable',    name: '马厩', icon: '🐎', x: 80,   y: 560, w: 300, h: 200, slots: s(10), color: '#b08968' },
    { id: 'argueSpot', name: '街口', icon: '😡', x: 500,  y: 560, w: 280, h: 180, slots: s(8),  color: '#bc4749' },
  ];
  return defs.map((d) => new Facility(d));
}
