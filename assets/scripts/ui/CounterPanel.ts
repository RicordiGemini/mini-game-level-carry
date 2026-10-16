/**
 * 属性克制面板 —— 对局角落常驻
 *
 * 【24 种属性下，这个面板不是锦上添花而是必需品】
 *
 *   6 种属性时玩家边玩边学就能记住克制关系；
 *   24 种属性时 24×24 的表不可能靠脑子记 ——
 *   如果不把"我这套武器打这一关是什么关系"直接写出来，
 *   属性系统就退化成查字典，玩家被属性克制 5 次之后就会放弃镶嵌。
 *
 *   所以这里常驻显示三件事：
 *     1. 本关属性（敌人都是什么）
 *     2. 我镶了哪些属性，以及每个属性对每个敌人属性的实际倍率
 *     3. 当前破防百分比
 *
 * 【为什么显示"实际倍率"而不是只写"克制/被克"】
 *   因为破防会让同一个"克制"在不同装备下变成不同倍率。
 *   玩家看到"克 ×1.28"才知道自己的破防起了多少作用 ——
 *   只写"克制"两个字，他会以为破防没生效。
 *
 * 【它不参与任何判定】
 *   纯展示，不能点、不响应拖动，放在战场安全区之外。
 *
 * 预制体节点结构建议：
 *   CounterPanel (本脚本, 默认 active = false)
 *   ├── LevelLabel    Label —— "本关属性：火 · 水 · 木 · 金属"
 *   ├── SocketLabel   Label —— "铁剑　火(克 1.28) 雷(被 0.94)"
 *   └── BreakLabel    Label —— "破防 42%　克制衰减 42%"
 */

import { _decorator, Component, Label } from 'cc';
import {
    ELEMENT_IDS,
    countersOf,
    elementDamageMul,
    elementName,
    elementsForLevel,
    getElementDef,
    levelElementDesc,
    resistedBy,
} from '../data/ElementConfig';
import { ElementId } from '../data/GameTypes';
import { WeaponSpec } from '../battle/BattleTypes';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

/** 一件武器对全部敌人属性的倍率表 */
export interface CounterRow {
    weaponName: string;
    elements: ElementId[];
    /** 下标与 levelEls 一一对应 */
    muls: number[];
    breakPct: number;
}

@ccclass('CounterPanel')
export class CounterPanel extends Component {
    @property(Label) levelLabel: Label = null!;
    @property(Label) socketLabel: Label = null!;
    @property(Label) breakLabel: Label = null!;

    private _rows: CounterRow[] = [];
    private _levelEls: ElementId[] = [];

    onLoad(): void {
        this.node.active = false;
    }

    /**
     * 更新面板。
     *
     * @param levelEls 本关属性池
     * @param weapons  本局出战武器（带 elements 字段）
     * @param breakPct 本局破防（取出战武器里最高的那一件）
     */
    public show(levelEls: ElementId[], weapons: WeaponSpec[], breakPct: number): void {
        this._levelEls = levelEls.slice();
        this._rows = [];

        // 第十轮：首次出现属性克制面板时解释克制关系
        TutorialLayer.showTipById('tip_element');

        // 同一件武器的镶嵌属性合并成一组算，而不是逐颗算 ——
        // 玩家关心的是"这套武器打这一关什么关系"，不是"这颗石头什么关系"
        const byWeapon = new Map<string, ElementId[]>();
        for (const w of weapons) {
            const els = (w.elements || []) as ElementId[];
            if (els.length === 0) continue;
            byWeapon.set(w.name, els);
        }

        for (const pair of byWeapon) {
            const name = pair[0];
            const els = pair[1];
            const muls: number[] = [];
            for (let i = 0; i < this._levelEls.length; i++) {
                muls.push(elementDamageMul(els, this._levelEls[i], breakPct));
            }
            this._rows.push({ weaponName: name, elements: els, muls, breakPct });
        }

        this.refresh();
    }

    public hide(): void {
        this.node.active = false;
    }

    private refresh(): void {
        // 一件属性都没镶时直接不显示 —— 空面板比没有面板更让人困惑
        if (this._rows.length === 0) {
            this.node.active = false;
            return;
        }
        this.node.active = true;

        if (this.levelLabel) {
            this.levelLabel.string = '本关属性：' +
                this._levelEls.map(elementName).join(' · ');
        }

        if (this.socketLabel) {
            const lines: string[] = [];
            for (let r = 0; r < this._rows.length; r++) {
                const row = this._rows[r];
                const parts: string[] = [];
                for (let i = 0; i < row.elements.length; i++) {
                    parts.push(getElementDef(row.elements[i]).name + '(' +
                        CounterPanel.mulText(row.muls[i]) + ')');
                }
                lines.push(row.weaponName + '　' + parts.join(' '));
            }
            this.socketLabel.string = lines.join('\n');
        }

        if (this.breakLabel) {
            const b = this._rows[0].breakPct;
            this.breakLabel.string = b > 0
                ? '破防 ' + Math.round(b * 100) + '%　克制衰减 ' + Math.round(b * 100) + '%'
                : '未镶嵌属性（全部 ×1.00）';
        }
    }

    /** 倍率的展示文案：只写真正有关系的那些，×1.00 写破折号省地方 */
    private static mulText(m: number): string {
        if (m > 1.001) return '克 ' + m.toFixed(2);
        if (m < 0.999) return '被 ' + m.toFixed(2);
        return '—';
    }

    // ------------------------------------------------------------ 静态工具（测试直接调）

    /** 倍率快查文案 */
    static mulTextOf(m: number): string {
        return CounterPanel.mulText(m);
    }

    /** 面板当前展示的全部倍率，测试用来断言"克制真的算出来了" */
    static mulsOf(panel: CounterPanel): number[] {
        const out: number[] = [];
        for (let r = 0; r < panel._rows.length; r++) {
            for (let i = 0; i < panel._rows[r].muls.length; i++) {
                out.push(panel._rows[r].muls[i]);
            }
        }
        return out;
    }

    /** 面板当前有几行（一行 = 一件镶了属性的武器） */
    static rowCount(panel: CounterPanel): number {
        return panel._rows.length;
    }
}

// ====================================================================
// 关卡确认页的属性提示
// ====================================================================

/**
 * 关卡确认用的属性提示。
 *
 * 做成纯函数（而不是塞进面板类）是因为它要被三处调用：
 * 难度选择页、关卡选择行、战败重开提示 —— 三处必须是同一句话，
 * 不然玩家在 A 处看到"双属性"、B 处看到"2 种属性"会以为是两回事。
 */
export function levelElementHint(levelId: number): string {
    return '本关怪物属性　' + levelElementDesc(levelId);
}

/**
 * 当前出战武器打这一关的总体倍率表。
 * 结算页与调试面板用：让玩家看得见"这一局我打对了多少"。
 */
export function matchupOf(weaponEls: ElementId[], levelId: number, breakPct = 0): number[] {
    const levelEls = elementsForLevel(levelId);
    const out: number[] = [];
    for (let i = 0; i < levelEls.length; i++) {
        out.push(elementDamageMul(weaponEls, levelEls[i], breakPct));
    }
    return out;
}

/**
 * 属性克制速查表（锻造台"查看全部相性"用）。
 * 按属性分组输出，每行"属性：克哪些 / 被哪些克"。
 */
export function elementRelationText(): string[] {
    const lines: string[] = [];
    for (let i = 0; i < ELEMENT_IDS.length; i++) {
        const e = ELEMENT_IDS[i];
        const cs = countersOf(e);
        const rs = resistedBy(e);
        lines.push(elementName(e) + '　克 ' +
            (cs.length ? cs.map(elementName).join('、') : '无') +
            '　被克 ' + (rs.length ? rs.map(elementName).join('、') : '无'));
    }
    return lines;
}