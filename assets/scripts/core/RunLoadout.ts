/**
 * 局内槽位与 build 管理 —— 唯一允许改 RunLoadoutState 的地方
 *
 * 【三条核心规则，全部来自玩家需求】
 *
 *   1. 升级型进化不消耗槽位
 *      "如果升级成功然后进化 可以武器和辅助装备, 这种就不会消失辅助装备"
 *      → applyEvolve() 只改 formId，不动数组长度
 *
 *   2. 合成型进化消耗一个武器槽
 *      "如果进化是两个武器合成的进化会消失其中一个武器格子"
 *      → applyFusion() 把两件并成一件，数组长度 -1
 *
 *   3. 合成后可以再选一件武器补回来
 *      "可以再选一个武器"
 *      → pendingPicks +1，下一次三选一强制优先给新武器
 *
 * 【为什么经验要"扣除门槛"而不是"清零"】
 *
 *   如果进化后把 exp 归零，玩家在一局里能推到的深度完全由击杀数决定，
 *   打得好也快不了 —— 因为每层都从头攒。
 *   改为扣除当前层门槛后，溢出经验会带到下一层，
 *   于是"清怪快"这件事能直接换成"进化深"，这才是刷分的意义。
 */

import {
    EquipRunState, EvolutionEvent, RewardOption, RunLoadoutState, SlotKind,
} from '../data/GameTypes';
import {
    depthExpNeed, getForm, getRootOf, legacyFormId, requireForm, getEvolveOptions,
    formLevelOf, FORM_LV_ATK_PCT,
} from '../data/FormConfig';
import { MAX_RUN_LEVEL, levelExpFor, WEAPON_UPGRADES_REQUIRED, WEAPON_UPGRADE_ATK_PCT } from '../data/RunConfig';
import { getTalentDef } from '../data/TalentConfig';
import { resolveFormId, weaponUpgradeCount, isReadyToEvolve, findFusions, readyEvolutions } from './FormGraph';

/** 旧档不凭培养经验补算强化；保留形态与奖励次数，重建旧规则面板。 */
export function migrateWeaponUpgrades(lo: RunLoadoutState): void {
    for (const w of lo.weapons) w.upgrades = weaponUpgradeCount(w);
    if (lo.weaponUpgradeVersion === 1) return;
    lo.pending = [];
    lo.weaponUpgradeVersion = 1;
}

/** 新建一个空的局内 build */
export function emptyLoadout(): RunLoadoutState {
    return {
        weapons: [], auxes: [], talents: {},
        level: 1, pendingExp: 0, pendingPicks: 0, pending: [], pendingLevelUps: [], rewardSequence: 0, expCurveVersion: 2, weaponUpgradeVersion: 1,
    };
}

/** 保留旧档等级、已攒进度比例、装备经验和未领取奖励，不因改曲线直接补发升级。 */
export function migrateExpCurve(lo: RunLoadoutState): void {
    if ((lo.expCurveVersion ?? 1) >= 2) return;
    const oldNeed = Math.round(70 * Math.pow(1.30, Math.max(0, lo.level - 1)));
    lo.pendingExp = Math.floor(Math.max(0, Math.min(1, lo.pendingExp / oldNeed)) * levelExpFor(lo.level));
    lo.expCurveVersion = 2;
}

/**
 * 创建本局的 build。
 *
 * @param equippedIds      玩家在局外选好的武器 id（决定初始武器线）
 * @param inheritedEquip   继承自档案的装备（含进化形态与经验）
 * @param inheritedTalents 继承自档案的天赋层数
 *
 * 继承时按"形态所属武器线"匹配，而不是按 id 精确匹配 ——
 * 因为存档里存的可能是合成形态（id 是材料第一件，formId 是 fus_*），
 * 精确匹配会让继承失效。
 */
export function createRunLoadout(
    equippedIds: string[],
    inheritedEquip?: EquipRunState[],
    inheritedTalents?: Record<string, number>
): RunLoadoutState {
    const lo = emptyLoadout();

    const findInherited = (equipId: string): EquipRunState | undefined => {
        if (!inheritedEquip) return undefined;
        for (const old of inheritedEquip) {
            if (old.kind === 'aux') continue;
            if (old.id === equipId) return old;
            // 老档案是合成形态：它的 sources 里含这件武器
            const f = getForm(resolveFormId(old));
            if (f && f.sources.indexOf(equipId) >= 0) return old;
        }
        return undefined;
    };

    for (const id of equippedIds) {
        const root = getForm(id);
        if (!root || root.kind !== 'weapon') continue;
        const old = findInherited(id);
        if (old) {
            const formId = resolveFormId(old);
            const form = requireForm(formId);
            lo.weapons.push({
                id: form.sources.length > 0 ? form.sources[0] : id,
                formId: form.id,
                kind: 'weapon',
                stage: form.depth,
                exp: Math.max(0, Math.floor(old.exp)),
                upgrades: weaponUpgradeCount(old),
                evolvedUpgradeAtkPct: Math.max(0, old.evolvedUpgradeAtkPct || 0),
            });
        } else {
            lo.weapons.push({
                id, formId: id, kind: 'weapon', stage: 0, exp: 0,
            });
        }
    }

    if (inheritedEquip) {
        for (const old of inheritedEquip) {
            if (old.kind !== 'aux') continue;
            const formId = resolveFormId(old);
            const form = getForm(formId);
            if (!form) continue;
            lo.auxes.push({
                id: old.id || formId,
                formId: form.id,
                kind: 'aux',
                stage: form.depth,
                exp: Math.max(0, Math.floor(old.exp)),
            });
        }
    }

    if (inheritedTalents) {
        for (const k of Object.keys(inheritedTalents)) {
            const def = getTalentDef(k);
            if (!def) continue;
            const n = Math.max(0, Math.min(def.maxStacks, Math.floor(inheritedTalents[k])));
            if (n > 0) lo.talents[k] = n;
        }
    }

    return lo;
}

// ====================================================================
// 经验与升级
// ====================================================================

/**
 * 发放经验。
 *
 * 经验投放到两条独立预算的曲线：
 *   关卡等级 —— 用来触发三选一（节奏由它控制）
 *   装备形态 —— 用来决定哪些槽可以进化（深度由它控制）
 *
 * @param amount 已乘过经验加成之后的值
 * @returns 本次升了几级；每级奖励写入队列，由流程层依次展示。
 */
export function gainExp(lo: RunLoadoutState, amount: number, formAmount = amount): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (!lo.pendingLevelUps) lo.pendingLevelUps = [];

    const formExp = Number.isFinite(formAmount) ? Math.max(0, formAmount) : 0;
    for (const w of lo.weapons) w.exp = Number((w.exp + formExp).toFixed(6));
    for (const a of lo.auxes) a.exp = Number((a.exp + formExp).toFixed(6));

    lo.pendingExp = Number((lo.pendingExp + amount).toFixed(6));
    let ups = 0;
    while (lo.level < MAX_RUN_LEVEL && lo.pendingExp >= levelExpFor(lo.level)) {
        lo.pendingExp -= levelExpFor(lo.level);
        lo.level += 1;
        lo.pendingLevelUps.push(lo.level);
        ups += 1;
    }
    return ups;
}

/** 距离下一级还差多少经验 */
export function expToNextLevel(lo: RunLoadoutState): number {
    return Math.max(0, levelExpFor(lo.level) - lo.pendingExp);
}

/** 当前等级内的进度 0~1，给 HUD 画经验条 */
export function levelProgress(lo: RunLoadoutState): number {
    const need = levelExpFor(lo.level);
    if (need <= 0) return 0;
    return Math.max(0, Math.min(1, lo.pendingExp / need));
}

// ====================================================================
// 应用三选一的结果
// ====================================================================

export interface ApplyResult {
    ok: boolean;
    /** 发生的进化事件，UI 播特效 */
    event?: EvolutionEvent;
    /** 是否消耗了一个武器槽 */
    consumedSlot: boolean;
    /** 是否释放出待补选名额 */
    openedPick: boolean;
    /** 给玩家看的一句话 */
    message: string;
}

function fail(message: string): ApplyResult {
    return { ok: false, consumedSlot: false, openedPick: false, message };
}

/** 形态等级带来的攻击加成（1~3 级，每级 +10%） */
export function formLevelAtkPct(exp: number): number {
    return (formLevelOf(exp) - 1) * FORM_LV_ATK_PCT;
}

/** 进化后把溢出的经验带到下一层（见文件头注释） */
function carryExpOver(exp: number, fromDepth: number): number {
    return Math.max(0, Math.floor(exp - depthExpNeed(fromDepth)));
}

/**
 * 应用一张卡的收益。
 *
 * 所有分支都必须先做**边界校验**再改状态：
 * 候选是从池子里生成的，但玩家点击与状态变化之间可能隔了一次网络/一帧，
 * 校验一次的成本极低，而"槽位越界写进 undefined"是线上最难查的那类崩溃。
 */
export function applyReward(
    lo: RunLoadoutState,
    opt: RewardOption,
    caps: { weaponCap: number; auxCap: number; allowAdvanced?: boolean }
): ApplyResult {
    switch (opt.kind) {
        case 'weapon_new':
            return applyWeaponNew(lo, opt, caps.weaponCap);
        case 'weapon_evolve':
            return applyEvolve(lo, opt, 'weapon', caps.allowAdvanced ?? false);
        case 'weapon_upgrade': {
            const slot = lo.weapons[opt.slotIndex];
            if (!slot || resolveFormId(slot) !== opt.formId) return fail('武器已改变');
            if (weaponUpgradeCount(slot) >= WEAPON_UPGRADES_REQUIRED) return fail('当前武器已强化五次');
            slot.upgrades = weaponUpgradeCount(slot) + 1;
            lo.pending = [];
            return { ok: true, consumedSlot: false, openedPick: false, message: '武器强化 ' + slot.upgrades + '/5' };
        }
        case 'weapon_fusion':
            return applyFusion(lo, opt, caps.allowAdvanced ?? false);
        case 'aux_new':
            return applyAuxNew(lo, opt, caps.auxCap);
        case 'aux_evolve':
            return applyEvolve(lo, opt, 'aux', caps.allowAdvanced ?? false);
        case 'talent':
            return applyTalent(lo, opt);
        default:
            return fail('未知的奖励类型');
    }
}

function applyWeaponNew(lo: RunLoadoutState, opt: RewardOption, cap: number): ApplyResult {
    const formId = opt.formId;
    if (!formId) return fail('缺少形态');
    const form = getForm(formId);
    if (!form || form.kind !== 'weapon') return fail('不是武器形态');
    if (form.depth !== 0) return fail('新武器必须从基础形态获得');
    if (lo.weapons.length >= cap) return fail('武器槽已满');

    lo.weapons.push({
        id: form.sources.length > 0 ? form.sources[0] : form.id,
        formId: form.id, kind: 'weapon', stage: form.depth, exp: 0,
    });
    if (lo.pendingPicks > 0) lo.pendingPicks -= 1;
    lo.pending = [];
    return {
        ok: true, consumedSlot: false, openedPick: false,
        message: '获得新武器：' + form.name,
    };
}

function applyAuxNew(lo: RunLoadoutState, opt: RewardOption, cap: number): ApplyResult {
    const formId = opt.formId;
    if (!formId) return fail('缺少形态');
    const form = getForm(formId);
    if (!form || form.kind !== 'aux') return fail('不是辅助装备');
    if (lo.auxes.length >= cap) return fail('辅助槽已满');

    lo.auxes.push({
        id: form.id, formId: form.id, kind: 'aux', stage: form.depth, exp: 0,
    });
    lo.pending = [];
    return {
        ok: true, consumedSlot: false, openedPick: false,
        message: '获得辅助装备：' + form.name,
    };
}

/**
 * 升级型进化 —— **不消耗槽位**。
 *
 * 武器与辅助装备走同一条代码路径，因为规则完全一样：
 * 只换形态，数组长度不变。这也是"辅助装备不会消失"的实现保证。
 */
function applyEvolve(lo: RunLoadoutState, opt: RewardOption, kind: SlotKind, allowAdvanced: boolean): ApplyResult {
    const target = opt.formId ? getForm(opt.formId) : null;
    if (!target || target.kind !== kind) return fail('不是可用的进化形态');

    const arr = kind === 'weapon' ? lo.weapons : lo.auxes;
    const idx = opt.slotIndex;
    if (idx < 0 || idx >= arr.length) return fail('槽位索引越界');

    const slot = arr[idx];
    const fromId = resolveFormId(slot);
    const from = getForm(fromId);
    if (!from) return fail('原形态不存在');
    if (from.id === target.id) return fail('已经是该形态');
    if (!getEvolveOptions(from.id, allowAdvanced).some(e => e.type === 'upgrade' && e.to === target.id)) return fail('不是当前形态的进化路线');
    if (!isReadyToEvolve(slot, lo)) return fail(kind === 'weapon' ? '需要强化五次并持有配套辅助装备' : '辅助培养经验不足');

    slot.formId = target.id;
    slot.stage = target.depth;
    slot.exp = carryExpOver(slot.exp, from.depth);
    if (kind === 'weapon') {
        slot.evolvedUpgradeAtkPct = (slot.evolvedUpgradeAtkPct || 0) + weaponUpgradeCount(slot) * WEAPON_UPGRADE_ATK_PCT;
        slot.upgrades = 0;
    }

    const ev: EvolutionEvent = {
        slotIndex: idx, kind,
        equipName: '',
        fromFormId: from.id, toFormId: target.id,
        fromName: from.name, toName: target.name,
        type: 'upgrade',
        atkPct: target.atkPct,
        attackModeText: target.attackModeText,
    };
    lo.pending = [];
    return {
        ok: true, consumedSlot: false, openedPick: false, event: ev,
        message: from.name + ' → ' + target.name,
    };
}

/**
 * 合成型进化 —— 消耗一个武器槽。
 *
 * 合并后：
 *   - 产物槽保留在 A 的位置，基础伤害吃两份（sources 是两件材料的并集）
 *   - B 槽被删除
 *   - pendingPicks +1，下一次三选一强制给新武器候选
 */
function applyFusion(lo: RunLoadoutState, opt: RewardOption, allowAdvanced: boolean): ApplyResult {
    const target = opt.formId ? getForm(opt.formId) : null;
    if (!target || target.kind !== 'weapon') return fail('不是武器形态');

    const ia = opt.slotIndex;
    if (ia < 0 || ia >= lo.weapons.length) return fail('槽位索引越界');

    // 用形态 id 找第二件材料，而不是靠索引 —— 上一轮的选择可能已经改变了顺序
    let ib = -1;
    for (let i = 0; i < lo.weapons.length; i++) {
        if (i === ia) continue;
        if (resolveFormId(lo.weapons[i]) === opt.needFormId) { ib = i; break; }
    }
    if (ib < 0) return fail('缺少合成所需的另一件武器');

    const slotA = lo.weapons[ia];
    const slotB = lo.weapons[ib];
    const fromA = getForm(resolveFormId(slotA));
    const fromB = getForm(resolveFormId(slotB));
    if (!fromA || !fromB) return fail('材料形态不存在');
    if (!findFusions(lo, allowAdvanced).some(m => m.recipe.to === target.id &&
        ((m.indexA === ia && m.indexB === ib) || (m.indexA === ib && m.indexB === ia)))) return fail('合成条件未满足：双方需强化五次并持有配套辅助');

    const leftOver = Math.min(carryExpOver(slotA.exp, fromA.depth), carryExpOver(slotB.exp, fromB.depth));

    slotA.formId = target.id;
    slotA.stage = target.depth;
    slotA.id = target.sources.length > 0 ? target.sources[0] : slotA.id;
    slotA.exp = leftOver;
    slotA.evolvedUpgradeAtkPct = Math.max(
        (slotA.evolvedUpgradeAtkPct || 0) + weaponUpgradeCount(slotA) * WEAPON_UPGRADE_ATK_PCT,
        (slotB.evolvedUpgradeAtkPct || 0) + weaponUpgradeCount(slotB) * WEAPON_UPGRADE_ATK_PCT);
    slotA.upgrades = 0;

    // 先删较大的下标，避免删除后下标失效
    lo.weapons.splice(ib, 1);
    lo.pendingPicks += 1;
    lo.pending = [];

    const ev: EvolutionEvent = {
        slotIndex: ia, kind: 'weapon',
        equipName: fromA.name,
        fromFormId: fromA.id, toFormId: target.id,
        fromName: fromA.name, toName: target.name,
        type: 'fusion',
        consumedName: fromB.name,
        atkPct: target.atkPct,
        attackModeText: target.attackModeText,
    };
    return {
        ok: true, consumedSlot: true, openedPick: true, event: ev,
        message: fromA.name + ' + ' + fromB.name + ' → ' + target.name + '（消耗 1 个武器槽，可再选一件武器）',
    };
}

function applyTalent(lo: RunLoadoutState, opt: RewardOption): ApplyResult {
    const id = opt.talentId;
    if (!id) return fail('缺少天赋 id');
    const def = getTalentDef(id);
    if (!def) return fail('天赋不存在');
    const cur = lo.talents[id] || 0;
    if (cur >= def.maxStacks) return fail('天赋已满层');

    lo.talents[id] = cur + 1;
    lo.pending = [];
    return {
        ok: true, consumedSlot: false, openedPick: false,
        message: def.name + ' 第 ' + (cur + 1) + ' 层',
    };
}

// ====================================================================
// 便捷查询
// ====================================================================

/** 当前持有的装备总件数（武器 + 辅助），成就判定用 */
export function totalSlotCount(lo: RunLoadoutState): number {
    return lo.weapons.length + lo.auxes.length;
}

/** 某个形态是否已在手上（含作为合成材料） */
export function hasForm(lo: RunLoadoutState, formId: string): boolean {
    for (const w of lo.weapons) {
        if (resolveFormId(w) === formId) return true;
    }
    for (const a of lo.auxes) {
        if (resolveFormId(a) === formId) return true;
    }
    return false;
}

/** 该形态 line 的根局外装备 id */
export function rootOfSlot(st: EquipRunState): string {
    return getRootOf(resolveFormId(st));
}

/** 把槽位列表转成可入档的精简结构 */
export function toArchiveStates(lo: RunLoadoutState): EquipRunState[] {
    const out: EquipRunState[] = [];
    const push = (st: EquipRunState) => {
        out.push({
            id: st.id,
            formId: resolveFormId(st),
            kind: st.kind,
            stage: st.stage,
            exp: Math.max(0, Math.floor(st.exp)),
            upgrades: st.kind === 'weapon' ? weaponUpgradeCount(st) : undefined,
            evolvedUpgradeAtkPct: st.evolvedUpgradeAtkPct,
        });
    };
    for (const w of lo.weapons) push(w);
    for (const a of lo.auxes) push(a);
    return out;
}

/**
 * 该槽位是否已经攒够经验、手上有可走的进化路线。
 * UI 用它给槽位画一个高亮圆点，让玩家一眼看到"这个可以进化了"。
 */
export function slotHasOpenEvolve(lo: RunLoadoutState, index: number, kind: SlotKind): boolean {
    const arr = kind === 'weapon' ? lo.weapons : lo.auxes;
    const st = arr[index];
    if (!st) return false;
    const f = getForm(resolveFormId(st));
    if (!f) return false;
    if (f.evolveTo.length === 0) return false;
    return readyEvolutions(lo, false).some(m => m.kind === kind && m.slotIndex === index);
}

/** v2 老档案的 (id, stage) → formId，供迁移使用 */
export function legacyToFormId(equipId: string, stage: number): string {
    return legacyFormId(equipId, stage);
}
