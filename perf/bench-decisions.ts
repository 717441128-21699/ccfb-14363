/**
 * 决策性能基准（Node 无头环境，不依赖 DOM / Canvas）
 *
 * 跑法：npm run bench
 *
 * 测量口径：
 * 1. 全量决策：2000 个 NPC 在同一轮里全部 decide() 一次的总耗时与人均耗时
 *    —— 这是「最坏一帧」的理论上界；真实游戏里决策被错峰摊到多帧
 * 2. 错峰帧模拟：按 world.update 的调度规则统计典型帧的决策数与耗时，
 *    验证每帧决策阶段 ≤ 3ms 的预算
 * 3. 连续 3000 帧稳定性：检查是否有任何一帧超过 3ms
 */

import { ACTION_DEFS } from '../src/core/actions';
import { World } from '../src/sim/world';
import { decide } from '../src/core/utility';

const NPC_COUNT = 2000;
const FRAME_BUDGET_MS = 3;

function now(): number {
  // Node 16+ 可用 performance.now
  return performance.now();
}

function main(): void {
  const world = new World({ npcCount: NPC_COUNT, seed: 42, capacityScale: 6 });

  // —— 1. 全量决策上界 ——
  // 先让所有人进入 idle 且到期，再一次性全决策
  for (const npc of world.npcs) npc.nextDecideAt = 0;
  world.clockMin = 1;

  // 预热（JIT）
  for (const npc of world.npcs) decide(world, npc, npc.ctx);

  const t0 = now();
  const rounds = 20;
  for (let r = 0; r < rounds; r++) {
    for (const npc of world.npcs) decide(world, npc, npc.ctx);
  }
  const fullMs = (now() - t0) / rounds;

  console.log('===== Utility AI 决策基准（2000 NPC）=====');
  console.log(`全量决策一轮总耗时 : ${fullMs.toFixed(3)} ms（预算 ${FRAME_BUDGET_MS} ms 的 ${(fullMs / FRAME_BUDGET_MS * 100).toFixed(0)}%）`);
  console.log(`人均决策耗时       : ${(fullMs / NPC_COUNT * 1000).toFixed(3)} µs`);

  // —— 2 & 3. 错峰帧模拟：用真实 update 跑 3000 帧 ——
  const sim = new World({ npcCount: NPC_COUNT, seed: 7, capacityScale: 6 });
  sim.gameSpeed = 4;
  const frameDt = 1 / 60;
  let maxFrameMs = 0;
  let maxDecisionsInFrame = 0;
  let overBudgetFrames = 0;
  let totalDecisions = 0;
  let activeFrames = 0;
  let sumActiveMs = 0;

  for (let frame = 0; frame < 3000; frame++) {
    const a = now();
    sim.update(frameDt);
    const cost = now() - a;
    // update 里已记录纯决策阶段耗时，这里直接读 stats
    const decisionCost = sim.stats.lastDecisionMs;
    if (sim.stats.decisionsLastFrame > 0) {
      activeFrames++;
      sumActiveMs += decisionCost;
      totalDecisions += sim.stats.decisionsLastFrame;
      maxDecisionsInFrame = Math.max(maxDecisionsInFrame, sim.stats.decisionsLastFrame);
    }
    if (decisionCost > maxFrameMs) maxFrameMs = decisionCost;
    if (decisionCost > FRAME_BUDGET_MS) overBudgetFrames++;
  }

  console.log('');
  console.log('===== 错峰调度（3000 帧 @60fps，4× 速度）=====');
  console.log(`决策阶段峰值耗时   : ${maxFrameMs.toFixed(3)} ms`);
  console.log(`单帧最多决策人数   : ${maxDecisionsInFrame} 人`);
  console.log(`有决策的帧平均耗时 : ${(sumActiveMs / Math.max(1, activeFrames)).toFixed(3)} ms`);
  console.log(`超 3ms 预算的帧数  : ${overBudgetFrames} / 3000`);
  console.log(`累计决策次数       : ${totalDecisions}`);

  // —— 4. 决策合理性自检：构造多样化需求，7 个行动都应该有人选到 ——
  const fresh = new World({ npcCount: NPC_COUNT, seed: 99, capacityScale: 6 });
  const patterns = [
    { hunger: 95, fatigue: 20, stress: 20, horseHunger: 20, money: 200 }, // 吃饭
    { hunger: 20, fatigue: 95, stress: 20, horseHunger: 20, money: 200 }, // 住店
    { hunger: 20, fatigue: 20, stress: 20, horseHunger: 95, money: 200 }, // 喂马
    { hunger: 20, fatigue: 20, stress: 90, horseHunger: 20, money: 200 }, // 吵架/喝茶
    { hunger: 20, fatigue: 20, stress: 55, horseHunger: 20, money: 200 }, // 打听消息的甜区
    { hunger: 30, fatigue: 30, stress: 30, horseHunger: 30, money: 200 }, // 低迫切→闲逛
    { hunger: 90, fatigue: 20, stress: 20, horseHunger: 20, money: 0 },   // 破产被门控
  ];
  const counts = new Map<string, number>();
  for (let i = 0; i < fresh.npcs.length; i++) {
    const npc = fresh.npcs[i];
    const p = patterns[i % patterns.length];
    npc.needs.hunger = p.hunger;
    npc.needs.fatigue = p.fatigue;
    npc.needs.stress = p.stress;
    npc.needs.horseHunger = p.horseHunger;
    npc.money = p.money;
    decide(fresh, npc, npc.ctx);
    const name = ACTION_DEFS[npc.decidedActionIndex].id;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  console.log('');
  console.log('===== 行动选择分布（多样化需求强制决策一轮）=====');
  for (const [name, c] of [...counts.entries()].sort()) {
    console.log(`  ${name.padEnd(10)} ${c} 人 (${(c / NPC_COUNT * 100).toFixed(1)}%)`);
  }
  const coveredAll = ACTION_DEFS.every((a) => (counts.get(a.id) ?? 0) > 0);
  console.log('');
  console.log(coveredAll ? '✅ 通过：7 个候选行动都被实际选中过' : '⚠️ 警告：存在从未被选中的行动');

  const pass = maxFrameMs <= FRAME_BUDGET_MS && overBudgetFrames === 0;
  console.log('');
  console.log(pass ? '✅ 通过：错峰帧决策阶段全部 ≤ 3ms' : '❌ 未通过：存在超过 3ms 的帧');
  process.exitCode = pass ? 0 : 1;
}

main();
