/** 全天行动覆盖统计：通过追踪 NPC 的行动切换，统计自然演化中每种行动的发生次数 */
import { ACTION_DEFS } from '../src/core/actions';
import { World } from '../src/sim/world';

const world = new World({ npcCount: 200, seed: 77, capacityScale: 3 });
world.gameSpeed = 20;
const dt = 1 / 60;
const starts = new Map<string, number>();
const prev = new Map<number, number>(); // npcId -> 上一帧的 actionIndex

function snapshot() {
  for (const npc of world.npcs) {
    const prevAi = prev.get(npc.id) ?? -1;
    if (npc.currentActionIndex >= 0 && npc.currentActionIndex !== prevAi) {
      const id = ACTION_DEFS[npc.currentActionIndex].id;
      starts.set(id, (starts.get(id) ?? 0) + 1);
    }
    prev.set(npc.id, npc.currentActionIndex);
  }
}

for (let frame = 0; frame < 60 * 90; frame++) { // 90 现实秒 ≈ 10800 游戏分钟（7.5 天）
  world.update(dt);
  snapshot();
  if (world.day >= 8) break;
}

console.log(`模拟到第 ${world.day} 天，行动启动次数统计：`);
let allCovered = true;
for (const def of ACTION_DEFS) {
  const n = starts.get(def.id) ?? 0;
  if (n === 0) allCovered = false;
  console.log(`  ${def.icon} ${def.name.padEnd(4)} ${n} 次`);
}
console.log(allCovered ? '✅ 自然演化中 7 个行动全部发生过' : '❌ 有行动从未发生');
if (!allCovered) process.exitCode = 1;
