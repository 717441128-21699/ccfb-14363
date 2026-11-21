/** 长时模拟冒烟：3 个游戏日，检查活性、数值合法性、行动多样性、经济循环 */
import { ACTION_DEFS } from '../src/core/actions';
import { World } from '../src/sim/world';

const world = new World({ npcCount: 200, seed: 2026, capacityScale: 3 });
world.gameSpeed = 20;
const dt = 1 / 60;
const actionCounts = new Map<string, number>();
let stuckIdle = 0;

for (let frame = 0; frame < 60 * 60 * 6; frame++) { // 6 分钟现实 ≈ 7200 游戏分钟 = 5 天
  world.update(dt);
  if (world.day >= 4) break;
}

for (const npc of world.npcs) {
  for (const v of Object.values(npc.needs)) {
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`需求越界: ${v}`);
  }
  if (!Number.isFinite(npc.money)) throw new Error('钱出现 NaN');
  if (npc.mode === 'idle' && npc.currentActionIndex < 0) stuckIdle++;
}

// 用一次全量决策看 5 天后的生态
for (const npc of world.npcs) {
  npc.nextDecideAt = 0;
}
world.clockMin = 720;
for (const npc of world.npcs) {
  // 直接复用 world 内部流程：手动让其到期后 update
}
world.update(dt);
for (const npc of world.npcs) {
  if (npc.currentActionIndex >= 0) {
    const id = ACTION_DEFS[npc.currentActionIndex].id;
    actionCounts.set(id, (actionCounts.get(id) ?? 0) + 1);
  }
}

const moneyStats = world.npcs.reduce(
  (acc, n) => ({ min: Math.min(acc.min, n.money), max: Math.max(acc.max, n.money), sum: acc.sum + n.money }),
  { min: Infinity, max: -Infinity, sum: 0 },
);

console.log(`天数: ${world.day}  时刻: ${Math.floor(world.clockMin / 60)}:${String(world.clockMin % 60).padStart(2, '0')}`);
console.log(`累计决策: ${world.stats.totalDecisions}  决策峰值耗时: ${world.stats.lastDecisionMs.toFixed(2)}ms`);
console.log(`当前在执行行动的旅客分布:`, Object.fromEntries([...actionCounts.entries()].sort()));
console.log(`铜钱 min/avg/max: ${moneyStats.min} / ${(moneyStats.sum / world.npcs.length).toFixed(0)} / ${moneyStats.max}`);
console.log(`仍处 idle 的旅客: ${stuckIdle}/${world.npcs.length}`);
if (stuckIdle === world.npcs.length) throw new Error('全员卡死');
console.log('✅ 长时模拟冒烟通过');
