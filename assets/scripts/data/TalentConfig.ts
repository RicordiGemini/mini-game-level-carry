/**
 * 天赋池配置
 *
 * 【天赋在三种局内成长里的位置】
 *
 *   武器     占武器槽，改"怎么打"，可以被合成消耗掉
 *   辅助装备 占辅助槽，改"多快多稳"
 *   天赋     **不占任何槽位**，改"基础体质"
 *
 * 天赋不占槽位这件事是刻意的：它是三选一里的**保底项**。
 * 抽到武器可能因为槽满而没用，抽到进化可能条件没到，
 * 但天赋永远能拿 —— 于是三选一永远不会出现"三个都点不了"的死屏。
 *
 * 【叠层设计】
 *   maxStacks > 1 的天赋可以反复拿，收益线性叠加；
 *   maxStacks = 1 的是唯一型（一次性的大收益），
 *   拿过之后就不再出现在候选池里。
 *
 * 单位数值刻意给得小（+6% 攻击 / 层），因为可以叠 6 层 —— 
 * 单层不痛不痒、叠满才见效，这样玩家会主动去规划要堆哪一条。
 */

import { AuxEffect, TalentDef } from './GameTypes';

function T(
    id: string,
    name: string,
    desc: string,
    rarity: number,
    maxStacks: number,
    group: string,
    effect: AuxEffect,
    perStackText: string
): TalentDef {
    return { id, name, desc, rarity, maxStacks, group, effect, perStackText };
}

export const TALENT_TABLE: TalentDef[] = [
    // ---------------------------------------------------------- 进攻
    T('t_power', '力量印记', '每一层都让攻击更扎实', 0, 6, '进攻',
        { atkPct: 0.06 }, '+6% 攻击'),
    T('t_swift', '疾击印记', '缩短攻击间隔，出手更密', 0, 6, '进攻',
        { atkSpeedPct: 0.06 }, '+6% 攻速'),
    T('t_crit', '锐利印记', '提高暴击发生率', 1, 5, '进攻',
        { critRate: 0.04 }, '+4% 暴击率'),
    T('t_critdmg', '破甲印记', '提高暴击伤害倍率', 1, 4, '进攻',
        { critMul: 0.15 }, '+0.15 暴击倍率'),
    T('t_range', '远击印记', '扩大攻击距离', 1, 5, '进攻',
        { rangePct: 0.08 }, '+8% 攻击距离'),
    T('t_multi', '分光印记', '每次攻击多发射一条弹道', 2, 2, '进攻',
        { extraShots: 1 }, '+1 弹道'),
    T('t_exec', '处决印记', '大幅提高攻击，但只在对的时机出现', 2, 3, '进攻',
        { atkPct: 0.12 }, '+12% 攻击'),
    T('t_frenzy', '狂乱印记', '极限攻速，适合高频武器', 2, 3, '进攻',
        { atkSpeedPct: 0.14 }, '+14% 攻速'),

    // ---------------------------------------------------------- 防御
    T('t_vital', '坚韧印记', '提高生命上限', 0, 6, '防御',
        { maxHpFlat: 40 }, '+40 生命上限'),
    T('t_ward', '守护印记', '开局获得护盾，优先抵挡伤害', 0, 5, '防御',
        { shield: 30 }, '+30 护盾'),
    T('t_thorn', '尖刺印记', '被近战击中时反弹伤害', 1, 5, '防御',
        { thorns: 8 }, '+8 反伤'),
    T('t_regen', '汲血印记', '造成伤害时按比例回血', 1, 5, '防御',
        { lifesteal: 0.025 }, '+2.5% 吸血'),
    T('t_bulwark', '磐石印记', '生命上限大幅提升', 2, 2, '防御',
        { maxHpFlat: 120 }, '+120 生命上限'),
    T('t_aegis', '圣佑印记', '获得一层厚实的护盾', 2, 3, '防御',
        { shield: 90 }, '+90 护盾'),

    // ---------------------------------------------------------- 机动
    T('t_stride', '步法印记', '提高移动速度，走位更从容', 0, 6, '机动',
        { moveSpeedPct: 0.05 }, '+5% 移速'),
    T('t_dash', '疾行印记', '显著提高移动速度', 1, 4, '机动',
        { moveSpeedPct: 0.08 }, '+8% 移速'),
    T('t_fleet', '迅影印记', '移速与射程兼顾，适合打游击', 1, 4, '机动',
        { moveSpeedPct: 0.06, rangePct: 0.04 }, '+6% 移速 · +4% 射程'),
    T('t_wind', '风步印记', '大幅提高移动速度', 2, 2, '机动',
        { moveSpeedPct: 0.12 }, '+12% 移速'),

    // ---------------------------------------------------------- 经济
    T('t_greed', '贪婪印记', '提高经验获取，更快触发三选一', 0, 5, '经济',
        { expPct: 0.10 }, '+10% 经验'),
    T('t_insight', '洞察印记', '显著提高经验获取', 1, 3, '经济',
        { expPct: 0.16 }, '+16% 经验'),
    T('t_fortune', '财富印记', '经验与攻击兼顾，滚雪球更稳', 1, 4, '经济',
        { expPct: 0.08, atkPct: 0.04 }, '+8% 经验 · +4% 攻击'),
];

/** 天赋 id → 定义 */
export function getTalentDef(id: string): TalentDef | null {
    for (const t of TALENT_TABLE) {
        if (t.id === id) return t;
    }
    return null;
}

/** 天赋池里所有可继续叠加的天赋 id（已达上限的不再出现） */
export function getAvailableTalentIds(stacks: Record<string, number>): string[] {
    const out: string[] = [];
    for (const t of TALENT_TABLE) {
        const cur = (stacks && stacks[t.id]) || 0;
        if (cur < t.maxStacks) out.push(t.id);
    }
    return out;
}

/** 天赋的展示副标题：唯一型 / 第几层 */
export function talentSubtitle(def: TalentDef, curStacks: number): string {
    if (def.maxStacks <= 1) return '唯一';
    return '第 ' + (curStacks + 1) + '/' + def.maxStacks + ' 层';
}

/** 全部天赋按分组归类，成就与图鉴面板用 */
export function talentGroups(): string[] {
    const seen: string[] = [];
    for (const t of TALENT_TABLE) {
        if (seen.indexOf(t.group) < 0) seen.push(t.group);
    }
    return seen;
}
