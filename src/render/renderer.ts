/**
 * Canvas 渲染器
 *
 * 画三层：
 * 1. 地面与设施区域（含设施名/容量）
 * 2. 旅客圆点（颜色随当前行动区分；饿晕边缘加描边提醒）
 * 3. 头顶气泡：当前最想做/正在做的事（图标 + 行动名）
 *
 * 性能：2000 人时气泡只画被选中者 + 抽样 60 个，圆点本身始终全量绘制
 * （圆点只是 arc+fill，2000 个在主流机器上远低于帧预算）。
 */

import { ACTION_DEFS } from '../core/actions';
import { WORLD_H, WORLD_W } from '../sim/facility';
import type { Npc } from '../sim/npc';
import type { World } from '../sim/world';

/** 行动 → 圆点颜色 */
const ACTION_COLOR: Record<string, string> = {
  eat: '#e07a5f',
  tea: '#81b29a',
  feedHorse: '#b08968',
  lodging: '#7b8cbb',
  gossip: '#5f9ea0',
  argue: '#bc4749',
  wander: '#9e9e9e',
};

/** 大规模人口时气泡抽样上限 */
const BUBBLE_SAMPLE = 60;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** 世界坐标 → CSS 像素的缩放（等比适配） */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    this.ctx = ctx;
    this.resize();
  }

  /** 按 CSS 盒尺寸调整位图（处理 devicePixelRatio） */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.scale = Math.min(rect.width / WORLD_W, rect.height / WORLD_H);
    this.offsetX = (rect.width - WORLD_W * this.scale) / 2;
    this.offsetY = (rect.height - WORLD_H * this.scale) / 2;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 屏幕坐标 → 世界坐标（点击拾取用） */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  render(world: World, selected: Npc | null, showBubbles: boolean): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    // 背景
    ctx.fillStyle = '#f4ecd8';
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // 世界边界
    ctx.strokeStyle = '#8d7b68';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

    this.drawFacilities(world);
    this.drawNpcs(world, selected, showBubbles);

    ctx.restore();
  }

  private drawFacilities(world: World): void {
    const ctx = this.ctx;
    for (const f of world.facilities) {
      const d = f.def;
      ctx.fillStyle = d.color + '55';
      ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(d.x, d.y, d.w, d.h);

      ctx.fillStyle = '#3e352b';
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${d.icon} ${d.name}`, d.x + 8, d.y + 6);

      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = '#6b5d4f';
      ctx.fillText(`空位 ${f.slotsFree}/${f.slotsTotal}`, d.x + 8, d.y + d.h - 20);
    }
  }

  private drawNpcs(world: World, selected: Npc | null, showBubbles: boolean): void {
    const ctx = this.ctx;
    const npcs = world.npcs;
    const largePop = npcs.length > 200;
    let bubbleDrawn = 0;

    for (const npc of npcs) {
      const def = npc.currentActionIndex >= 0 ? ACTION_DEFS[npc.currentActionIndex] : null;
      const color = def ? ACTION_COLOR[def.id] ?? '#999' : '#999';

      // 快饿晕：橙红粗描边，玩家一眼能看出不对劲
      const starving = npc.needs.hunger >= 85;
      ctx.beginPath();
      ctx.arc(npc.x, npc.y, starving ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (starving) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#d62828';
        ctx.stroke();
      }

      // 选中高亮
      if (npc === selected) {
        ctx.beginPath();
        ctx.arc(npc.x, npc.y, 11, 0, Math.PI * 2);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#1d3557';
        ctx.stroke();
      }

      // 气泡：默认全开；人口过多时抽样 + 始终保留选中者
      const wantBubble = showBubbles && (npc === selected || !largePop || npc.id % 32 === 0);
      if (wantBubble && def && bubbleDrawn < (largePop ? BUBBLE_SAMPLE : Number.MAX_SAFE_INTEGER)) {
        this.drawBubble(npc, def.icon, def.name, npc === selected);
        bubbleDrawn++;
      }
    }
  }

  private drawBubble(npc: Npc, icon: string, label: string, strong: boolean): void {
    const ctx = this.ctx;
    const w = strong ? 74 : 58;
    const h = 22;
    const bx = npc.x - w / 2;
    const by = npc.y - 30;

    ctx.fillStyle = strong ? '#1d3557' : 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = strong ? '#1d3557' : '#b8a992';
    ctx.lineWidth = 1;
    this.roundRect(bx, by, w, h, 6);
    ctx.fill();
    ctx.stroke();

    // 小三角
    ctx.beginPath();
    ctx.moveTo(npc.x - 4, by + h);
    ctx.lineTo(npc.x + 4, by + h);
    ctx.lineTo(npc.x, by + h + 5);
    ctx.closePath();
    ctx.fillStyle = strong ? '#1d3557' : 'rgba(255,255,255,0.92)';
    ctx.fill();

    ctx.font = `${strong ? 13 : 12}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = strong ? '#fff' : '#3e352b';
    ctx.fillText(`${icon} ${label}`, npc.x, by + h / 2 + 0.5);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
