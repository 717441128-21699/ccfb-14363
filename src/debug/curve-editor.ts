/**
 * 曲线编辑器（调试页内的可拖拽小部件）
 *
 * 交互：
 * - 拖拽控制点：改 y（效用/倍率）；按住 Shift 拖拽可同时改 x
 * - 双击空白：新增控制点
 * - 双击控制点：删除（至少保留 2 个）
 * - 任何修改都通过 onChange 回调通知外部（外部负责让 NPC 立刻按新曲线重估）
 */

import { PiecewiseCurve } from '../core/curves';

const PADDING = { left: 42, right: 14, top: 14, bottom: 30 };
const POINT_R = 5;

export class CurveEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private curve: PiecewiseCurve | null = null;
  private dragIndex = -1;
  private onChange: () => void;

  constructor(canvas: HTMLCanvasElement, onChange: () => void) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('曲线编辑器 Canvas 不可用');
    this.ctx = ctx;
    this.onChange = onChange;

    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('dblclick', this.onDblClick);
  }

  setCurve(curve: PiecewiseCurve | null): void {
    this.curve = curve;
    this.dragIndex = -1;
    this.render();
  }

  getCurve(): PiecewiseCurve | null {
    return this.curve;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
  }

  // —— 坐标换算 ——
  private plotWidth(): number {
    return this.canvas.clientWidth - PADDING.left - PADDING.right;
  }

  private plotHeight(): number {
    return this.canvas.clientHeight - PADDING.top - PADDING.bottom;
  }

  private toScreen(x: number, y: number): { sx: number; sy: number } {
    const c = this.curve!;
    return {
      sx: PADDING.left + ((x - c.domainMin) / (c.domainMax - c.domainMin)) * this.plotWidth(),
      sy: PADDING.top + (1 - (y - c.rangeMin) / (c.rangeMax - c.rangeMin)) * this.plotHeight(),
    };
  }

  private toData(sx: number, sy: number): { x: number; y: number } {
    const c = this.curve!;
    return {
      x: c.domainMin + ((sx - PADDING.left) / this.plotWidth()) * (c.domainMax - c.domainMin),
      y: c.rangeMin + (1 - (sy - PADDING.top) / this.plotHeight()) * (c.rangeMax - c.rangeMin),
    };
  }

  private hitPoint(sx: number, sy: number): number {
    if (!this.curve) return -1;
    for (let i = 0; i < this.curve.points.length; i++) {
      const p = this.toScreen(this.curve.points[i].x, this.curve.points[i].y);
      if (Math.hypot(p.sx - sx, p.sy - sy) <= POINT_R + 3) return i;
    }
    return -1;
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!this.curve) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    this.dragIndex = this.hitPoint(sx, sy);
    if (this.dragIndex >= 0) this.canvas.setPointerCapture(ev.pointerId);
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.dragIndex < 0 || !this.curve) return;
    const rect = this.canvas.getBoundingClientRect();
    const data = this.toData(ev.clientX - rect.left, ev.clientY - rect.top);
    const c = this.curve;
    const old = c.points[this.dragIndex];
    // 默认只拖 y；按住 Shift 才允许改 x（避免误操作打乱输入域）
    c.replacePoint(this.dragIndex, ev.shiftKey ? data.x : old.x, data.y);
    // replacePoint 会重排，按对象找回索引
    this.dragIndex = c.points.indexOf(old);
    this.render();
    this.onChange();
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.dragIndex >= 0) {
      try {
        this.canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* 指针已释放，忽略 */
      }
    }
    this.dragIndex = -1;
  };

  private onDblClick = (ev: MouseEvent): void => {
    if (!this.curve) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const hit = this.hitPoint(sx, sy);
    const c = this.curve;
    if (hit >= 0) {
      if (c.removePoint(hit)) {
        this.render();
        this.onChange();
      }
    } else if (
      sx >= PADDING.left &&
      sx <= this.canvas.clientWidth - PADDING.right &&
      sy >= PADDING.top &&
      sy <= this.canvas.clientHeight - PADDING.bottom
    ) {
      const data = this.toData(sx, sy);
      c.addPoint(data.x, data.y);
      this.render();
      this.onChange();
    }
  };

  render(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = '#fbf7ee';
    ctx.fillRect(0, 0, w, h);

    if (!this.curve) {
      ctx.fillStyle = '#9a8b78';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('在上方选择一条曲线进行编辑', w / 2, h / 2);
      return;
    }

    const c = this.curve;

    // 网格 + 轴标签
    ctx.strokeStyle = '#e3d9c6';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#8a7b68';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const sy = PADDING.top + t * this.plotHeight();
      ctx.beginPath();
      ctx.moveTo(PADDING.left, sy);
      ctx.lineTo(w - PADDING.right, sy);
      ctx.stroke();
      const yVal = c.rangeMax - t * (c.rangeMax - c.rangeMin);
      ctx.fillText(yVal.toFixed(2), PADDING.left - 5, sy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const sx = PADDING.left + t * this.plotWidth();
      const xVal = c.domainMin + t * (c.domainMax - c.domainMin);
      ctx.fillText(Math.round(xVal).toString(), sx, h - PADDING.bottom + 8);
    }

    // 绘图区边框
    ctx.strokeStyle = '#c9b99f';
    ctx.strokeRect(PADDING.left, PADDING.top, this.plotWidth(), this.plotHeight());

    // 折线
    ctx.beginPath();
    c.points.forEach((p, i) => {
      const s = this.toScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    });
    ctx.strokeStyle = '#1d3557';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 控制点
    for (let i = 0; i < c.points.length; i++) {
      const p = c.points[i];
      const s = this.toScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.sx, s.sy, POINT_R, 0, Math.PI * 2);
      ctx.fillStyle = i === this.dragIndex ? '#e07a5f' : '#fff';
      ctx.fill();
      ctx.strokeStyle = '#1d3557';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 标题与操作提示
    ctx.fillStyle = '#3e352b';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(c.label, PADDING.left, 2);
    ctx.fillStyle = '#9a8b78';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('拖点改 y · Shift+拖改 x · 双击空白加点 · 双击点删除', w - PADDING.right, 2);
  }
}
