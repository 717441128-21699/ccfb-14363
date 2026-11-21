/**
 * 行为调试面板
 *
 * 三块职责：
 * 1. 模拟控制：暂停/速度/重开/压测切换、性能读数（决策耗时是否守住 3ms）
 * 2. NPC 详情：点击画布选中后展示需求条、性格、每个候选行动的考虑项
 *    原始输入/曲线效用/门控/最终分，以及入选原因
 * 3. 曲线编辑：下拉选曲线 → 拖拽改点 → 即时生效；导出/导入/重置；
 *    被选中 NPC 的全天决策记录导出 CSV / JSON
 */

import { ACTION_DEFS, MAX_CONSIDERATIONS } from '../core/actions';
import { PiecewiseCurve } from '../core/curves';
import type { Npc } from '../sim/npc';
import type { World } from '../sim/world';
import { clockLabel, downloadText, reasonLabel, toCsv, toJson } from './log-export';
import { CurveEditor } from './curve-editor';

const STORAGE_KEY = 'poststation-curves-v1';

type RebuildWorldFn = (npcCount: number, capacityScale: number) => World;

export class DebugPanel {
  private world: World;
  private selected: Npc | null = null;
  private editor: CurveEditor;
  private readonly rebuildWorld: RebuildWorldFn;
  private selectedCurveId = '';

  // —— DOM 句柄 ——
  private readonly el: Record<string, HTMLElement> = {};

  constructor(world: World, rebuildWorld: RebuildWorldFn) {
    this.world = world;
    this.rebuildWorld = rebuildWorld;
    this.cacheElements();
    this.editor = new CurveEditor(this.el.curveCanvas as HTMLCanvasElement, () => {
      this.world.invalidateDecisions();
      this.saveCurves();
    });

    this.bindControls();
    this.restoreCurves();
    this.populateCurveSelect();
    this.selectCurve(this.world.curves.ids()[0]);
    world.trackNpc(null);
  }

  /** 重开世界后换绑新实例 */
  attachWorld(world: World): void {
    this.world = world;
    this.selected = null;
    this.world.trackNpc(null);
    this.populateCurveSelect();
    this.selectCurve(this.selectedCurveId || this.world.curves.ids()[0]);
  }

  selectNpc(npc: Npc | null): void {
    this.selected = npc;
    this.world.trackNpc(npc);
  }

  get selectedNpc(): Npc | null {
    return this.selected;
  }

  // ================= 初始化 =================

  private cacheElements(): void {
    const ids = [
      'btnPause', 'speedGroup', 'btnReset', 'btnStress',
      'hudClock', 'hudDay', 'hudNpc', 'hudDecisionMs', 'hudAvgMs',
      'hudDecisions', 'hudBudget',
      'npcEmpty', 'npcDetail', 'npcName', 'npcState', 'npcMoney', 'npcTraits',
      'needBars', 'scoreTable', 'decisionReason', 'logInfo',
      'btnExportCsv', 'btnExportJson', 'btnClearLog',
      'curveSelect', 'btnCurveReset', 'btnCurveExport', 'btnCurveImport',
      'curveFile', 'curveCanvas', 'bubbleToggle',
    ];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (!node) throw new Error(`调试页缺少元素 #${id}`);
      this.el[id] = node;
    }
  }

  private bindControls(): void {
    this.el.btnPause.addEventListener('click', () => {
      this.world.paused = !this.world.paused;
      this.el.btnPause.textContent = this.world.paused ? '▶ 继续' : '⏸ 暂停';
    });

    this.el.speedGroup.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button[data-speed]');
      if (!btn) return;
      this.world.gameSpeed = Number((btn as HTMLButtonElement).dataset.speed);
      this.el.speedGroup.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('active', b === btn),
      );
    });

    this.el.btnReset.addEventListener('click', () => {
      const w = this.rebuildWorld(45, 1);
      this.attachWorld(w);
      this.onWorldRebuilt?.(w);
    });

    this.el.btnStress.addEventListener('click', () => {
      const w = this.rebuildWorld(2000, 6);
      this.attachWorld(w);
      this.onWorldRebuilt?.(w);
    });

    this.el.curveSelect.addEventListener('change', () => {
      this.selectCurve((this.el.curveSelect as HTMLSelectElement).value);
    });

    this.el.btnCurveReset.addEventListener('click', () => {
      this.world.curves.reset();
      this.editor.setCurve(this.world.curves.get(this.selectedCurveId));
      this.world.invalidateDecisions();
      localStorage.removeItem(STORAGE_KEY);
    });

    this.el.btnCurveExport.addEventListener('click', () => {
      downloadText(
        'curves.json',
        JSON.stringify(this.world.curves.serialize(), null, 2),
        'application/json',
      );
    });

    this.el.btnCurveImport.addEventListener('click', () => {
      (this.el.curveFile as HTMLInputElement).click();
    });

    this.el.curveFile.addEventListener('change', () => {
      const input = this.el.curveFile as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          this.world.curves.load(data);
          this.editor.setCurve(this.world.curves.get(this.selectedCurveId));
          this.world.invalidateDecisions();
          this.saveCurves();
        } catch (err) {
          alert('曲线文件解析失败：' + (err as Error).message);
        }
      };
      reader.readAsText(file);
      input.value = '';
    });

    this.el.btnExportCsv.addEventListener('click', () => this.exportLog('csv'));
    this.el.btnExportJson.addEventListener('click', () => this.exportLog('json'));
    this.el.btnClearLog.addEventListener('click', () => {
      this.selected?.clearLog();
    });
  }

  /** 由 main 注入：重开世界后要替换 main 里持有的引用与画布选中态 */
  onWorldRebuilt: ((world: World) => void) | null = null;

  // ================= 曲线 =================

  private populateCurveSelect(): void {
    const sel = this.el.curveSelect as HTMLSelectElement;
    const current = sel.value;
    sel.innerHTML = '';
    for (const id of this.world.curves.ids()) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = this.world.curves.get(id).label;
      sel.appendChild(opt);
    }
    sel.value = current && this.world.curves.ids().includes(current)
      ? current
      : this.world.curves.ids()[0];
  }

  private selectCurve(id: string): void {
    this.selectedCurveId = id;
    (this.el.curveSelect as HTMLSelectElement).value = id;
    this.editor.setCurve(this.world.curves.get(id) as PiecewiseCurve);
  }

  private saveCurves(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.world.curves.serialize()));
    } catch {
      /* 存储不可用时静默，曲线编辑本会话仍然有效 */
    }
  }

  private restoreCurves(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.world.curves.load(JSON.parse(raw));
    } catch {
      /* 坏数据直接忽略，用默认曲线 */
    }
  }

  // ================= 日志导出 =================

  private exportLog(kind: 'csv' | 'json'): void {
    if (!this.selected) {
      alert('请先在画布上点选一个旅客');
      return;
    }
    if (this.selected.log.length === 0) {
      alert('该旅客还没有产生决策记录（模拟处于暂停或刚选中）');
      return;
    }
    const stamp = `day${this.world.day}-${clockLabel(this.world.clockMin).replace(':', '')}`;
    if (kind === 'csv') {
      downloadText(`npc-${this.selected.id}-${this.selected.name}-${stamp}.csv`, toCsv(this.selected), 'text/csv;charset=utf-8');
    } else {
      downloadText(`npc-${this.selected.id}-${this.selected.name}-${stamp}.json`, toJson(this.selected), 'application/json');
    }
  }

  // ================= 每帧刷新 =================

  refresh(): void {
    this.refreshHud();
    this.editor.render();
    if (this.selected && this.world.npcs.includes(this.selected)) {
      this.refreshNpcDetail();
    } else if (this.selected) {
      // 世界重开后旧引用失效
      this.selectNpc(null);
    }
    if (!this.selected) {
      this.el.npcEmpty.hidden = false;
      this.el.npcDetail.hidden = true;
    }
  }

  private refreshHud(): void {
    const w = this.world;
    this.el.hudClock.textContent = clockLabel(w.clockMin);
    this.el.hudDay.textContent = String(w.day);
    this.el.hudNpc.textContent = String(w.npcs.length);
    this.el.hudDecisionMs.textContent = w.stats.lastDecisionMs.toFixed(3);
    this.el.hudAvgMs.textContent = w.stats.avgDecisionMs.toFixed(3);
    this.el.hudDecisions.textContent = String(w.stats.decisionsLastFrame);

    const budget = this.el.hudBudget;
    const over = w.stats.lastDecisionMs > 3;
    budget.textContent = over ? '超预算' : '达标';
    budget.className = 'badge ' + (over ? 'badge-bad' : 'badge-ok');
  }

  private refreshNpcDetail(): void {
    const npc = this.selected!;
    this.el.npcEmpty.hidden = true;
    this.el.npcDetail.hidden = false;

    const def = npc.currentActionIndex >= 0 ? ACTION_DEFS[npc.currentActionIndex] : null;
    const stateText = def
      ? `${npc.mode === 'moving' ? '赶路去' : '正在'}「${def.icon} ${def.name}」`
      : '等待决策';
    this.el.npcName.textContent = `#${npc.id} ${npc.name}`;
    this.el.npcState.textContent = stateText;
    this.el.npcMoney.textContent = `${npc.money} 文`;
    this.el.npcTraits.textContent =
      `节俭 ${pct(npc.traits.frugal)} · 好斗 ${pct(npc.traits.aggressive)} · ` +
      `健谈 ${pct(npc.traits.sociable)} · 尽责 ${pct(npc.traits.dutiful)}`;

    this.renderNeedBars(npc);
    this.renderScoreTable(npc);
    this.renderDecisionReason(npc);
    this.renderLogInfo(npc);
  }

  private renderNeedBars(npc: Npc): void {
    const needs: { key: keyof typeof npc.needs; label: string }[] = [
      { key: 'hunger', label: '饥饿' },
      { key: 'fatigue', label: '疲劳' },
      { key: 'stress', label: '压力' },
      { key: 'horseHunger', label: '马饥饿' },
    ];
    this.el.needBars.innerHTML = needs
      .map(({ key, label }) => {
        const v = npc.needs[key];
        const cls = v >= 80 ? 'bar-danger' : v >= 55 ? 'bar-warn' : 'bar-ok';
        return `
          <div class="need-row">
            <span class="need-label">${label}</span>
            <div class="bar"><div class="bar-fill ${cls}" style="width:${v.toFixed(1)}%"></div></div>
            <span class="need-val">${v.toFixed(0)}</span>
          </div>`;
      })
      .join('');
  }

  private renderScoreTable(npc: Npc): void {
    const rows: string[] = [];
    for (let ai = 0; ai < ACTION_DEFS.length; ai++) {
      const def = ACTION_DEFS[ai];
      const isChosen = ai === npc.decidedActionIndex;
      const base = ai * MAX_CONSIDERATIONS;
      const detail = def.considerations
        .map((cd, j) => {
          const idx = base + j;
          const gated = npc.consGated[idx] === 1;
          const msg = gated ? ` <em class="gated">(${npc.consGateMsg[idx]})</em>` : '';
          // 纯门控项不参与加权，右侧用文字说明而不是假分数
          const valueText = cd.gateOnly
            ? gated ? '拦截 ✋' : '通过 ✓'
            : `${npc.consInput[idx].toFixed(1)} → ${npc.consScore[idx].toFixed(3)}`;
          return `<div class="cons-row ${gated ? 'cons-gated' : ''}">
              <span>${cd.label}${cd.gateOnly ? ' <em class="gate-tag">门控</em>' : ''}${msg}</span>
              <span class="mono">${valueText}</span>
            </div>`;
        })
        .join('');
      rows.push(`
        <div class="score-card ${isChosen ? 'chosen' : ''}">
          <div class="score-head">
            <span>${def.icon} ${def.name}${isChosen ? ' <span class="pick-tag">本次选中</span>' : ''}</span>
            <span class="mono score-num">${npc.actionScore[ai].toFixed(4)}</span>
          </div>
          ${detail}
        </div>`);
    }
    this.el.scoreTable.innerHTML = rows.join('');
  }

  private renderDecisionReason(npc: Npc): void {
    const def = ACTION_DEFS[npc.decidedActionIndex];
    this.el.decisionReason.innerHTML =
      `最新决策：<strong>${def.icon} ${def.name}</strong> · 得分 <span class="mono">${npc.decidedScore.toFixed(4)}</span> · ` +
      `原因 <strong>${reasonLabel(npc.decidedReason)}</strong> · 时刻 ${clockLabel(this.world.clockMin)}`;
  }

  private renderLogInfo(npc: Npc): void {
    const n = npc.log.length;
    const last = npc.lastLog();
    const lastText = last
      ? `最近一条：第${last.day}天 ${clockLabel(last.clock)} → ${last.actionName}（${reasonLabel(last.reason)}）`
      : '暂无记录';
    this.el.logInfo.textContent = `已记录 ${n}/${npc.logCapacity} 条 · ${lastText}`;
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
