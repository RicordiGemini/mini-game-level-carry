/**
 * 三选一候选生成 —— 局内成长的核心调度
 *
 * 【规则来源】
 *   玩家原话："在对局里面选武器或者选天赋以及选辅助装备都是固定三选一"
 *   所以这里恒产 REWARD_CHOICES（3）张卡，不多不少。
 *
 * 【候选池怎么凑出来】
 *
 *   每个类别各自出一个池子，池子内部按**优先级**排序：
 *
 *     -2  高级合成（复玩限定，最稀有）
 *     -1  常规合成（两件武器合一，最爽）
 *      0  进化（升级型，本轮的"主线收益"）
 *      1  新装备（扩充 build 的宽度）
 *      2  天赋（保底，永远有货）
 *
 *   然后按"主类别出 2 张、其他类别补 1 张"组装（见 RunConfig.rewardFocusFor）。
 *
 * 【为什么天赋必须放在池子里兜底】
 *
 *   如果只给武器和辅助装备，会出现这种情况：槽位满了、没到进化条件、
 *   也没有能合成的一对 → 三张卡全是空的，玩家点了升级却什么都没发生。
 *   天赋不受任何条件约束（不占槽位、可叠层），所以它保证了
 *   "只要还有没满层天赋，三选一就一定能凑齐三张"。
 *
 * 【合成的补选】
 *   合成会消耗一个武器槽，释放出的空位用 `pendingPicks` 记着。
 *   此时强制优先给"新武器"候选，让玩家把空位填回来 ——
 *   这就是玩家说的"会消失其中一个武器格子, 可以再选一个武器"。
 */

import {
    EquipRunState, RewardOption, RunLoadoutState,
} from '../data/GameTypes';
import {
    formLabel, getForm, getRootOf, isFusionOnly, WEAPON_ROOT_IDS,
} from '../data/FormConfig';
import { AUX_ROOT_IDS } from '../data/AuxConfig';
import { getEquipDef, EQUIP_TYPE_TEXT } from '../data/EquipmentConfig';
import { AuxEffect } from '../data/GameTypes';
import { TALENT_TABLE, talentSubtitle } from '../data/TalentConfig';
import { FOCUS_TAKE, REWARD_CHOICES, RewardFocus, rewardFocusFor } from '../data/RunConfig';
import { findFusions, readyEvolutions, resolveFormId } from './FormGraph';

/** 生成候选所需的全部输入 */
export interface RewardContext {
    loadout: RunLoadoutState;
    /**
     * 是否携带老档（复玩继承）进来。
     * 它是 advanced 进化边是否出现的唯一开关 —— 也就是"重复进入才有新进化路线"。
     */
    allowAdvanced: boolean;
    weaponCap: number;
    auxCap: number;
    /** 当前关卡等级，决定主类别轮转 */
    level: number;
    /**
     * 已解锁的武器根 id。
     *
     * 【第七轮起这个字段不再决定候选池】
     * 候选池改成WEAPON_ROOT_IDS 全池（见 weaponPool 里的注释），
     * 所以这个字段现在只是留作调用方的上下文信息。
     * 保留它而不是删掉，是为了不破坏 RewardContext 的形状 ——
     * 未来如果要做"局内只给局外收藏"的模式，开关只需要改一处。
     */
    ownedEquipIds: string[];
    /** 已见过的形态，优先推荐没见过的，帮助玩家推进图鉴 */
    seenForms: string[];
    /** 确定性随机源。传同一个种子，候选完全可复现（写测试用） */
    rng: () => number;
}

/** 把效果结构翻译成给玩家看的一句话 */
export function describeEffect(e?: AuxEffect): string {
    if (!e) return '';
    const parts: string[] = [];
    const pct = (v: number) => Math.round(v * 100) + '%';
    if (e.atkPct) parts.push('攻击 +' + pct(e.atkPct));
    if (e.atkSpeedPct) parts.push('攻速 +' + pct(e.atkSpeedPct));
    if (e.critRate) parts.push('暴击 +' + pct(e.critRate));
    if (e.critMul) parts.push('暴伤 ×' + e.critMul.toFixed(1));
    if (e.lifesteal) parts.push('吸血 ' + pct(e.lifesteal));
    if (e.moveSpeedPct) parts.push('移速 +' + pct(e.moveSpeedPct));
    if (e.maxHpFlat) parts.push('生命 +' + e.maxHpFlat);
    if (e.shield) parts.push('护盾 +' + e.shield);
    if (e.expPct) parts.push('经验 +' + pct(e.expPct));
    if (e.thorns) parts.push('反伤 +' + e.thorns);
    if (e.rangePct) parts.push('射程 +' + pct(e.rangePct));
    if (e.extraShots) parts.push('弹道 +' + e.extraShots);
    return parts.join(' · ');
}

/** 形态层级 → 卡牌品质 */
function depthRarity(depth: number): number {
    if (depth >= 4) return 3;
    if (depth >= 3) return 2;
    if (depth >= 2) return 1;
    return 0;
}

/** Fisher-Yates，使用外部传入的 rng 保证可复现 */
function shuffle<T>(arr: T[], rng: () => number): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

/** 一个候选 + 它的排序优先级 */
interface Ranked {
    opt: RewardOption;
    priority: number;
}

/** 稳定排序：同优先级内保持 shuffle 过的顺序 */
function sortByPriority(list: Ranked[]): RewardOption[] {
    return list.slice().sort((x, y) => x.priority - y.priority).map((r) => r.opt);
}

// ====================================================================
// 池子构建
// ====================================================================

/** 该武器根是否已经在手上（按 sources 判定，合成形态也算） */
function hasWeaponRoot(loadout: RunLoadoutState, rootId: string): boolean {
    for (const w of loadout.weapons) {
        const f = getForm(resolveFormId(w));
        if (!f) continue;
        if (f.sources.indexOf(rootId) >= 0) return true;
        if (getRootOf(f.id) === rootId) return true;
    }
    return false;
}

/** 该辅助根是否已经在手上 */
function hasAuxRoot(loadout: RunLoadoutState, rootId: string): boolean {
    for (const a of loadout.auxes) {
        const id = resolveFormId(a);
        if (id === rootId || getRootOf(id) === rootId) return true;
    }
    return false;
}

function weaponPool(ctx: RewardContext): Ranked[] {
    const out: Ranked[] = [];
    const lo = ctx.loadout;

    // --- 合成：优先级最高 ---
    for (const m of findFusions(lo, ctx.allowAdvanced)) {
        const target = getForm(m.recipe.to);
        if (!target) continue;
        const aName = formLabel(resolveFormId(lo.weapons[m.indexA]));
        const bName = formLabel(resolveFormId(lo.weapons[m.indexB]));
        out.push({
            priority: m.recipe.advanced ? -2 : -1,
            opt: {
                kind: 'weapon_fusion',
                key: 'wfus:' + m.recipe.a + '+' + m.recipe.b,
                title: target.name,
                subtitle: m.recipe.advanced ? '高级合成 · 消耗 1 个武器槽' : '合成 · 消耗 1 个武器槽',
                desc: m.recipe.desc + '（' + aName + ' + ' + bName + '）',
                rarity: depthRarity(target.depth),
                formId: target.id,
                slotIndex: m.indexA,
                needFormId: resolveFormId(lo.weapons[m.indexB]),
                needName: bName,
                consumesSlot: true,
                advanced: m.recipe.advanced,
            },
        });
    }

    // --- 升级型进化 ---
    for (const m of readyEvolutions(lo, ctx.allowAdvanced)) {
        if (m.kind !== 'weapon') continue;
        const target = getForm(m.edge.to);
        if (!target) continue;
        const from = getForm(m.fromFormId);
        out.push({
            priority: m.edge.advanced ? -2 : 0,
            opt: {
                kind: 'weapon_evolve',
                key: 'wevo:' + m.slotIndex + ':' + m.edge.to,
                title: target.name,
                subtitle: (m.edge.advanced ? '高级进化 · ' : '进化 · ') + (from ? from.name : ''),
                desc: m.edge.desc,
                rarity: depthRarity(target.depth),
                formId: target.id,
                slotIndex: m.slotIndex,
                advanced: m.edge.advanced,
            },
        });
    }

    // --- 新武器：只在有空槽时出现 ---
    if (lo.weapons.length < ctx.weaponCap) {
        const fresh: string[] = [];
        // 【第七轮：候选池从"局外已解锁"改成"全部武器线"】
        //
        // 玩家需求"对局内可以抽到所有武器"。
        // 之前这里遍历 ctx.ownedEquipIds（局外收藏），意味着
        // 没抽到过的武器在局内根本不会出现 —— 抽卡会变成局内玩法的瓶颈：
        // 玩家必须先在主界面抽到枪，才可能在局内三选一里看到枪。
        //
        // 现在直接用 WEAPON_ROOT_IDS 全池，让"局内抽到所有武器"真正成立。
        // 代价是：局内可能抽到一把局外没有的武器。
        // 这**不是问题**，因为局内武器的基础伤害按 EquipmentManager.baseDamageOf
        // 查局外等级 —— 没抽到就是 1 级，伤害很低。
        // 也就是说局内抽到陌生武器 = "试用一把一级武器"，
        // 它提供了 build 的宽度（多一种攻击形状），但不提供数值碾压。
        // 想要它变强，仍然得回主界面抽卡 + 锻造 —— 两层激励各司其职。
        for (const id of WEAPON_ROOT_IDS) {
            if (hasWeaponRoot(lo, id)) continue;
            fresh.push(id);
        }
        // 没见过的优先 —— 帮玩家把图鉴点开，比重复推荐已有的更有价值
        fresh.sort((a, b) => {
            const sa = ctx.seenForms.indexOf(a) >= 0 ? 1 : 0;
            const sb = ctx.seenForms.indexOf(b) >= 0 ? 1 : 0;
            return sa - sb;
        });
        for (const id of fresh) {
            const def = getEquipDef(id);
            const root = getForm(id);
            if (!def || !root) continue;
            out.push({
                priority: 1,
                opt: {
                    kind: 'weapon_new',
                    key: 'wnew:' + id,
                    title: def.name,
                    subtitle: '新武器 · ' + (EQUIP_TYPE_TEXT[def.type] || '') + ' · 占 1 个武器槽',
                    desc: def.desc,
                    rarity: 0,
                    formId: id,
                    slotIndex: -1,
                },
            });
        }
    }

    return out;
}

function auxPool(ctx: RewardContext): Ranked[] {
    const out: Ranked[] = [];
    const lo = ctx.loadout;

    for (const m of readyEvolutions(lo, ctx.allowAdvanced)) {
        if (m.kind !== 'aux') continue;
        const target = getForm(m.edge.to);
        if (!target) continue;
        const from = getForm(m.fromFormId);
        out.push({
            priority: 0,
            opt: {
                kind: 'aux_evolve',
                key: 'aevo:' + m.slotIndex + ':' + m.edge.to,
                title: target.name,
                subtitle: '辅助进化 · 不占槽位' + (from ? ' · ' + from.name : ''),
                desc: m.edge.desc + (target.effect ? '（' + describeEffect(target.effect) + '）' : ''),
                rarity: depthRarity(target.depth),
                formId: target.id,
                slotIndex: m.slotIndex,
            },
        });
    }

    if (lo.auxes.length < ctx.auxCap) {
        for (const id of AUX_ROOT_IDS) {
            if (hasAuxRoot(lo, id)) continue;
            const root = getForm(id);
            if (!root) continue;
            out.push({
                priority: 1,
                opt: {
                    kind: 'aux_new',
                    key: 'anew:' + id,
                    title: root.name,
                    subtitle: '新辅助 · 占 1 个辅助槽',
                    desc: root.desc + (root.effect ? '（' + describeEffect(root.effect) + '）' : ''),
                    rarity: 0,
                    formId: id,
                    slotIndex: -1,
                },
            });
        }
    }

    return out;
}

function talentPool(ctx: RewardContext): Ranked[] {
    const out: Ranked[] = [];
    const stacks = ctx.loadout.talents || {};
    for (const t of TALENT_TABLE) {
        const cur = stacks[t.id] || 0;
        if (cur >= t.maxStacks) continue;
        out.push({
            priority: 2 + t.rarity * 0.1,
            opt: {
                kind: 'talent',
                key: 'tal:' + t.id,
                title: t.name,
                subtitle: talentSubtitle(t, cur) + ' · 不占槽位',
                desc: t.desc + (t.perStackText ? '（每层 ' + t.perStackText + '）' : ''),
                rarity: t.rarity,
                talentId: t.id,
                slotIndex: -1,
            },
        });
    }
    return out;
}

// ====================================================================
// 主入口
// ====================================================================

/**
 * 生成一次三选一。
 *
 * @returns 最多 REWARD_CHOICES 张卡。返回空数组表示确实无卡可发
 *          （所有天赋满层 + 槽位满 + 无进化 + 无合成），
 *          调用方应当跳过本次三选一而不是弹一个空面板。
 */
export function pickRewards(ctx: RewardContext): RewardOption[] {
    // 合成之后释放了槽位 → 强制优先补选武器
    if (ctx.loadout.pendingPicks > 0) {
        const refill = sortByPriority(shuffle(weaponPool(ctx), ctx.rng))
            .filter((o) => o.kind === 'weapon_new' || o.kind === 'weapon_fusion');
        const picked: RewardOption[] = refill.slice(0, REWARD_CHOICES);
        if (picked.length >= REWARD_CHOICES) return picked;
        // 补不满就用通用逻辑补齐，保证屏幕不会出现少于 3 张的情况
        const extra = pickMixed(ctx, picked.length);
        return dedupe(picked.concat(extra)).slice(0, REWARD_CHOICES);
    }
    return pickMixed(ctx, REWARD_CHOICES);
}

/** 按主类别配额组装候选 */
function pickMixed(ctx: RewardContext, need: number): RewardOption[] {
    const focus: RewardFocus = rewardFocusFor(ctx.level);
    const pools: Record<RewardFocus, Ranked[]> = {
        weapon: shuffle(weaponPool(ctx), ctx.rng),
        aux: shuffle(auxPool(ctx), ctx.rng),
        talent: shuffle(talentPool(ctx), ctx.rng),
    };

    const order: RewardFocus[] = [focus];
    for (const k of ['weapon', 'talent', 'aux'] as RewardFocus[]) {
        if (k !== focus) order.push(k);
    }

    const picked: RewardOption[] = [];

    // 1. 主类别先出 FOCUS_TAKE 张
    for (const o of sortByPriority(pools[focus])) {
        if (picked.length >= FOCUS_TAKE) break;
        picked.push(o);
    }

    /**
     * 2. 不足 need 张时，按顺序从**其他类别**补齐。
     *
     * 这里必须跳过主类别 —— 不跳的话，主类别的池子往往远大于剩余名额
     * （比如手里 10 件新武器），补齐那一步会继续把主类别填满，
     * 于是"固定三选一"变成"固定三张同类卡"：玩家连着一局只看得到武器，
     * 天赋和辅助装备永远轮不到。跳过之后才是真正的"2 张主 + 1 张其他"。
     */
    for (const k of order) {
        if (picked.length >= need) break;
        if (k === focus) continue;
        for (const o of sortByPriority(pools[k])) {
            if (picked.length >= need) break;
            if (picked.some((p) => p.key === o.key)) continue;
            picked.push(o);
        }
    }

    // 3. 还没凑够（其他类别也空了）就再做一轮全池兜底，包括主类别 —— 保证凑满 3 张
    if (picked.length < need) {
        const all: Ranked[] = [];
        for (const k of order) all.push.apply(all, pools[k]);
        for (const o of sortByPriority(all)) {
            if (picked.length >= need) break;
            if (picked.some((p) => p.key === o.key)) continue;
            picked.push(o);
        }
    }

    return picked.slice(0, need);
}

function dedupe(list: RewardOption[]): RewardOption[] {
    const seen: string[] = [];
    const out: RewardOption[] = [];
    for (const o of list) {
        if (seen.indexOf(o.key) >= 0) continue;
        seen.push(o.key);
        out.push(o);
    }
    return out;
}

/** 该形态是否只能靠合成得到（UI 上给"合成限定"标记） */
export function isFusionTarget(formId: string): boolean {
    return isFusionOnly(formId);
}

/** 一次三选一里是否包含高级（复玩限定）选项 */
export function hasAdvancedOption(options: RewardOption[]): boolean {
    return options.some((o) => o.advanced === true);
}

/** 槽位使用情况的摘要文案 */
export function slotSummary(lo: RunLoadoutState, weaponCap: number, auxCap: number): string {
    return '武器 ' + lo.weapons.length + '/' + weaponCap +
        '　辅助 ' + lo.auxes.length + '/' + auxCap;
}

/** 给一个槽位状态生成展示名，UI 复用 */
export function describeSlot(st: EquipRunState): string {
    const f = getForm(resolveFormId(st));
    return f ? f.name : resolveFormId(st);
}
