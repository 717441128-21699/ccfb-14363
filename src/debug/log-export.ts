/**
 * 决策记录导出
 *
 * 测试要的「任意 NPC 一整天的决策记录」：每次选择时四项需求、钱、
 * 入选行动、得分、原因、当时空位都在里面。
 * CSV 带 UTF-8 BOM，Excel 直接双击不乱码。
 */

import type { DecisionLogEntry } from '../core/types';
import type { Npc } from '../sim/npc';

const REASON_LABEL: Record<string, string> = {
  highest: '得分最高',
  fallback: '兜底闲逛',
  blocked: '门控拦截',
  allGated: '全部被门控',
  tieBreak: '并列打破',
};

const COLUMNS: { key: keyof DecisionLogEntry; header: string }[] = [
  { key: 'day', header: '第几天' },
  { key: 'clock', header: '游戏分钟' },
  { key: 'action', header: '行动ID' },
  { key: 'actionName', header: '行动' },
  { key: 'score', header: '得分' },
  { key: 'reason', header: '入选原因' },
  { key: 'hunger', header: '饥饿' },
  { key: 'fatigue', header: '疲劳' },
  { key: 'stress', header: '压力' },
  { key: 'horseHunger', header: '马饥饿' },
  { key: 'money', header: '剩余铜钱' },
  { key: 'affordable', header: '付得起' },
  { key: 'slotsFree', header: '设施空位' },
];

/** 游戏分钟 → HH:MM */
export function clockLabel(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(npc: Npc): string {
  const rows = npc.exportLog();
  const header = COLUMNS.map((c) => c.header).join(',') + ',时刻';
  const lines = rows.map((e) => {
    const base = COLUMNS.map((c) =>
      csvCell(c.key === 'reason' ? REASON_LABEL[e.reason] ?? e.reason : e[c.key]),
    ).join(',');
    return `${base},${clockLabel(e.clock)}`;
  });
  // BOM 让 Excel 识别 UTF-8
  return '﻿' + [header, ...lines].join('\r\n');
}

export function toJson(npc: Npc): string {
  return JSON.stringify(
    {
      npcId: npc.id,
      npcName: npc.name,
      exportedAt: new Date().toISOString(),
      count: npc.log.length,
      reasonLegend: REASON_LABEL,
      records: npc.exportLog(),
    },
    null,
    2,
  );
}

/** 浏览器端下载文件 */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟回收，避免部分浏览器下载未启动就 revoke
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}
