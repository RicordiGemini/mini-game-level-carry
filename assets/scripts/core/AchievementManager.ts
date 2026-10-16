/**
 * 成就管理器
 *
 * 【判定逻辑为什么做成纯函数】
 *
 *   `judgeAchievements(ctx)` 只读一个上下文快照，不碰存档、不碰运行时状态。
 *   这样成就的每条规则都能在 Node 里用构造出来的快照直接测：
 *   "无伤通关困难"这一条，测试只需要喂一个 tier=2 / noDamage=true 的 summary，
 *   不需要真的打一局然后检查自己有没有受伤。
 *
 * 【累计型与单局型的区分】
 *
 *   单局型（reachDepth / noDamageClear / formCountInRun / talentStacks）
 *     只看本局的 RunSummary
 *   累计型（killTotal / fusionCount / affinityClearCount / collectForms）
 *     看的是玩家档案里的累计值
 *   两类的判定都在这里，调用方先把本局的增量并入累计值，再统一判定。
 *
 * 【为什么解锁后要立刻发金币】
 *   金币是局外武器升级的唯一消耗品，成就发金币 = 成就直接变成战力。
 *   否则成就墙只是一个和玩法脱节的展示页，玩家没有动力去看。
 */

import { AchievementDef, AchievementRecord, PlayerProfile, RunSummary } from '../data/GameTypes';
import { ACHIEVE_ALL_FORMS, ACHIEVE_ALL_STONES, ACHIEVEMENT_TABLE } from '../data/AchievementConfig';
import { FORM_MAX_DEPTH } from '../data/FormConfig';
import { getArmorDef, allArmorPieces } from '../data/ArmorConfig';
import { ELEMENT_IDS } from '../data/ElementConfig';

/** 判定所需的全部输入 */
export interface AchievementContext {
    summary: RunSummary;
    /** 已累计的击杀（已并入本局） */
    killTotal: number;
    /** 已累计的合成次数（已并入本局） */
    fusionCount: number;
    /** 已累计的"用推荐武器通关"次数（已并入本局） */
    affinityClearCount: number;
    /** 图鉴已收录的形态数 */
    seenFormCount: number;
    /** 形态总数（用于 collectForms 的"全收集"判定） */
    totalFormCount: number;
    /** 已解锁的成就 id */
    unlockedIds: string[];
    /**
     * 全局档案。
     * 锻造类的成就（突破等阶、镶嵌数、拥有几件防具）都是**局外累计**的，
     * 只能从档案读 —— 单局的 RunSummary 里根本没有这些数据。
     */
    profile?: PlayerProfile;
    /** 累计合成过完整属性材料的次数 */
    craftStoneCount?: number;
    /** 全部防具的数量（用于 armorOwned 的"全收集"判定） */
    totalArmorCount?: number;
    /** 属性总数（用于 elementMasters 的"全收集"判定） */
    totalElementCount?: number;
}

/** 单条成就的进度展示 */
export interface AchievementProgress {
    def: AchievementDef;
    unlocked: boolean;
    /** 当前进度值 */
    cur: number;
    /** 目标值（-1 表示"全部"，此时显示为 total） */
    target: number;
    /** 进度百分比 0~1 */
    ratio: number;
}

/** 计算某条成就当前的进度值 */
function progressValue(def: AchievementDef, ctx: AchievementContext): number {
    const s = ctx.summary;
    switch (def.kind) {
        case 'clearLevel':
            return s.cleared ? s.levelId : 0;
        case 'clearTier':
            return s.cleared ? s.tier : 0;
        case 'noDamageClear':
            return s.cleared && s.noDamage ? s.tier : 0;
        case 'affinityClear':
            return ctx.affinityClearCount;
        case 'firstFusion':
        case 'fusionCount':
            return ctx.fusionCount;
        case 'collectForms':
            return ctx.seenFormCount;
        case 'reachDepth':
            return s.maxDepth;
        case 'boostClear':
            return s.cleared && s.boosted ? s.boostPercent : 0;
        case 'killTotal':
            return ctx.killTotal;
        case 'formCountInRun':
            return s.weaponCount + s.auxCount;
        case 'breakRank': {
            // 取玩家所有武器里的最高品阶（第八轮起由品阶替代原来的突破等阶）
            let max = 0;
            const eq = (ctx.profile && ctx.profile.equipment) || [];
            for (const e of eq) {
                const r = e.rarity === undefined ? 0 : e.rarity;
                if (r > max) max = r;
            }
            return max;
        }
        case 'socketCount': {
            // 单把武器镶嵌的属性数取最大值 —— 奖励"集中镶嵌"而不是"摊开"
            let max = 0;
            const eq = (ctx.profile && ctx.profile.equipment) || [];
            for (const e of eq) {
                const sk = e.forge ? e.forge.sockets || [] : [];
                let n = 0;
                for (const s of sk) if (s) n++;
                if (n > max) max = n;
            }
            return max;
        }
        case 'elementMasters': {
            const st = (ctx.profile && ctx.profile.stones) || {};
            let n = 0;
            for (const k of Object.keys(st)) {
                if (k.indexOf('stone_') === 0 && st[k] > 0) n++;
            }
            return n;
        }
        case 'craftStone':
            return ctx.craftStoneCount || 0;
        case 'armorOwned': {
            const ar = ctx.profile && ctx.profile.armor;
            return ar ? (ar.owned || []).length : 0;
        }
        case 'omniArmor': {
            // 第九轮：防具改为四部位套装模型，每件只抗 1 种元素，
            // 不再有「全属性抗性单件」。这里改为「集齐任意一整套（4 部位）防具」，
            // 既对应套装玩法，又保持成就可达成。
            const ar = ctx.profile && ctx.profile.armor;
            if (!ar) return 0;
            const owned = ar.owned || [];
            const bySet: Record<string, Set<string>> = {};
            for (const item of owned) {
                const id = typeof item === 'string' ? item : item.id;
                const a = getArmorDef(id);
                if (!a) continue;
                (bySet[a.setId] = bySet[a.setId] || new Set<string>()).add(a.part);
            }
            let complete = 0;
            for (const s of Object.keys(bySet)) {
                if (bySet[s].size >= 4) complete += 1;
            }
            return complete;
        }
        case 'elementCounter':
            // 累计型：档案里的总数 + 本局的
            return (ctx.profile ? ctx.profile.elementDamageTotal || 0 : 0) + (s.elementDamage || 0);
        case 'elementResist':
            return (ctx.profile ? ctx.profile.resistReducedTotal || 0 : 0) + (s.resistReduced || 0);
        case 'talentStacks': {
            let max = 0;
            const t = s.talents || {};
            for (const k of Object.keys(t)) {
                if (t[k] > max) max = t[k];
            }
            return max;
        }
        default:
            return 0;
    }
}

function targetValue(def: AchievementDef, ctx: AchievementContext): number {
    if (def.kind === 'collectForms' && def.target === ACHIEVE_ALL_FORMS) {
        return ctx.totalFormCount;
    }
    // "全部属性材料都合成过"与"全部防具都获得过"同样是全收集语义：
    // 写死数字的话，以后加属性 / 加防具就会让这条成就永远打不满。
    if (def.kind === 'elementMasters' && def.target === ACHIEVE_ALL_STONES) {
        return ctx.totalElementCount || ELEMENT_IDS.length;
    }
    if (def.kind === 'armorOwned' && def.target < 0) {
        return ctx.totalArmorCount || allArmorPieces().length;
    }
    return def.target;
}

/**
 * 判定本次有哪些成就应当解锁。
 *
 * 只返回**新**解锁的（已经在 unlockedIds 里的不再返回），
 * 所以调用方可以放心地每次通关都调一遍。
 */
export function judgeAchievements(ctx: AchievementContext): AchievementDef[] {
    const out: AchievementDef[] = [];
    for (const def of ACHIEVEMENT_TABLE) {
        if (ctx.unlockedIds.indexOf(def.id) >= 0) continue;

        const cur = progressValue(def, ctx);
        const target = targetValue(def, ctx);

        // reachDepth 是"达到"语义，target 就是形态层级上限，超过也应算达成
        if (def.kind === 'reachDepth') {
            if (cur >= target && target <= FORM_MAX_DEPTH) out.push(def);
            continue;
        }
        if (target <= 0) continue;
        if (cur >= target) out.push(def);
    }
    return out;
}

/** 全部成就的进度快照，成就面板遍历用 */
export function achievementProgress(ctx: AchievementContext): AchievementProgress[] {
    const out: AchievementProgress[] = [];
    for (const def of ACHIEVEMENT_TABLE) {
        const cur = progressValue(def, ctx);
        const target = Math.max(1, targetValue(def, ctx));
        out.push({
            def,
            unlocked: ctx.unlockedIds.indexOf(def.id) >= 0,
            cur: Math.min(cur, target),
            target,
            ratio: Math.max(0, Math.min(1, cur / target)),
        });
    }
    return out;
}

/** 进度摘要：已解锁 / 总数 / 已获得金币 */
export function achievementSummary(ctx: AchievementContext): string {
    let unlocked = 0;
    let gold = 0;
    let totalGold = 0;
    for (const def of ACHIEVEMENT_TABLE) {
        totalGold += def.gold;
        if (ctx.unlockedIds.indexOf(def.id) >= 0) {
            unlocked += 1;
            gold += def.gold;
        }
    }
    return '成就 ' + unlocked + '/' + ACHIEVEMENT_TABLE.length +
        '　已获得 ' + gold + '/' + totalGold + ' 金币';
}

/**
 * 从玩家档案构造判定上下文。
 *
 * @param extra 本局尚未写入档案的增量（击杀 / 合成 / 推荐通关次数）
 */
export function contextFromProfile(
    profile: PlayerProfile,
    summary: RunSummary,
    totalFormCount: number,
    extra?: { kills?: number; fusions?: number; affinityClears?: number }
): AchievementContext {
    const unlockedIds: string[] = (profile.achievements || []).map((a) => a.id);
    return {
        summary,
        killTotal: (profile.totalKills || 0) + (extra?.kills || 0),
        fusionCount: (profile.fusionCount || 0) + (extra?.fusions || 0),
        affinityClearCount: (profile.affinityClearCount || 0) + (extra?.affinityClears || 0),
        seenFormCount: (profile.seenForms || []).length,
        totalFormCount,
        unlockedIds,
        // 锻造类成就全部读档案：等阶、镶嵌数、防具、材料种类都是局外状态
        profile,
        craftStoneCount: profile.craftStoneCount || 0,
        totalArmorCount: allArmorPieces().length,
        totalElementCount: ELEMENT_IDS.length,
    };
}

/** 把解锁结果写成档案记录 */
export function toRecords(defs: AchievementDef[], now: number): AchievementRecord[] {
    return defs.map((d) => ({ id: d.id, at: now }));
}

/** 本次解锁能拿多少金币 */
export function totalGoldOf(defs: AchievementDef[]): number {
    let sum = 0;
    for (const d of defs) sum += d.gold;
    return sum;
}

/** 给玩家看的一句解锁提示 */
export function describeUnlock(def: AchievementDef): string {
    return '成就解锁：' + def.name + '（+' + def.gold + ' 金币）';
}
