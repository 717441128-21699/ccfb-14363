/**
 * 入口：组装世界 / 渲染器 / 调试面板，驱动 requestAnimationFrame 主循环
 */

import './styles.css';
import { Renderer } from './render/renderer';
import { DebugPanel } from './debug/debug-panel';
import { World } from './sim/world';
import type { Npc } from './sim/npc';

const DEFAULT_SEED = 20261122;

function createWorld(npcCount: number, capacityScale: number): World {
  return new World({
    npcCount,
    seed: DEFAULT_SEED,
    capacityScale,
  });
}

let world = createWorld(45, 1);

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const panel = new DebugPanel(world, createWorld);

let selected: Npc | null = null;
let showBubbles = true;

// 重开世界（常规/压测）后同步 main 持有的引用
panel.onWorldRebuilt = (w) => {
  world = w;
  selected = null;
};

// —— 点击拾取 NPC ——
canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const p = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  const hit = world.pickNpc(p.x, p.y);
  selected = hit;
  panel.selectNpc(hit);
  canvas.style.cursor = hit ? 'pointer' : 'default';
});

canvas.addEventListener('mousemove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const p = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  canvas.style.cursor = world.pickNpc(p.x, p.y) ? 'pointer' : 'default';
});

// —— 气泡开关 ——
document.getElementById('bubbleToggle')!.addEventListener('change', (ev) => {
  showBubbles = (ev.target as HTMLInputElement).checked;
});

window.addEventListener('resize', () => renderer.resize());

// —— 主循环 ——
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1); // 切后台回来的大间隔钳掉
  last = now;

  world.update(dt);
  renderer.render(world, selected, showBubbles);
  panel.refresh();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
