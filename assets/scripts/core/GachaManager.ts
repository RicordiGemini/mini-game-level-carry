/**
 * 许愿抽卡管理器 —— 抽卡、重复转化、辅助升阶的唯一实现点
 *
 * 【设计分层：为什么把"算结果"和"写存档"分成两半】
 *
 *   rollOnce()   纯逻辑。输入池子 / 已拥有集合 / 保底计数 / rng，输出抽卡结果。
 *                它**不碰 SaveManager**，所以在 Node 里可以传一个固定 rng
 *                把整个概率空间完整测一遍，不需要真的建档。
 *   pull()       副作用层。调rollOnce 拿到结果，再写档案。
 *
 *   这样分之后，"抽到什么"与"抽完怎么存"互不干扰：
 *   改概率只动 rollOnce，改存档结构只动 pull。
 *
 * 【不可让步的规则】
 *
 *   1. 本文件所有函数都**不接受广告参数**。
 *      从接口上就不可能做出"必须看广告才能抽"，
 *      这是第六轮定下的约束在代码层面的落实。
 *      广告只出现在 grantCrystalByAd —— 那是可选加速，不是必经之路。
 *
 *   2. 重复件一定给回报，绝不静默消失。
 *      见 rollOnce 里duplicate 分支的注释。
 *
 *   3. 抽卡不提供数值碾压。
 *      抽到的武器一律 1 级，与自动发放时完全一致。
 */

import {
    AUX_MAX_RANK, auxRankCost, auxRankMul, BATCH_GUARANTEE_LAST, CRYSTAL_PER_PULL,
    DUPLICATE_AUX_GOLD, DUPLICATE_WEAPON_MATERIAL, GACHA_POOL_TEXT, GachaPool,
    MAX_PULL_BATCH, PITY_THRESHOLD,
} from '../data/GachaConfig';
import { AUX_ROOT_IDS } from '../data/AuxConfig';
import { EQUIPMENT_TABLE, getEquipDef } from '../data/EquipmentConfig';
import { MATERIAL_TABLE, materialForType, MYTH_CORE_ID } from '../data/MaterialConfig';
import { allArmorPieces, getArmorDef, makeOwnedArmor } from '../data/ArmorConfig';
import {
    BLESSING_BY_AD, BLESSING_HIGH_TIER_MUL, BLESSING_MAX, CRYSTAL_PER_BLESSING,
    EXCHANGE_RARITY, FRAGS_PER_HIGH_EQUIP, PULL_CATEGORY_WEIGHTS,
    PULL_FRAGMENT_COUNT, PULL_MATERIAL_COUNT, RARITY_WEIGHTS,
} from '../data/GachaConfig';
import { getForm, getRootOf } from '../data/FormConfig';
import { OwnedAux, InnateBonus } from '../data/GameTypes';
import { SaveManager } from './SaveManager';
import {
    ascendCopiesOf, ascendGoldOf, isMaxRarity, normalizeRarity, rarityName, rarityPowerMul,
} from '../data/RarityConfig';

/** 高阶碎片的 id（三个池子通用） */
export const FRAG_HIGH_ID = 'frag_high';

/** 高阶碎片的显示名 */
export function fragHighName(): string {
    return '高阶碎片';
}

/** 辅助池抽到的"材料"—— 辅助没有专属材料线，用通用炼金粉代替 */
export const MAT_AUX_ID = 'mat_aux_powder';

/** 通用炼金粉的显示名 */
export function matAuxName(): string {
    return '炼金粉末';
}

// ====================================================================
// 类型
// ====================================================================

/** 一次抽卡抽到了什么类别的东西 */
export type PullKind = 'equip' | 'material' | 'fragment';

/** 一次抽卡的结果 */
export interface PullResult {
    pool: GachaPool;
    /** 本次抽到的类别：装备 / 材料 / 碎片 */
    kind: PullKind;
    /** 抽到的 id（武器装备 id / 辅助根形态 id / 防具 id / 材料 id） */
    id: string;
    name: string;
    /** 是否是此前未拥有过的（新东西）。材料与碎片恒为 false */
    isNew: boolean;
    /** 重复时的补偿说明，新东西为 null */
    duplicateText: string | null;
    /** 装备的品阶 0~6；材料与碎片为 -1 */
    rarity: number;
    /** 数量（材料 / 碎片用；装备为 1） */
    count: number;
}

export interface PullBatch {
    pool: GachaPool;
    results: PullResult[];
    spent: number;
    /** 本批里有几个是保底触发的（UI 上给个标记） */
    pityTriggered: boolean;
}

/** 抽卡结果 + 写入后的档案快照，供 UI 展示 */
export interface PullOutcome extends PullBatch {
    /** 抽卡后的水晶余额 */
    crystalsLeft: number;
    /** 新获得的东西（UI 高亮用） */
    newIds: string[];
}

// ====================================================================
// 纯逻辑：算结果
// ====================================================================

/**
 * 取某个池子当前可以抽到的全部 id。
 *
 * 【与"已解锁"的区别 —— 这是本轮最关键的一处语义变化】
 *
 *   以前自动发放要判unlockLevel / unlockDifficulty 才给武器。
 *   现在改成抽卡后，**解锁条件不再决定"能不能抽到"**：
 *   12 把武器全部进池，玩家通关拿到水晶就能抽。
 *
 *   原因：抽卡的前提是玩家已经通关过至少一次（才有水晶），
 *   而水晶产出只跟难度有关、与关卡号无关。
 *   如果还卡着"第 9 关才进池"，那么"打噩梦攒 100 水晶"这个目标
 *   就被关卡推进速度拖住了 —— 而玩家要的是"打难的换抽卡机会"。
 *
 *   所以解锁条件降级为**保底进度提示**：抽到未解锁武器时给出文案，
 *   让玩家知道"这把要通关第 9 关才会自动加入局外可出战列表"，
 *   但抽到就是抽到了，立刻可用（1 级）。
 */
export function poolIds(pool: GachaPool): string[] {
    if (pool === 'aux') return AUX_ROOT_IDS.slice();
    if (pool === 'armor') return allArmorPieces().map((p) => p.id);
    return EQUIPMENT_TABLE.map((d) => d.id);
}

/** 抽卡池里某件的展示名 */
function displayName(pool: GachaPool, id: string): string {
    if (pool === 'aux') {
        const f = getForm(id);
        return f ? f.name : id;
    }
    if (pool === 'armor') {
        const a = getArmorDef(id);
        return a ? a.name : id;
    }
    const d = getEquipDef(id);
    return d ? d.name : id;
}

/**
 * 取某件装备的品阶（0~6）。
 *
 * 【第八轮起品阶是配置表里的显式字段，不再是推导值】
 * 以前这里按 unlockLevel / unlockDifficulty 折算出一个 0~3 的"展示稀有度"，
 * 那只是 UI 配色用的。现在品阶是正式维度（RarityConfig），
 * 直接读配置表的 rarity 字段，抽卡权重、保底、升阶全都以它为准。
 */
export function rarityOf(pool: GachaPool, id: string): number {
    if (pool === 'aux') {
        const f = getForm(id);
        return f && f.rarity !== undefined ? f.rarity : 0;
    }
    if (pool === 'armor') {
        const a = getArmorDef(id);
        return a && a.rarity !== undefined ? a.rarity : 0;
    }
    const d = getEquipDef(id);
    return d && d.rarity !== undefined ? d.rarity : 0;
}

/**
 * 一次抽取的纯逻辑实现（不写档）。
 *
 * @param pool        抽哪个池
 * @param ownedIds    当前已拥有的 id 集合
 * @param pityCount   当前连续抽到重复的次数
 * @param rng         随机源（0~1）
 * @param forceFresh  是否强制给未拥有的（保底触发时传 true）
 *
 * 【保底的判定顺序】
 *   先看 forceFresh / pity 达标 → 从"未拥有"里挑一个；
 *   否则从全池里等概率挑。
 *   注意顺序很重要：保底必须**优先于**随机，
 *   否则会出现"保底触发了但还是抽到重复"的空转。
 */
export function rollOnce(
    pool: GachaPool,
    ownedIds: string[],
    pityCount: number,
    rng: () => number,
    forceFresh = false,
    /** 第八轮：祝福值。>0 时让本次钻石及以上的权重翻倍 */
    blessing = 0
): PullResult {
    // ---- 1. 先决定这一抽是装备 / 材料 / 碎片 ----
    const cat = rollCategory(rng);

    if (cat === 'material') {
        const m = rollMaterial(pool, rng);
        return {
            pool, kind: 'material', id: m.id, name: m.name,
            isNew: false, duplicateText: null, rarity: -1,
            count: PULL_MATERIAL_COUNT,
        };
    }
    if (cat === 'fragment') {
        return {
            pool, kind: 'fragment', id: FRAG_HIGH_ID, name: fragHighName(),
            isNew: false, duplicateText: null, rarity: -1,
            count: PULL_FRAGMENT_COUNT,
        };
    }

    // ---- 2. 装备：按品阶权重抽，再在该品阶内等概率挑 ----
    const all = poolIds(pool);
    const fresh: string[] = [];
    for (const id of all) {
        if (ownedIds.indexOf(id) < 0) fresh.push(id);
    }

    const allOwned = fresh.length === 0;
    const usePity = !allOwned && (forceFresh || pityCount >= PITY_THRESHOLD);

    let id: string;
    if (usePity && fresh.length > 0) {
        // 保底：从未拥有的里挑。刻意偏向**高品阶** ——
        // 玩家等了 30 抽，保底那一刻应该给一个值得的，而不是又一件青铜。
        const highFirst = fresh.slice().sort((a, b) => rarityOf(pool, b) - rarityOf(pool, a));
        const topBand = highFirst.filter((x) => rarityOf(pool, x) >= rarityOf(pool, highFirst[0]));
        const idx = Math.floor(rng() * topBand.length);
        id = topBand[idx];
    } else {
        // 先按权重定品阶，再在该品阶的候选里等概率挑一件
        const wantRarity = rollRarity(rng, blessing);
        const band = all.filter((x) => rarityOf(pool, x) === wantRarity);
        const candidates = band.length > 0 ? band : all;
        const idx = Math.floor(rng() * candidates.length);
        id = candidates[idx];
    }

    const isNew = ownedIds.indexOf(id) < 0;
    return {
        pool,
        kind: 'equip',
        id,
        name: displayName(pool, id),
        isNew,
        duplicateText: isNew ? null : duplicateTextOf(pool, id),
        rarity: rarityOf(pool, id),
        count: 1,
    };
}

/**
 * 按权重抽一个品阶。
 *
 * 祝福值的作用方式：把**钻石及以上**（权重 8+3+1 = 12）整体翻倍，
 * 低品阶按比例压缩，使总权重仍是 100。
 * 于是"献祭水晶"买到的是"高阶概率从 12% 变成 24%"，
 * 这是一个能被玩家算清楚、也能被测试断言的明确收益。
 */
export function rollRarity(rng: () => number, blessing = 0): number {
    const weights = RARITY_WEIGHTS.slice();
    if (blessing > 0) {
        // 钻石及以上的索引起点
        const highFrom = 3;
        let highSum = 0;
        for (let i = highFrom; i < weights.length; i++) highSum += weights[i];
        if (highSum > 0) {
            const boost = highSum * (BLESSING_HIGH_TIER_MUL - 1);
            for (let i = highFrom; i < weights.length; i++) {
                weights[i] = weights[i] * BLESSING_HIGH_TIER_MUL;
            }
            // 从低品阶按比例扣掉 boost，保持总和不变
            let lowSum = 0;
            for (let i = 0; i < highFrom; i++) lowSum += weights[i];
            if (lowSum > 0) {
                const ratio = Math.max(0, (lowSum - boost)) / lowSum;
                for (let i = 0; i < highFrom; i++) weights[i] = weights[i] * ratio;
            }
        }
    }

    const total = weights.reduce((a, b) => a + b, 0);
    let roll = rng() * total;
    for (let i = 0; i < weights.length; i++) {
        roll -= weights[i];
        if (roll < 0) return i;
    }
    return 0;
}

/** 按权重抽本次的类别（装备 / 材料 / 碎片） */
export function rollCategory(rng: () => number): PullKind {
    const w = PULL_CATEGORY_WEIGHTS;
    const total = w.equip + w.material + w.fragment;
    const r = rng() * total;
    if (r < w.equip) return 'equip';
    if (r < w.equip + w.material) return 'material';
    return 'fragment';
}

/** 抽材料：给本池对应的突破材料 */
function rollMaterial(pool: GachaPool, rng: () => number): { id: string; name: string } {
    if (pool === 'aux') {
        // 辅助没有专属材料线，给金币等价的"通用炼金粉"
        return { id: MAT_AUX_ID, name: '炼金粉末' };
    }
    if (pool === 'armor') {
        // 防具材料从掉落表里随机挑一个
        const mats = MATERIAL_TABLE.filter((m) => m.id !== MYTH_CORE_ID);
        const m = mats[Math.floor(rng() * mats.length)];
        return { id: m.id, name: m.name };
    }
    // 武器池：从武器表里随机挑一个类型
    const d = EQUIPMENT_TABLE[Math.floor(rng() * EQUIPMENT_TABLE.length)];
    const m = materialForType(d.type);
    return { id: m.id, name: m.name };
}

/** 重复件的补偿说明文案（同时也是实际补偿的规则说明） */
export function duplicateTextOf(pool: GachaPool, id: string): string {
    if (pool === 'aux') return '重复 · 转化为 ' + DUPLICATE_AUX_GOLD + ' 金币';
    const def = getEquipDef(id);
    const typeText = def ? def.name : id;
    const mat = def ? materialForType(def.type) : null;
    const matText = mat ? mat.name : '材料';
    return '重复 · 转化为 ' + typeText + '专属材料' + matText + ' ×' + DUPLICATE_WEAPON_MATERIAL;
}

/**
 * 连抽 n 次（纯逻辑）。
 *
 * 【保底在批内是连续推进的】
 *   第 1 抽抽到新的会清零，所以十连里可能触发多次保底 —— 这是正确的，
 *   因为玩家在一次十连里连续出了 2 个新东西，第二次就该重新开始攒。
 *
 * 【triggered 的判定时机】
 *   它表示"本批内**是否触发过**保底"，所以必须在每一抽的**抽取之前**判定 ——
 *   保底一旦生效就会给出新东西，随即把 pity 清零，
 *   若等抽取结束再回头看最终 pity，会永远得到 false（这是实现里踩过的坑）。
 *
 * @returns results 逐抽结果；pity 本批结束后的累计；triggered 本批是否用过保底
 */
export function rollBatch(
    pool: GachaPool,
    ownedIds: string[],
    pityCount: number,
    count: number,
    rng: () => number,
    /** 第八轮：本批可用的祝福值。每抽消耗 1 点，用完后回归基础概率 */
    blessing = 0
): { results: PullResult[]; pity: number; triggered: boolean; blessingLeft: number } {
    const results: PullResult[] = [];
    const owned = ownedIds.slice();
    let pity = pityCount;
    let triggered = false;
    let blessLeft = Math.max(0, blessing);

    for (let i = 0; i < count; i++) {
        // 十连的最后一抽额外保底（十连里至少出一件新的）
        const batchGuarantee = BATCH_GUARANTEE_LAST && count >= MAX_PULL_BATCH && i === count - 1;
        // 两种保底来源：累计次数达标 / 十连最后一抽。
        // 判定必须在抽取**之前**做 —— 抽到新的之后 pity 会被清零，
        // 事后再看最终 pity 就永远看不到"刚刚触发过"。
        const pityGuarantee = pity >= PITY_THRESHOLD;
        const usePity = batchGuarantee || pityGuarantee;
        if (usePity) triggered = true;

        const useBless = blessLeft > 0 ? 1 : 0;
        if (useBless) blessLeft -= 1;

        const r = rollOnce(pool, owned, pity, rng, usePity, useBless);
        results.push(r);
        // 只有"抽到新装备"才推进/清零保底 —— 材料与碎片不占保底进度，
        // 否则玩家会陷入"一直抽材料、保底永远不走"的困惑。
        if (r.kind === 'equip') {
            owned.push(r.id);
            if (r.isNew) pity = 0;
            else pity += 1;
        }
    }

    return { results, pity, triggered, blessingLeft: blessLeft };
}

// ====================================================================
// 水晶
// ====================================================================

/** 当前许愿水晶余额 */
export function crystals(): number {
    return SaveManager.getProfile().crystals || 0;
}

/** 发放水晶（通关结算调用） */
export function addCrystals(n: number): number {
    if (n <= 0) return crystals();
    const p = SaveManager.getProfile();
    p.crystals = (p.crystals || 0) + Math.floor(n);
    SaveManager.saveProfile(p);
    return p.crystals;
}

/** 能否抽 n 次 */
export function canPull(count: number): boolean {
    return crystals() >= CRYSTAL_PER_PULL * Math.max(1, count);
}

/** 抽 n 次的总花费 */
export function pullCost(count: number): number {
    return CRYSTAL_PER_PULL * Math.max(1, count);
}

/**
 * 看广告直接拿水晶（**可选加速，不是必经之路**）。
 *
 * 单独做成一个函数而不是通用 reward，是为了让调用点（广告按钮）
 * 一眼能看出它只是"补一点水晶"，不会有人误把它接进任何必需的流程。
 */
export function grantCrystalByAd(n: number = CRYSTAL_PER_PULL): number {
    const left = addCrystals(n);
    SaveManager.bumpAdView();
    return left;
}

// ====================================================================
// 抽卡（副作用层）
// ====================================================================

/** 武器池已拥有的 id 集合 */
function ownedWeaponIds(): string[] {
    return SaveManager.getProfile().equipment.map((e) => e.id);
}

/** 辅助池已拥有的 id 集合 */
function ownedAuxIds(): string[] {
    return SaveManager.getProfile().auxOwned.map((a) => a.id);
}

/** 当前池子的保底计数 */
function pityOf(pool: GachaPool): number {
    const p = SaveManager.getProfile();
    if (pool === 'aux') return p.pityAux || 0;
    if (pool === 'armor') return p.pityArmor || 0;
    return p.pityWeapon || 0;
}

/** 装备池已拥有的防具 id（去重） */
function ownedArmorIds(): string[] {
    const list = SaveManager.getProfile().armor ? SaveManager.getProfile().armor.owned : [];
    const out: string[] = [];
    for (const a of list || []) {
        if (out.indexOf(a.id) < 0) out.push(a.id);
    }
    return out;
}

/**
 * 把抽到的防具写进局外收藏。
 *
 * 第九轮起防具是「四部位套装 + 可重复持有」模型：
 *   - 每件实例有唯一 uid（ArmorWorn 指向 uid）；
 *   - 允许重复件：重复件是升阶燃料，所以**不按 id 去重**，
 *     每次抽中都入库一件新实例；
 *   - 首次获得某部位时自动穿到对应槽位（避免空槽导致抗性为 0），
 *     后续重复件只做燃料，不打断已穿戴的装备；
 *   - 品阶默认按配置表原生品阶入手；forceRarity 用于碎片兑换（固定钻石）。
 */
function grantArmorToProfile(
    p: ReturnType<typeof SaveManager.getProfile>,
    id: string,
    forceRarity?: number
): void {
    if (!p.armor) p.armor = { owned: [], worn: null };
    if (!p.armor.owned) p.armor.owned = [];
    const def = getArmorDef(id);
    if (!def) return;
    if (!p.armor.worn) p.armor.worn = {};
    const rarity = normalizeRarity(forceRarity !== undefined ? forceRarity : def.rarity === undefined ? 0 : def.rarity);
    // 基础孔 = 品阶给的（与武器对称，见 docs/防具套装系统设计.md §3.3）：
    // 新到手的防具自带 raritySockets(rarity) 个空孔，不必花水晶去开。
    // 构造逻辑与「万象线」共用 makeOwnedArmor，避免两处孔位规则漂移。
    const owned = makeOwnedArmor(id, rarity);
    if (!owned) return;
    p.armor.owned.push(owned);
    // 该部位首次获得时自动穿上
    if (!p.armor.worn[def.part]) p.armor.worn[def.part] = owned.uid;
    console.log('[Gacha] 抽到新防具：' + id + '（' + rarityName(rarity) + '）');
}

/**
 * 抽卡：扣水晶 → 算结果 → 写档案。
 *
 * @param count 抽几次，1~MAX_PULL_BATCH
 * @param rng   随机源。生产环境用 Math.random，测试传确定性 rng
 */
export function pull(pool: GachaPool, count = 1, rng: () => number = Math.random): PullOutcome {
    const n = Math.max(1, Math.min(MAX_PULL_BATCH, Math.floor(count || 1)));

    const cur = crystals();
    const cost = pullCost(n);
    if (cur < cost) {
        return {
            pool, results: [], spent: 0, pityTriggered: false,
            crystalsLeft: cur, newIds: [],
        };
    }

    const owned = ownedIdsOfPool(pool);
    // 三池的容量各取一次，供"全收集冻结保底"判定使用
    const cap = poolIds(pool).length;
    const rolled = rollBatch(pool, owned, pityOf(pool), n, rng, blessing());

    // ---- 扣费 ----
    const p = SaveManager.getProfile();
    p.crystals = cur - cost;
    p.gachaTotal = (p.gachaTotal || 0) + n;
    p.blessing = rolled.blessingLeft;
    if (pool === 'aux') p.pityAux = rolled.pity;
    else if (pool === 'armor') p.pityArmor = rolled.pity;
    else p.pityWeapon = rolled.pity;

    // ---- 落结果 ----
    const newIds: string[] = [];
    for (const r of rolled.results) {
        if (r.kind === 'fragment') {
            grantFragment(p, r.count);
            continue;
        }
        if (r.kind === 'material') {
            grantMaterial(p, r.id, r.count);
            continue;
        }
        // 防具：允许重复件（重复件=升阶燃料），每次抽到都入库一件新实例，
        // 不走 duplicateReward（否则会凭空消失）。其余池子维持原去重逻辑。
        if (pool === 'armor' && r.kind === 'equip') {
            newIds.push(r.id);
            grantArmorToProfile(p, r.id);
            continue;
        }
        if (r.isNew) {
            newIds.push(r.id);
            if (pool === 'aux') grantAuxToProfile(p, r.id);
            else grantWeaponToProfile(p, r.id);
        } else {
            grantDuplicateReward(p, pool, r.id);
        }
    }

    /**
     * 全收集后冻结保底计数。
     *
     * 池子抽空之后保底已经没有意义（给不出"新"的东西），
     * 让它继续累加只会让存档里躺着一个无意义的大数字，
     * 而且玩家看到"已抽 999 次保底进度"会以为坏了。
     * 所以这里识别全收集并归零 —— 语义是"这一池已经不需要保底了"。
     */
    if (pool === 'aux') {
        if ((p.auxOwned || []).length >= poolIds('aux').length) p.pityAux = 0;
    } else if (pool === 'armor') {
        // 用「不重复件数」判定全收集（防具允许重复件，owned.length 会超过池大小）
        if (ownedArmorIds().length >= poolIds('armor').length) p.pityArmor = 0;
    } else {
        if ((p.equipment || []).length >= poolIds('weapon').length) p.pityWeapon = 0;
    }
    void cap;

    SaveManager.saveProfile(p);

    return {
        pool,
        results: rolled.results,
        spent: cost,
        pityTriggered: rolled.triggered,
        crystalsLeft: p.crystals,
        newIds,
    };
}

/** 取某个池子"已拥有"的 id 列表 */
function ownedIdsOfPool(pool: GachaPool): string[] {
    if (pool === 'aux') return ownedAuxIds();
    if (pool === 'armor') return ownedArmorIds();
    return ownedWeaponIds();
}

/** 当前祝福值 */
export function blessing(): number {
    return Math.max(0, Math.min(BLESSING_MAX, SaveManager.getProfile().blessing || 0));
}

/**
 * 献祭水晶换祝福值（**不抽卡，直接换**）。
 *
 * 玩家需求："可以献祭水晶来提高概率, 就是不抽, 直接献祭水晶"。
 * 兑换比例：10 水晶 = 1 点祝福值，每次抽卡消耗 1 点，
 * 使本次"钻石及以上品阶"的权重翻倍（12% → 24%）。
 *
 * @param points 要换几点。不传 = 把能换的全换（受 BLESSING_MAX 限制）
 * @returns 实际换到的点数；水晶不足返回 0
 */
export function sacrificeCrystals(points?: number): number {
    const p = SaveManager.getProfile();
    const cur = Math.max(0, p.blessing || 0);
    const room = BLESSING_MAX - cur;
    if (room <= 0) return 0;

    const have = crystals();
    let want = points === undefined ? room : Math.max(1, Math.floor(points));
    want = Math.min(want, room, Math.floor(have / CRYSTAL_PER_BLESSING));
    if (want <= 0) return 0;

    p.crystals = have - want * CRYSTAL_PER_BLESSING;
    p.blessing = cur + want;
    p.totalSacrificed = (p.totalSacrificed || 0) + want * CRYSTAL_PER_BLESSING;
    SaveManager.saveProfile(p);
    return want;
}

/** 看广告补祝福值（可选加速） */
export function addBlessingByAd(): number {
    const p = SaveManager.getProfile();
    const cur = Math.max(0, p.blessing || 0);
    const gain = Math.min(BLESSING_BY_AD, BLESSING_MAX - cur);
    if (gain <= 0) return 0;
    p.blessing = cur + gain;
    SaveManager.saveProfile(p);
    SaveManager.bumpAdView();
    return gain;
}

/** 献祭一定水晶能换几点祝福值（供 UI 预览） */
export function sacrificePreview(points = 1): { points: number; cost: number; canDo: boolean } {
    const room = BLESSING_MAX - blessing();
    const want = Math.max(1, Math.min(points, room));
    const cost = want * CRYSTAL_PER_BLESSING;
    return { points: want, cost, canDo: crystals() >= cost && want > 0 };
}

/** 高阶碎片余额 */
export function fragHigh(): number {
    return SaveManager.getProfile().fragHigh || 0;
}

/** 发放高阶碎片 */
export function grantFragment(p: ReturnType<typeof SaveManager.getProfile>, n: number): void {
    if (n <= 0) return;
    p.fragHigh = (p.fragHigh || 0) + n;
}

/**
 * 高阶碎片兑换：25 个碎片 → 任选一件高阶装备。
 *
 * 玩家需求："直接兑换高阶的随机碎片, 25个碎片换高阶武器, 武器种类支持任选"，
 * 以及"碎片可以换任意装备"。所以三个池子共用同一份碎片，
 * 兑换目标由调用方指定（含 id），品阶固定为钻石（EXCHANGE_RARITY）。
 *
 * 它是"抽不到也不被卡死"的保底：纯随机有长尾，
 * 碎片让玩家永远有一条确定的路走到高阶。
 */
export function exchangeHighEquip(
    pool: GachaPool,
    id: string
): { ok: boolean; reason?: string; rarity?: number } {
    const need = FRAGS_PER_HIGH_EQUIP;
    const have = fragHigh();
    if (have < need) {
        return { ok: false, reason: '碎片不足（需要 ' + need + '，现有 ' + have + '）' };
    }
    // 目标必须是该池里真实存在的装备
    if (poolIds(pool).indexOf(id) < 0) {
        return { ok: false, reason: '这个池子里没有这件装备' };
    }

    const p = SaveManager.getProfile();
    // 已经拥有则换成重复补偿（不浪费碎片）
    const owned = ownedIdsOfPool(pool);
    if (owned.indexOf(id) >= 0) {
        if (pool === 'armor') {
            // 防具重复件仍有价值（升阶燃料），直接给新实例，不浪费碎片
            p.fragHigh = have - need;
            grantArmorToProfile(p, id, EXCHANGE_RARITY);
            SaveManager.saveProfile(p);
            return { ok: true, rarity: EXCHANGE_RARITY };
        }
        p.fragHigh = have - need;
        grantDuplicateReward(p, pool, id);
        SaveManager.saveProfile(p);
        return { ok: false, reason: '已经拥有了，已按重复件折算' };
    }

    p.fragHigh = have - need;
    if (pool === 'aux') grantAuxToProfile(p, id);
    else if (pool === 'armor') grantArmorToProfile(p, id, EXCHANGE_RARITY);
    else grantWeaponToProfile(p, id);
    SaveManager.saveProfile(p);
    return { ok: true, rarity: EXCHANGE_RARITY };
}

/** 发放材料（抽到材料时调用） */
export function grantMaterial(
    p: ReturnType<typeof SaveManager.getProfile>,
    matId: string,
    n: number
): void {
    if (n <= 0 || !matId) return;
    if (!p.materials) p.materials = {};
    p.materials[matId] = (p.materials[matId] || 0) + n;
}

/**
 * 把抽到的武器写进局外收藏。
 *
 * 刻意**不写 equippedIds**：抽到 ≠ 出战。
 * 让玩家自己在装载界面选 —— 否则抽到谁就自动上谁，
 * 出战槽位的战术意义就没了。
 */
function grantWeaponToProfile(p: ReturnType<typeof SaveManager.getProfile>, id: string): void {
    if (!p.equipment) p.equipment = [];
    if (p.equipment.some((e) => e.id === id)) return;
    const def = getEquipDef(id);
    if (!def) return;
    // 第八轮：按配置表的原生品阶入手 —— 高阶专属武器抽到就是钻石/史诗/神话，
    // 不需要从青铜开始爬。常规武器原生品阶是 0（青铜）。
    const rarity = normalizeRarity(def.rarity === undefined ? 0 : def.rarity);
    p.equipment.push({ id, level: 1, rarity, forge: { sockets: [null] } });
    console.log('[Gacha] 抽到新武器：' + id + '（' + rarityName(rarity) + '）');
}

/** 把抽到的辅助装备写进局外收藏（1 阶） */
function grantAuxToProfile(p: ReturnType<typeof SaveManager.getProfile>, id: string): void {
    if (!p.auxOwned) p.auxOwned = [];
    if (p.auxOwned.some((a) => a.id === id)) return;
    const f = getForm(id);
    if (!f) return;
    const rarity = normalizeRarity(f.rarity === undefined ? 0 : f.rarity);
    p.auxOwned.push({ id, rank: 1, rarity });
    console.log('[Gacha] 抽到新辅助：' + id + '（' + rarityName(rarity) + '）');
}

/**
 * 重复件的补偿。
 *
 * 武器 → 该类型的突破材料（复用第四轮的材料背包）
 * 辅助 → 金币（辅助没有专属材料线，用金币代替，见 GachaConfig 的注释）
 */
function grantDuplicateReward(
    p: ReturnType<typeof SaveManager.getProfile>,
    pool: GachaPool,
    id: string
): void {
    if (pool === 'aux') {
        p.gold = (p.gold || 0) + DUPLICATE_AUX_GOLD;
        return;
    }
    const def = getEquipDef(id);
    if (!def) return;
    if (!p.materials) p.materials = {};
    const mat = materialForType(def.type);
    p.materials[mat.id] = (p.materials[mat.id] || 0) + DUPLICATE_WEAPON_MATERIAL;
}

// ====================================================================
// 辅助装备升阶
// ====================================================================

/** 取某件辅助的当前阶数，未持有返回 0 */
export function auxRankOf(auxId: string): number {
    const list = SaveManager.getProfile().auxOwned || [];
    for (const a of list) {
        if (a.id === auxId) return Math.max(1, Math.floor(a.rank || 1));
    }
    return 0;
}

/** 是否持有某件辅助 */
export function hasAux(auxId: string): boolean {
    return auxRankOf(auxId) > 0;
}

/** 已持有的辅助列表（UI 遍历用） */
export function ownedAuxList(): OwnedAux[] {
    return (SaveManager.getProfile().auxOwned || []).slice();
}

/** 升阶消耗的金币，已满阶返回 -1 */
export function auxRankUpCost(auxId: string): number {
    const r = auxRankOf(auxId);
    if (r <= 0) return -1;
    return auxRankCost(r);
}

/** 能否升阶 */
export function canAuxRankUp(auxId: string): boolean {
    const cost = auxRankUpCost(auxId);
    if (cost < 0) return false;
    return (SaveManager.getProfile().gold || 0) >= cost;
}

/**
 * 辅助装备升阶：花金币，阶数 +1，基础加成按倍率放大。
 *
 * 走金币而不是材料或水晶，是为了让升阶与锻造体系保持同一套货币语言：
 * 玩家只需要学一次"金币 = 永久变强的货币"。
 */
export function auxRankUp(auxId: string): { ok: boolean; reason?: string; rank?: number } {
    const list = SaveManager.getProfile().auxOwned;
    let entry: OwnedAux | null = null;
    for (const a of list) {
        if (a.id === auxId) { entry = a; break; }
    }
    if (!entry) return { ok: false, reason: '尚未拥有这件辅助装备' };

    const cur = Math.max(1, Math.floor(entry.rank || 1));
    if (cur >= AUX_MAX_RANK) return { ok: false, reason: '已是最高阶' };

    const cost = auxRankCost(cur);
    const p = SaveManager.getProfile();
    if ((p.gold || 0) < cost) return { ok: false, reason: '金币不足（需要 ' + cost + '）' };

    p.gold -= cost;
    entry.rank = cur + 1;
    SaveManager.saveProfile(p);
    return { ok: true, rank: entry.rank };
}

/**
 * 取某件辅助在**当前阶数**下的加成倍率。
 *
 * 【局内生效路径】
 *   LevelFlow.getModifier() → aggregateModifier(loadout, auxRankOf)
 *   → 每个辅助槽按 getRootOf(形态) 查到阶数 → effect ×倍率
 *
 *   刻意做成"查档函数"而不是"把倍率写进 build"：
 *   阶数是**局外**成长，玩家在局内升阶是不可能的，
 *   所以每帧重查是正确的（也不贵 —— 局内只有6 个辅助槽）。
 */
export function auxRankMulOf(auxId: string): number {
    const r = auxRankOf(auxId);
    return r <= 0 ? 1.0 : auxRankMul(r);
}

/**
 * 第八轮：取某件辅助的**品阶强度倍率**。
 *
 * 与 auxRankMulOf 是两个正交的轴（见 FormGraph.aggregateModifier 的注释）：
 *   rank   花金币升的局外阶数，1~5
 *   rarity 抽卡 + 消耗同阶装备升阶的品阶，0~6
 * 未持有返回 1.0（不放大），于是局内抽到陌生辅助时它是"原效果"。
 */
export function auxRarityMulOf(auxId: string): number {
    const r = auxRarityOf(auxId);
    return r <= 0 ? 1.0 : rarityPowerMul(r);
}

/** 取某件辅助当前的品阶，未持有返回 0 */
export function auxRarityOf(auxId: string): number {
    const list = SaveManager.getProfile().auxOwned || [];
    for (const a of list) {
        if (a.id === auxId) return normalizeRarity(a.rarity === undefined ? 0 : a.rarity);
    }
    return 0;
}

/**
 * 第八轮：取某件辅助的自带复合属性。
 * 只有钻石及以上的专属辅助才有；未持有或低品阶返回 undefined。
 */
export function auxInnateOf(auxId: string): InnateBonus | undefined {
    const f = getForm(auxId);
    if (!f || !f.innate) return undefined;
    return f.innate.bonus;
}

/**
 * 辅助装备升阶到下一**品阶**（第八轮）。
 *
 * 与武器的 ascendWeapon 共用同一套规则：消耗同阶辅助 + 金币。
 * 辅助没有"专属材料"门槛，所以神话→传说也只要 1 件同阶 + 金币。
 */
export function ascendAux(auxId: string): { ok: boolean; reason?: string; rarity?: number } {
    const list = SaveManager.getProfile().auxOwned;
    let entry: OwnedAux | null = null;
    for (const a of list) {
        if (a.id === auxId) { entry = a; break; }
    }
    if (!entry) return { ok: false, reason: '尚未拥有这件辅助装备' };

    const rarity = normalizeRarity(entry.rarity === undefined ? 0 : entry.rarity);
    if (isMaxRarity(rarity)) return { ok: false, reason: '已是最高品阶（传说）' };

    const need = ascendCopiesOf(rarity);
    const gold = ascendGoldOf(rarity);

    const p = SaveManager.getProfile();
    if ((p.gold || 0) < gold) {
        return { ok: false, reason: '金币不足（需要 ' + gold + '）' };
    }

    const fuels: OwnedAux[] = [];
    for (const a of list) {
        if (a === entry) continue;
        if (normalizeRarity(a.rarity === undefined ? 0 : a.rarity) !== rarity) continue;
        fuels.push(a);
    }
    if (fuels.length < need) {
        return {
            ok: false,
            reason: '同阶辅助不足（需要 ' + rarityName(rarity) + ' ×' + need +
                '，现有 ' + fuels.length + '）',
        };
    }

    p.gold -= gold;
    for (const f of fuels) {
        const i = list.indexOf(f);
        if (i >= 0) list.splice(i, 1);
    }
    entry.rarity = rarity + 1;
    p.totalAscends = (p.totalAscends || 0) + 1;
    SaveManager.saveProfile(p);
    return { ok: true, rarity: entry.rarity };
}

/** 辅助升阶预览 */
export function ascendAuxPreview(auxId: string): {
    rarity: number;
    need: number;
    have: number;
    gold: number;
    maxed: boolean;
} {
    const list = SaveManager.getProfile().auxOwned || [];
    let entry: OwnedAux | null = null;
    for (const a of list) {
        if (a.id === auxId) { entry = a; break; }
    }
    if (!entry) return { rarity: 0, need: 0, have: 0, gold: 0, maxed: false };
    const rarity = normalizeRarity(entry.rarity === undefined ? 0 : entry.rarity);
    if (isMaxRarity(rarity)) {
        return { rarity, need: 0, have: 0, gold: 0, maxed: true };
    }
    const need = ascendCopiesOf(rarity);
    let have = 0;
    for (const a of list) {
        if (normalizeRarity(a.rarity === undefined ? 0 : a.rarity) !== rarity) continue;
        have += 1;
    }
    return {
        rarity, need, have: Math.max(0, have - 1),
        gold: ascendGoldOf(rarity), maxed: false,
    };
}

/** 某形态所属的辅助根 id（升阶查表用） */
export function auxRootOfForm(formId: string): string {
    return getRootOf(formId);
}

// ====================================================================
// 展示辅助
// ====================================================================

/** 抽卡池的一句话描述 */
export function poolText(pool: GachaPool): string {
    return GACHA_POOL_TEXT[pool];
}

/** 抽卡面板需要的完整数据 */
export interface GachaPanelData {
    pool: GachaPool;
    crystals: number;
    /** 单抽是否可点 */
    canSingle: boolean;
    /** 十连是否可点 */
    canBatch: boolean;
    /** 保底进度文本，如"再抽 7 次必出新品" */
    pityText: string;
    /** 已收集 / 总数 */
    collected: number;
    total: number;
    /** 该池是否已全收集 */
    allCollected: boolean;
}

/** 组装抽卡面板数据 */
export function buildGachaPanelData(pool: GachaPool): GachaPanelData {
    const all = poolIds(pool);
    const owned = pool === 'aux' ? ownedAuxIds() : ownedWeaponIds();
    const collected = all.filter((id) => owned.indexOf(id) >= 0).length;
    const pity = pityOf(pool);
    const allCollected = collected >= all.length;

    return {
        pool,
        crystals: crystals(),
        canSingle: canPull(1),
        canBatch: canPull(MAX_PULL_BATCH),
        pityText: allCollected
            ? '本池已全收集'
            : (pity >= PITY_THRESHOLD
                ? '下次必出未收集'
                : '再抽 ' + (PITY_THRESHOLD - pity) + ' 次必出未收集'),
        collected,
        total: all.length,
        allCollected,
    };
}