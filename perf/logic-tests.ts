/**
 * Utility AI 逻辑单元测试（零依赖，node --import tsx 直接跑）
 *
 * 覆盖：
 * - 分段线性曲线：插值、钳制、编辑器增删改点
 * - 评分器：门控归零、兜底闲逛、最高分压过兜底、门控解释落位
 * - 日志环形缓冲：容量、顺序还原、lastLog
 * - 导出：CSV 表头/BOM/行数、JSON 结构
 * - 世界模拟：一整天推进后没有 NPC 永久卡死在 idle
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTION_DEFS, MAX_CONSIDERATIONS } from '../src/core/actions';
import { createDefaultCurves, CurveLibrary, NEED_CONFIG } from '../src/core/config';
import { PiecewiseCurve } from '../src/core/curves';
import { decide } from '../src/core/utility';
import { World } from '../src/sim/world';
import { Npc } from '../src/sim/npc';
import { Rng } from '../src/sim/rng';
import { toCsv, toJson, clockLabel } from '../src/debug/log-export';

const WANDER_INDEX = ACTION_DEFS.findIndex((a) => a.id === 'wander');
const EAT_INDEX = ACTION_DEFS.findIndex((a) => a.id === 'eat');
const LODGING_INDEX = ACTION_DEFS.findIndex((a) => a.id === 'lodging');

function makeWorld(n = 30): World {
  return new World({ npcCount: n, seed: 123, capacityScale: 1 });
}

// ---------------- 曲线 ----------------

test('分段线性曲线：端点钳制与线性插值', () => {
  const c = new PiecewiseCurve('t', [{ x: 0, y: 0 }, { x: 100, y: 1 }], [0, 100], [0, 1]);
  assert.equal(c.eval(-5), 0);
  assert.equal(c.eval(105), 1);
  assert.equal(c.eval(0), 0);
  assert.equal(c.eval(100), 1);
  assert.ok(Math.abs(c.eval(50) - 0.5) < 1e-9);
});

test('曲线编辑器：增点、删点（保留至少 2 个）、域钳制', () => {
  const c = new PiecewiseCurve('t', [{ x: 0, y: 0 }, { x: 100, y: 1 }], [0, 100], [0, 1]);
  const idx = c.addPoint(50, 0.7);
  assert.equal(c.points.length, 3);
  assert.equal(c.eval(50), 0.7);
  assert.equal(idx, 1);

  c.replacePoint(1, 50, 2); // y 超出值域 → 钳到 1
  assert.equal(c.points[1].y, 1);

  assert.equal(c.removePoint(1), true);
  assert.equal(c.points.length, 2);
  assert.equal(c.removePoint(0), false); // 不允许只剩 1 个点
  assert.equal(c.points.length, 2);
});

test('曲线库：序列化/加载/重置保持域定义', () => {
  const lib = new CurveLibrary();
  const data = lib.serialize();
  assert.ok(data['eat.hunger'].length >= 2);
  lib.get('eat.hunger').points[0].y = 0.99;
  lib.load(data);
  assert.equal(lib.get('eat.hunger').points[0].y, data['eat.hunger'][0].y);
  lib.reset();
  const def = createDefaultCurves();
  assert.deepEqual(lib.serialize()['eat.hunger'], def['eat.hunger'].toJSON());
});

// ---------------- 评分器 ----------------

test('门控：没钱时付费行动归零并写门控解释，闲逛仍可用', () => {
  const world = makeWorld(1);
  const npc = world.npcs[0];
  npc.needs.hunger = 99;
  npc.needs.stress = 0; // 压低压力，避免免费的吵架/闲逛竞争，隔离「没钱」这一个变量
  npc.money = 0; // 所有付费行动都付不起

  decide(world, npc, npc.ctx);

  assert.equal(npc.actionScore[EAT_INDEX], 0);
  // 找到吃饭行动里「手头铜钱」考虑项的位置，验证门控标记与解释
  const eatDef = ACTION_DEFS[EAT_INDEX];
  const moneyConsIdx = eatDef.considerations.findIndex((c) => c.label === '手头铜钱');
  assert.ok(moneyConsIdx >= 0);
  const gateIdx = EAT_INDEX * MAX_CONSIDERATIONS + moneyConsIdx;
  assert.equal(npc.consGated[gateIdx], 1);
  assert.match(npc.consGateMsg[gateIdx], /铜钱不足/);
  // 付费行动全部归零，最终只能落到免费行动（闲逛或吵架）
  for (const def of ACTION_DEFS) {
    if (def.cost > 0) {
      const ai = ACTION_DEFS.indexOf(def);
      assert.equal(npc.actionScore[ai], 0, `${def.name} 付不起时应为 0 分`);
    }
  }
  assert.ok(npc.actionScore[WANDER_INDEX] > 0);
});

test('高饥饿且有钱：吃饭得分压过闲逛兜底', () => {
  const world = makeWorld(1);
  const npc = world.npcs[0];
  npc.needs.hunger = 95;
  npc.needs.fatigue = 10;
  npc.needs.stress = 10;
  npc.needs.horseHunger = 10;
  npc.money = 200;

  decide(world, npc, npc.ctx);

  assert.equal(npc.decidedActionIndex, EAT_INDEX);
  assert.equal(npc.decidedReason, 'highest');
  assert.ok(npc.actionScore[EAT_INDEX] > npc.actionScore[WANDER_INDEX]);
});

test('低迫切需求：触发兜底闲逛', () => {
  const world = makeWorld(1);
  const npc = world.npcs[0];
  // 固定为中性性格，排除亲和度乘子干扰
  npc.traits.frugal = 0.5;
  npc.traits.aggressive = 0.5;
  npc.traits.sociable = 0.5;
  npc.traits.dutiful = 0.5;
  npc.needs.hunger = 5;
  npc.needs.fatigue = 5;
  npc.needs.stress = 5;
  npc.needs.horseHunger = 5;
  npc.money = 200;

  decide(world, npc, npc.ctx);
  assert.equal(npc.decidedActionIndex, WANDER_INDEX);
  assert.equal(npc.decidedReason, 'fallback');
});

test('设施满员：可用性门控把该行动归零', () => {
  const world = makeWorld(1);
  const inn = world.facilityMap.get('inn')!;
  // 占满客栈
  const slots: number[] = [];
  while (inn.slotsFree > 0) slots.push(inn.reserveRandom(world.rng));
  assert.equal(inn.slotsFree, 0);

  const npc = world.npcs[0];
  npc.needs.fatigue = 99;
  npc.money = 200;
  decide(world, npc, npc.ctx);
  assert.equal(npc.actionScore[LODGING_INDEX], 0);
  assert.notEqual(npc.decidedActionIndex, LODGING_INDEX);

  for (const s of slots) inn.release(s);
});

test('评分热路径零分配：连续决策不产生垃圾对象', () => {
  const world = makeWorld(5);
  const npc = world.npcs[0];
  decide(world, npc, npc.ctx);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 10000; i++) decide(world, npc, npc.ctx);
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  // 1 万次决策后堆增长应很小（留足 GC 口径余量，阈值 2MB）
  assert.ok(after - before < 2 * 1024 * 1024, `heap grew ${after - before} bytes`);
});

// ---------------- 日志与导出 ----------------

test('决策日志环形缓冲：容量、覆盖、顺序还原', () => {
  const rng = new Rng(1);
  const npc = new Npc(0, rng, { x: 0, y: 0 }, 360);
  npc.loggingEnabled = true;
  const entry = (i: number) => ({
    day: 1, clock: i, action: 'wander' as const, actionName: '闲逛',
    score: 0.1, reason: 'fallback' as const,
    hunger: i, fatigue: 0, stress: 0, horseHunger: 0,
    money: 0, affordable: true, slotsFree: 1,
  });

  for (let i = 0; i < npc.logCapacity + 50; i++) npc.appendLog(entry(i));
  assert.equal(npc.log.length, npc.logCapacity);
  const exported = npc.exportLog();
  assert.equal(exported.length, npc.logCapacity);
  // 最旧的一条应是第 50 号，最新是最后写入的
  assert.equal(exported[0].hunger, 50);
  assert.equal(exported[exported.length - 1].hunger, npc.logCapacity + 49);
  assert.equal(npc.lastLog()!.hunger, npc.logCapacity + 49);

  const csv = toCsv(npc);
  assert.ok(csv.startsWith('﻿'), 'CSV 应带 UTF-8 BOM');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, npc.logCapacity + 1); // 表头 + 数据行
  assert.match(lines[0], /第几天,游戏分钟/);
  assert.match(lines[0], /时刻$/);

  const json = JSON.parse(toJson(npc));
  assert.equal(json.records.length, npc.logCapacity);
  assert.equal(json.npcId, 0);
});

test('clockLabel 跨天格式化', () => {
  assert.equal(clockLabel(0), '00:00');
  assert.equal(clockLabel(60 * 6 + 5), '06:05');
  assert.equal(clockLabel(1439), '23:59');
});

// ---------------- 端到端模拟 ----------------

test('一整天模拟：所有 NPC 都产生过行动，没有永久站着不动', () => {
  const world = makeWorld(45);
  world.gameSpeed = 20;
  const acted = new Set<number>();
  const dt = 1 / 60;
  // 20× 速度下 72 秒现实时间 ≈ 一整天（1440 分钟）
  for (let f = 0; f < 60 * 80; f++) {
    world.update(dt);
    for (const npc of world.npcs) {
      if (npc.currentActionIndex >= 0) acted.add(npc.id);
    }
    if (world.day >= 2) break;
  }
  assert.equal(acted.size, world.npcs.length, '每个旅客都应至少开始过一个行动');
});

test('需求增长：时辰曲线驱动且被钳制在 0~100', () => {
  const world = makeWorld(1);
  const npc = world.npcs[0];
  npc.needs.hunger = 99.9;
  world.gameSpeed = 20;
  for (let f = 0; f < 600; f++) world.update(1 / 60);
  for (const cfg of NEED_CONFIG) {
    const v = npc.needs[cfg.id];
    assert.ok(v >= 0 && v <= 100, `${cfg.id} 越界: ${v}`);
  }
});

test('每日盘缠：跨天后 NPC 收到收入', () => {
  const world = makeWorld(1);
  const npc = world.npcs[0];
  npc.money = 10;
  world.clockMin = 1439;
  world.gameSpeed = 20;
  world.update(1 / 30); // 跨过午夜
  assert.equal(world.day, 2);
  assert.ok(npc.money > 10, '跨天应发放盘缠');
});
