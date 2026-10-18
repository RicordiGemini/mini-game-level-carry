/**
 * 形态图查询 —— 只读，不改状态
 *
 * 与 RunLoadout 的分工：
 *   FormGraph  回答"现在有什么可能性"（可进化什么、能不能合成、加成多少）
 *   RunLoadout 负责"把玩家的选择落到状态上"
 *
 * 这一层刻意保持纯函数：所有输入都从参数进来，不读 SaveManager。
 * 于是它可以在 Node 里用构造出来的 build 直接测试，不需要真存档。
 */

import {
    addEffect, AimModeId, CombatModifier, emptyModifier, EquipRunState,
    EvolutionEdge, FormNode, InnateBonus, RunLoadoutState, SlotKind,
} from '../data/GameTypes';
import {
    FUSION_RECIPES, FusionRecipe, depthExpNeed, formLevelOf,
    getAllEdges, getEvolveOptions, getForm, getRootForm, getRootOf, legacyFormId, requireForm,
} from '../data/FormConfig';
import { getTalentDef } from '../data/TalentConfig';
import { WEAPON_EVOLUTION_AUX, WEAPON_UPGRADES_REQUIRED } from '../data/RunConfig';

export function weaponUpgradeCount(st: EquipRunState): number {
    return Number.isFinite(st.upgrades) ? Math.max(0, Math.min(WEAPON_UPGRADES_REQUIRED, Math.floor(st.upgrades!))) : 0;
}

export function evolutionAuxIds(st: EquipRunState): string[] {
    const form = formOfState(st);
    return [...new Set((form.sources.length ? form.sources : [getRootOf(form.id)])
        .map(id => WEAPON_EVOLUTION_AUX[id]).filter((id): id is string => !!id))];
}

export function hasEvolutionAux(loadout: RunLoadoutState, st: EquipRunState): boolean {
    const required = evolutionAuxIds(st);
    return required.length > 0 && required.every(id => loadout.auxes.some(a => getRootOf(resolveFormId(a)) === id));
}

export function weaponEvolutionHint(st: EquipRunState): string {
    return '强化 ' + weaponUpgradeCount(st) + '/' + WEAPON_UPGRADES_REQUIRED + ' · 需要 ' +
        (evolutionAuxIds(st).map(id => requireForm(id).name).join('、') || '配套辅助') + '（保留）';
}

/**
 * 取一个槽位当前真正的形态 id。
 *
 * 老档案（v2）只有 (装备 id, stage)，没有 formId，
 * 这里按"主线第一项"把 stage 反查成 formId，
 * 所以老玩家的存档能无缝接着玩，不需要额外迁移步骤。
 */
export function resolveFormId(st: EquipRunState): string {
    if (st.formId) return st.formId;
    return legacyFormId(st.id, st.stage);
}

/** 取槽位的形态节点 */
export function formOfState(st: EquipRunState): FormNode {
    return requireForm(resolveFormId(st));
}

/** 取槽位形态的名称（带所属武器线） */
export function formNameOfState(st: EquipRunState): string {
    return formOfState(st).name;
}

/**
 * 取一个形态实际生效的瞄准方式。
 *
 * 三级回退：形态自己配了 → 用；没配 → 沿用它所属武器线的根形态；
 * 根形态也没有（配置错误）→ 前向。绝不返回 undefined，
 * 否则战斗层会在收到方向向量时炸掉。
 */
export function aimOf(form: FormNode): AimModeId {
    if (form.aimModeId !== undefined) return form.aimModeId;
    const root = getRootForm(getRootOf(form.id));
    if (root && root.aimModeId !== undefined) return root.aimModeId;
    return AimModeId.FRONT;
}

/**
 * 武器需要当前形态五次强化及配套辅助；辅助自身仍按培养经验进化。
 */
export function isReadyToEvolve(st: EquipRunState, loadout?: RunLoadoutState): boolean {
    const form = formOfState(st);
    if (form.kind === 'weapon') return weaponUpgradeCount(st) >= WEAPON_UPGRADES_REQUIRED && !!loadout && hasEvolutionAux(loadout, st);
    return st.exp >= depthExpNeed(form.depth);
}

/** 距离可进化还差多少经验，已可进化返回 0 */
export function expToEvolve(st: EquipRunState): number {
    const form = formOfState(st);
    return Math.max(0, depthExpNeed(form.depth) - st.exp);
}

/** 该槽当前形态等级（1~3），用于展示与攻击加成 */
export function slotFormLevel(st: EquipRunState): number {
    return formLevelOf(st.exp);
}

// ====================================================================
// 进化候选
// ====================================================================

/** 一条可选的升级型进化 */
export interface EvolveMatch {
    slotIndex: number;
    kind: SlotKind;
    edge: EvolutionEdge;
    /** 产生这条候选的形态，UI 展示"XXX 可以进化" */
    fromFormId: string;
}

/**
 * 收集全部"升级型"进化候选（不消耗槽位）。
 * 合成型不在其中 —— 它需要两件同时在手，条件不同，见 findFusions。
 */
export function readyEvolutions(loadout: RunLoadoutState, allowAdvanced: boolean): EvolveMatch[] {
    const out: EvolveMatch[] = [];

    const scan = (arr: EquipRunState[], kind: SlotKind): void => {
        for (let i = 0; i < arr.length; i++) {
            const st = arr[i];
            if (!isReadyToEvolve(st, loadout)) continue;
            const formId = resolveFormId(st);
            for (const e of getEvolveOptions(formId, allowAdvanced)) {
                if (e.type === 'fusion') continue;
                out.push({ slotIndex: i, kind, edge: e, fromFormId: formId });
            }
        }
    };

    scan(loadout.weapons, 'weapon');
    scan(loadout.auxes, 'aux');
    return out;
}

/** 一次可执行的合成 */
export interface FusionMatch {
    recipe: FusionRecipe;
    /** 材料 A 在 weapons 里的下标 */
    indexA: number;
    /** 材料 B 在 weapons 里的下标 */
    indexB: number;
}

/**
 * 找出当前 build 能执行的合成。
 *
 * 三个必要条件：
 *   1. 配方可用（复玩限定配方需要 allowAdvanced）
 *   2. 两件材料都在手上
 *   3. 两件材料各自强化五次并持有各自配套辅助
 *
 * 第 3 条容易被忽略但很重要：如果只要凑齐两件就能合成，
 * 玩家会在开局第一波就合完，后面半局没有任何成长。
 */
export function findFusions(loadout: RunLoadoutState, allowAdvanced: boolean): FusionMatch[] {
    const out: FusionMatch[] = [];
    const ids: string[] = [];
    for (const w of loadout.weapons) ids.push(resolveFormId(w));

    for (const r of FUSION_RECIPES) {
        if (r.advanced && !allowAdvanced) continue;
        const ia = ids.indexOf(r.a);
        const ib = ids.indexOf(r.b);
        if (ia < 0 || ib < 0 || ia === ib) continue;
        if (!isReadyToEvolve(loadout.weapons[ia], loadout)) continue;
        if (!isReadyToEvolve(loadout.weapons[ib], loadout)) continue;
        out.push({ recipe: r, indexA: ia, indexB: ib });
    }
    return out;
}

// ====================================================================
// 战斗修正汇总
// ====================================================================

/**
 * 把辅助装备与天赋汇总成一份战斗修正。
 *
 * 战斗层只读这一个结构，不认识"天赋""辅助装备""形态"这些概念 ——
 * 于是加一件新辅助装备，只要在 AuxConfig 里写一行数据，
 * 战斗逻辑一行都不用改。
 *
 * 【第七轮新增：辅助局外阶数】
 *
 * @param auxRankMulOf 查某件辅助的加成倍率。
 *   做成**回调注入**而不是直接 import GachaManager，理由与
 *   "战斗层不认识属性表"是同一条工程约束：
 *   FormGraph 保持纯函数（所有输入从参数进来，不读存档），
 *   于是它仍然可以在 Node 里用构造出来的 build 完整测试。
 *   GachaManager 要读 SaveManager，直接 import 会把纯函数层污染掉。
 *
 *   传undefined 表示不启用升阶（默认值），这样既有的 116 项 evolution 测试
 *   不需要改任何一行调用就能继续按"1 阶 =原值"跑。
 *
 * 【第八轮新增：辅助品阶与自带属性】
 *
 * @param auxRarityMulOf 查某件辅助的**品阶强度倍率**。
 *   与 auxRankMulOf 是两个正交的轴，必须分开：
 *     rank   局外阶数 1~5，花金币升，放大已有 effect（第七轮）
 *     rarity 品阶 0~6，抽卡获得 + 消耗同阶装备升阶，提供第二份放大（第八轮）
 *   两者是**乘算**关系：一件 5 阶 + 神话品阶的辅助，
 *   效果是原值的 2.3（阶）× 2.6（品阶）= 5.98 倍。
 *
 * @param auxInnateOf 查某件辅助的自带复合属性（钻石及以上专属辅助才有）。
 *   与武器的 innate 同一条规则：装备天生就有、升阶自动继承、不需要材料。
 */
export function aggregateModifier(
    loadout: RunLoadoutState,
    auxRankMulOf?: (auxRootId: string) => number,
    auxRarityMulOf?: (auxRootId: string) => number,
    auxInnateOf?: (auxRootId: string) => InnateBonus | undefined
): CombatModifier {
    const mod = emptyModifier();

    // 辅助装备：effect 为主体，形态自带的 atkPct 也并入
    for (const a of loadout.auxes) {
        const f = formOfState(a);
        const rootId = getRootOf(f.id);
        const rankMul = auxRankMulOf ? auxRankMulOf(rootId) : 1;
        const rarityMul = auxRarityMulOf ? auxRarityMulOf(rootId) : 1;
        // 阶数与品阶是乘算：两条局外投资线互不替代
        const mul = rankMul * rarityMul;

        // 自带属性不参与倍率放大 —— 它的数值已在配置表里按品阶配好
        const innate = auxInnateOf ? auxInnateOf(rootId) : undefined;
        if (innate) addEffect(mod, innate);

        addEffect(mod, f.effect, mul);
        if (f.atkPct) addEffect(mod, { atkPct: f.atkPct });
    }

    // 天赋：按层数等比放大
    const talents = loadout.talents || {};
    for (const id of Object.keys(talents)) {
        const def = getTalentDef(id);
        if (!def) continue;
        addEffect(mod, def.effect, talents[id]);
    }

    return mod;
}

/** 当前持有的全部形态 id（图鉴记录用） */
export function allFormIdsOf(loadout: RunLoadoutState): string[] {
    const out: string[] = [];
    const push = (id: string) => {
        if (out.indexOf(id) < 0) out.push(id);
    };
    for (const w of loadout.weapons) push(resolveFormId(w));
    for (const a of loadout.auxes) push(resolveFormId(a));
    return out;
}

/** 当前 build 里最高的形态层级 */
export function maxDepthOf(loadout: RunLoadoutState): number {
    let max = 0;
    const scan = (arr: EquipRunState[]) => {
        for (const st of arr) {
            const f = getForm(resolveFormId(st));
            if (f && f.depth > max) max = f.depth;
        }
    };
    scan(loadout.weapons);
    scan(loadout.auxes);
    return max;
}

/**
 * 当前 build 涉及的全部局外武器 id。
 *
 * 用 sources 而不是根形态 id —— 玩家后期手里是"剑雨风暴"，
 * 它的 sources 是 [铁剑, 短弓]，所以关卡适配能正确识别出
 * "他其实带着铁剑和短弓"，合成不会让推荐加成失效。
 */
export function weaponRootsOf(loadout: RunLoadoutState): string[] {
    const out: string[] = [];
    const push = (id: string) => {
        if (out.indexOf(id) < 0) out.push(id);
    };
    for (const w of loadout.weapons) {
        const f = getForm(resolveFormId(w));
        if (!f) continue;
        if (f.sources.length > 0) {
            for (const s of f.sources) push(s);
        } else {
            push(getRootOf(f.id));
        }
    }
    return out;
}

/** 只读地看一眼某槽的形态，UI 用（不存在返回 null，不抛错） */
export function peekForm(st: EquipRunState): FormNode | null {
    return getForm(resolveFormId(st));
}

// ====================================================================
// 图鉴展示辅助（主界面"哪些武器能合成"直接读这几个）
// ====================================================================

/** 主线最大长度保护：配置若意外成环，展示层也不会死循环 */
const LINE_GUARD = 12;

/**
 * 一条武器线的**主线**形态 id 序列（含起点）。
 *
 * 约定"每个形态的 evolveTo 里第一条 upgrade 边是主线"，
 * 与 legacyFormId 的反查规则完全一致 —— 两处用同一个约定，
 * 才不会出现"存档迁移走的是 A 路线、图鉴画的却是 B 路线"。
 */
export function mainLineOf(formId: string): string[] {
    const out: string[] = [formId];
    let cur = formId;
    for (let i = 0; i < LINE_GUARD; i++) {
        const f = getForm(cur);
        if (!f) break;
        const main = f.evolveTo.filter((e) => e.type === 'upgrade')[0];
        if (!main) break;
        const nxt = getForm(main.to);
        if (!nxt) break;
        out.push(nxt.id);
        cur = nxt.id;
    }
    return out;
}

/**
 * 主线之外的**分支**形态（depth 1 有两条线的那些）。
 * 图鉴要把它们也画出来，否则玩家永远不知道自己错过了什么。
 */
export function branchesOf(formId: string): EvolutionEdge[] {
    const f = getForm(formId);
    if (!f) return [];
    return f.evolveTo.filter((e) => e.type === 'upgrade').slice(1);
}

/** 与给定形态集合相关的全部合成配方（任一材料命中即算） */
export function fusionsInvolving(formIds: string[]): FusionRecipe[] {
    const out: FusionRecipe[] = [];
    for (const r of FUSION_RECIPES) {
        if (formIds.indexOf(r.a) < 0 && formIds.indexOf(r.b) < 0) continue;
        if (out.indexOf(r) < 0) out.push(r);
    }
    return out;
}

/**
 * "复玩才出现的更上级进化" —— 主线上是否挂着 advanced 边。
 * 主界面用它给玩家一个明确的复玩理由。
 *
 * 注意扫描的是**整条主线**而不是只看末端节点：
 * advanced 边是从末端的**前一个**形态出发的（天罚剑 → 创世刃），
 * 只看末端会永远返回 null，于是"复玩有新路线"这件事在主界面上根本显示不出来。
 */
export function advancedTailOf(formId: string): EvolutionEdge | null {
    for (const id of mainLineOf(formId)) {
        for (const e of getAllEdges(id)) {
            if (e.advanced) return e;
        }
    }
    return null;
}
