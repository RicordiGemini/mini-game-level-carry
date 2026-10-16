/**
 * 锻造 —— 突破 / 镶嵌 / 打造 / 掉落的唯一实现点
 *
 * 【这个模块的边界】
 *
 *   它只做"把玩家的操作落到存档上"这一件事：
 *     - 掉落      grantDrops()      通关时按关卡发材料
 *     - 突破      breakthrough()    金币 + 材料 → 升等阶
 *     - 镶嵌      socketElement()   属性材料 → 武器的某个槽位
 *     - 卸下      unsocket()        退还完整材料（不是碎片）
 *     - 合成      craftElement()    10 碎片 → 1 完整
 *     - 打造      craftArmor()      材料 → 防具（第九轮起防具改为抽卡获取，故已移除）
 *   战斗结算（伤害/抗性怎么生效）在 ElementConfig 与 BattleWorld 里。
 *
 * 【三条不可让步的规则】
 *
 *   1. **没有任何一步需要看广告**。
 *      广告只提供"直接给 1 个完整属性材料"，属于可选加速。
 *      所以每个函数都不接受广告相关参数 —— 从接口上就不可能做出强制。
 *
 *   2. **材料可以退**。
 *      卸下镶嵌退还完整材料、打造失败不扣材料。
 *      玩家不该因为手滑而永久损失掉落，这是最容易被差评的点。
 *
 *   3. **等阶只管槽位，不管伤害**。
 *      见 MaterialConfig.RANK_SOCKET_SLOTS 的注释。
 *      等阶的收益完全体现在"能镶几个属性"上。
 *
 * 【第九轮：防具改为四部位套装】
 *   防具不再单件持有 + 单轴抗性，而是「四部位套装 + 品阶 + 升阶 + 开槽 + 专属词条」。
 *   详见 docs/防具套装系统设计.md。
 */

import {
    ElementId,
    ELEMENT_IDS,
    ElementBonus,
    addResist,
    elementBonusToModifier,
    emptyResist,
    ResistMap,
} from '../data/ElementConfig';
import {
    allArmorPieces,
    ArmorPart,
    ArmorPieceDef,
    ARMOR_PARTS,
    getArmorDef,
    getArmorSet,
    isOmniPiece,
    makeOwnedArmor,
    OMNI_MAX_STAGE,
    OMNI_RARITY,
    OMNI_SET_ID,
    OMNI_SET_NAME,
    omniPieces,
    setBonusOf,
} from '../data/ArmorConfig';
import { counterBreakOf } from '../data/ElementConfig';
import {
    MYTH_CORE_ID,
    OMNI_SHARD_COST,
    OMNI_STONE_ID,
    SHARDS_PER_STONE,
    mythCoreName,
} from '../data/MaterialConfig';
import {
    ascendCopiesOf, ascendGoldOf, ascendNeedsCore, isMaxRarity, normalizeRarity,
    rarityName, rarityPowerMul, raritySockets,
} from '../data/RarityConfig';
import { elementsForLevel } from '../data/ElementConfig';
import { getEquipDef } from '../data/EquipmentConfig';
import { EquipType, OwnedArmor, OwnedEquipment, PlayerProfile, ArmorWorn } from '../data/GameTypes';
import { SaveManager } from './SaveManager';
import { getDifficulty, normalizeTier } from '../data/DifficultyConfig';
import { TRIPLE_COMPOSITE_ELEMENTS } from '../data/MaterialConfig';

// ====================================================================
// 存档字段
// ====================================================================

/** 一把武器的锻造状态，挂在 OwnedEquipment 上（第八轮起只有镶嵌，没有等阶） */
export interface ForgeState {
    /** 已镶嵌的属性，数组长度 = 该品阶的槽位数，null = 空槽 */
    sockets: (ElementId | null)[];
}

/** 玩家防具持有与穿戴（第九轮起为四部位套装） */
export interface ArmorState {
    /** 已拥有的防具部件（含品阶/镶嵌） */
    owned: OwnedArmor[];
    /** 四部位穿戴，值为 OwnedArmor.uid */
    worn: ArmorWorn | null;
}

export function defaultForge(): ForgeState {
    return { sockets: [] };
}

export function defaultArmor(): ArmorState {
    return { owned: [], worn: null };
}

/** 开一个额外孔位消耗的水晶（低于神话时） */
export const CRYSTAL_PER_ARMOR_SLOT = 10;
/** 单件防具可额外开出的孔位上限（不含品阶基础 + 升阶 +3） */
export const ARMOR_MAX_OPENED_SLOTS = 9;

// ====================================================================
// 背包读写
// ====================================================================

/** 突破材料背包：{ "mat_blade": 12 } */
export function materialBag(): Record<string, number> {
    const p = SaveManager.getProfile();
    if (!p.materials) p.materials = {};
    return p.materials;
}

/** 属性碎片背包：{ "shard_light": 7 } */
export function shardBag(): Record<string, number> {
    const p = SaveManager.getProfile();
    if (!p.shards) p.shards = {};
    return p.shards;
}

/** 已拥有的完整属性材料：{ "stone_light": 2 } */
export function stoneBag(): Record<string, number> {
    const p = SaveManager.getProfile();
    if (!p.stones) p.stones = {};
    return p.stones;
}

function bagAdd(bag: Record<string, number>, key: string, n: number): void {
    if (n <= 0) return;
    bag[key] = (bag[key] || 0) + n;
    if (bag[key] <= 0) delete bag[key];
}

function bagTake(bag: Record<string, number>, key: string, n: number): boolean {
    if ((bag[key] || 0) < n) return false;
    bag[key] -= n;
    if (bag[key] <= 0) delete bag[key];
    return true;
}

export function countOf(bag: Record<string, number>, key: string): number {
    return bag[key] || 0;
}

/** 碎片袋的 key（'shard_light'） */
export function shardElement(e: ElementId): string {
    return 'shard_' + e;
}

/** 完整属性材料袋的 key（'stone_light'） */
export function shardStone(e: ElementId): string {
    return 'stone_' + e;
}

// ====================================================================
// 武器锻造状态
// ====================================================================

function ownedOf(equipId: string): OwnedEquipment | null {
    const list = SaveManager.getProfile().equipment;
    for (const e of list) if (e.id === equipId) return e;
    return null;
}

/**
 * 取某把武器的锻造状态，缺字段时补默认值（老存档兼容）。
 *
 * 【第八轮：槽位数改由品阶决定】
 *   原来是 `socketSlotsOf(forge.rank)`，现在是 `raritySockets(equip.rarity)`。
 *   品阶吸收了 forge.rank 的职责（见 RarityConfig 的文件头注释）。
 *
 * 【为什么槽位长度取 max(品阶槽位, 现有长度)】
 *   v5→v6 迁移会把老 rank 映射成品阶，但两套阶梯的槽位表不完全一致
 *   （老 rank 5 有 4 槽，映射到史诗只有 3 槽）。
 *   直接截断会把玩家镶好的第 4 颗石头**静默删掉** ——
 *   那是不可逆的财产损失，比"多一个槽"严重得多。
 *   所以长度只增不减：老玩家保底保留原有石头，只是暂时不能加新的，
 *   升阶之后自然能用上。
 */
export function forgeOf(equipId: string): ForgeState {
    const owned = ownedOf(equipId);
    if (!owned) return defaultForge();
    if (!owned.forge) owned.forge = defaultForge();
    if (!owned.forge.sockets) owned.forge.sockets = [];
    if (owned.rarity === undefined) owned.rarity = 0;
    const want = raritySockets(owned.rarity);
    // 只增不减：老存档可能比当前品阶的槽位更多（迁移映射造成的），
    // 直接截断会静默删掉玩家镶好的石头，所以这里绝不删。
    // 多出来的槽位由 canSocket 的 index < socketCapOf 挡住，玩家只是暂时不能用。
    while (owned.forge.sockets.length < want) owned.forge.sockets.push(null);
    return owned.forge;
}

/** 某把武器当前能镶嵌的槽位数（由品阶决定） */
export function socketCapOf(equipId: string): number {
    return raritySockets(ownedRarityOf(equipId));
}

/** 取某把武器的品阶，未持有返回 0 */
export function ownedRarityOf(equipId: string): number {
    const owned = ownedOf(equipId);
    return owned ? normalizeRarity(owned.rarity === undefined ? 0 : owned.rarity) : 0;
}

/** 某把武器镶嵌了哪些属性（只取非空的） */
export function socketsOf(equipId: string): ElementId[] {
    return forgeOf(equipId).sockets.filter((x): x is ElementId => !!x);
}

// ====================================================================
// 升阶（第八轮起取代"突破"）
// ====================================================================

export interface ForgeResult {
    ok: boolean;
    reason?: string;
}

/**
 * 武器升阶：消耗**同阶同类装备** + 金币，品阶 +1。
 *
 * 【为什么消耗的是装备而不是材料】
 *   玩家需求："升阶时候加一个同阶武器到两个同阶武器甚至根据阶级不同数量不同"。
 *   用装备当材料而不是用 mat_*，是为了让**抽卡的重复件直接变成升阶素材** ——
 *   抽到一把已有的青铜武器不再只能换 2 个材料，它能当燃料把主力推上白银。
 *   于是"抽重复"从纯亏损变成了有方向的积累，这是抽卡系统能长期成立的关键。
 *
 * 【为什么刻意不卡数量】
 *   件数曲线是 1 / 1 / 2 / 2 / 2 / 1（+专属材料）。
 *   前两阶各 1 件几乎白给，让玩家立刻感受到升阶；
 *   中段固定 2 件，是"要攒一下但不用刷很久"的量级；
 *   神话→传说回到 1 件，因为那一阶的门槛在**专属材料**而不在件数。
 *   玩家原话是"数量上不要太过于卡"，所以没有一阶超过 2 件。
 *
 * 【金币为什么也收】
 *   纯装备消耗会让金币在后期彻底贬值（那时玩家只缺装备不缺钱）。
 *   收一笔递增金币（400 → 18000）让金币始终有去处，
 *   同时给"要不要现在升"加一个轻微的时机决策。
 */
export function ascendWeapon(equipId: string): ForgeResult {
    const def = getEquipDef(equipId);
    if (!def) return { ok: false, reason: '没有这把武器' };
    const owned = ownedOf(equipId);
    if (!owned) return { ok: false, reason: '尚未拥有这把武器' };

    const rarity = normalizeRarity(owned.rarity === undefined ? 0 : owned.rarity);
    if (isMaxRarity(rarity)) return { ok: false, reason: '已是最高品阶（传说）' };

    const need = ascendCopiesOf(rarity);
    const gold = ascendGoldOf(rarity);

    // ---- 找同阶燃料：优先低等级的，避免吃掉玩家练起来的那把 ----
    const p = SaveManager.getProfile();
    if ((p.gold || 0) < gold) {
        return { ok: false, reason: '金币不足（需要 ' + gold + '）' };
    }

    // 注意这里排除的是**对象本身**（owned），不是 equipId ——
    // 同 id 的重复件恰恰是最主要的燃料来源（抽卡抽到重复的那把）。
    // 早期版本按 id 排除，结果"有两把铁剑却提示燃料不足 0"，
    // 因为两把都被当成了升阶目标而跳过。
    const fuels = findFodder(p.equipment, owned, rarity, need);
    if (fuels.length < need) {
        return {
            ok: false,
            reason: '同阶装备不足（需要 ' + rarityName(rarity) + ' ×' + need +
                '，现有 ' + fuels.length + '）',
        };
    }

    // ---- 神话 → 传说：还要专属进化材料 ----
    if (ascendNeedsCore(rarity)) {
        const bag = materialBag();
        const core = MYTH_CORE_ID;
        if (countOf(bag, core) < 1) {
            return {
                ok: false,
                reason: '缺少专属进化材料（' + mythCoreName() +
                    ' ×1，仅三复合关卡的噩梦难度掉落）',
            };
        }
        bagTake(bag, core, 1);
    }

    p.gold -= gold;
    consumeFodder(p.equipment, fuels);
    owned.rarity = rarity + 1;
    p.totalAscends = (p.totalAscends || 0) + 1;

    // 品阶涨了，镶嵌槽跟着长
    const want = raritySockets(owned.rarity);
    const forge = forgeOf(equipId);
    while (forge.sockets.length < want) forge.sockets.push(null);

    SaveManager.saveProfile(p);
    console.log('[Ascend] ' + def.name + ' 升阶：' + rarityName(rarity) +
        ' → ' + rarityName(owned.rarity));
    return { ok: true };
}

/**
 * 从装备列表里挑同阶燃料。
 *
 * 规则：
 *   1. 品阶必须相同
 *   2. 不能是**被升阶那一件自己**（按对象引用排除，**不是按 id**）
 *   3. 与被升阶件同 id 的优先，且**等级最低的优先** ——
 *      玩家练起来的那把不该被当燃料烧掉
 *
 * 第 2 条按引用而非 id，这一点极其重要：
 * 同 id 的重复件恰恰是最主要的燃料来源（抽卡抽到重复的那把）。
 * 若按 id 排除，会出现"有两把铁剑却提示燃料不足 0"——
 * 因为两把都被当成了升阶目标而跳过。这是实现里真实踩过的坑。
 *
 * 第 3 条是体验关键：如果随机挑燃料，玩家可能眼睁睁看着
 * 自己升到 4 级的铁剑被拿去当材料，而背包里躺着一条 1 级的。
 *
 * @param exclude 被升阶的那一件（对象引用，不是 id）
 * @param rarity  需要的品阶
 * @param need    要几件
 */
export function findFodder(
    list: OwnedEquipment[],
    exclude: OwnedEquipment,
    rarity: number,
    need: number
): OwnedEquipment[] {
    const sameRarity: OwnedEquipment[] = [];
    for (const e of list) {
        if (e === exclude) continue;
        const r = normalizeRarity(e.rarity === undefined ? 0 : e.rarity);
        if (r !== rarity) continue;
        sameRarity.push(e);
    }
    // 同 id 优先，然后等级低的优先
    sameRarity.sort((a, b) => {
        const sa = a.id === exclude.id ? 0 : 1;
        const sb = b.id === exclude.id ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return (a.level || 1) - (b.level || 1);
    });
    return sameRarity.slice(0, Math.max(0, need));
}

/** 把燃料从列表里移除 */
function consumeFodder(list: OwnedEquipment[], fuels: OwnedEquipment[]): void {
    for (const f of fuels) {
        const i = list.indexOf(f);
        if (i >= 0) list.splice(i, 1);
    }
}

/** 升阶预览：还需要多少同阶装备 */
export function ascendWeaponPreview(equipId: string): {
    rarity: number;
    need: number;
    have: number;
    gold: number;
    needCore: boolean;
    maxed: boolean;
} {
    const owned = ownedOf(equipId);
    if (!owned) {
        return { rarity: 0, need: 0, have: 0, gold: 0, needCore: false, maxed: false };
    }
    const rarity = normalizeRarity(owned.rarity === undefined ? 0 : owned.rarity);
    if (isMaxRarity(rarity)) {
        return { rarity, need: 0, have: 0, gold: 0, needCore: false, maxed: true };
    }
    const need = ascendCopiesOf(rarity);
    // 按对象引用排除，与 ascendWeapon 的燃料挑选规则保持一致
    const have = findFodder(SaveManager.getProfile().equipment, owned, rarity, need).length;
    return {
        rarity,
        need,
        have,
        gold: ascendGoldOf(rarity),
        needCore: ascendNeedsCore(rarity),
        maxed: false,
    };
}

// ====================================================================
// 镶嵌
// ====================================================================

/** 某个槽位能不能放某属性 */
export function canSocket(equipId: string, index: number, element: ElementId): ForgeResult {
    const forge = forgeOf(equipId);
    if (index < 0 || index >= forge.sockets.length) {
        return { ok: false, reason: '没有这个槽位' };
    }
    if (forge.sockets.some((s, i) => s === element && i !== index)) {
        return { ok: false, reason: '这把武器已经镶了同样的属性' };
    }
    if (countOf(stoneBag(), 'stone_' + element) < 1) {
        return { ok: false, reason: '没有该属性的完整材料' };
    }
    return { ok: true };
}

/** 把一个完整属性材料镶进槽位 */
export function socketElement(equipId: string, index: number, element: ElementId): ForgeResult {
    const chk = canSocket(equipId, index, element);
    if (!chk.ok) return chk;

    const stones = stoneBag();
    bagTake(stones, 'stone_' + element, 1);

    const forge = forgeOf(equipId);
    // 换下来的完整材料要还给玩家 —— 允许来回倒腾，
    // 否则"镶错了"就变成不可逆损失。
    if (forge.sockets[index]) bagAdd(stones, 'stone_' + forge.sockets[index]!, 1);
    forge.sockets[index] = element;

    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/** 卸下镶嵌，退还完整材料 */
export function unsocket(equipId: string, index: number): ForgeResult {
    const forge = forgeOf(equipId);
    if (index < 0 || index >= forge.sockets.length || !forge.sockets[index]) {
        return { ok: false, reason: '这个槽位是空的' };
    }
    bagAdd(stoneBag(), 'stone_' + forge.sockets[index]!, 1);
    forge.sockets[index] = null;
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/** 把某武器镶嵌的全部属性汇总成一份战斗修正 */
export function socketBonusOf(equipId: string): ElementBonus {
    const out: ElementBonus = {};
    for (const e of socketsOf(equipId)) {
        const b = elementBonusToModifier(e);
        if (b.atkPct) out.atkPct = (out.atkPct || 0) + b.atkPct;
        if (b.atkSpeedPct) out.atkSpeedPct = (out.atkSpeedPct || 0) + b.atkSpeedPct;
        if (b.critRate) out.critRate = (out.critRate || 0) + b.critRate;
        if (b.rangePct) out.rangePct = (out.rangePct || 0) + b.rangePct;
        if (b.extraShots) out.extraShots = (out.extraShots || 0) + b.extraShots;
        if (b.lifesteal) out.lifesteal = (out.lifesteal || 0) + b.lifesteal;
        if (b.pierce) out.pierce = (out.pierce || 0) + b.pierce;
        if (b.chain) out.chain = (out.chain || 0) + b.chain;
        if (b.pierceResist) out.pierceResist = (out.pierceResist || 0) + b.pierceResist;
        if (b.highHpDmg) out.highHpDmg = (out.highHpDmg || 0) + b.highHpDmg;
    }
    return out;
}

// ====================================================================
// 碎片合成
// ====================================================================

/** 某属性的碎片够不够合成一个完整材料 */
export function canCraftElement(e: ElementId): boolean {
    return countOf(shardBag(), 'shard_' + e) >= SHARDS_PER_STONE;
}

/** 10 碎片 → 1 完整 */
export function craftElement(e: ElementId): ForgeResult {
    const shards = shardBag();
    if (!bagTake(shards, 'shard_' + e, SHARDS_PER_STONE)) {
        return { ok: false, reason: '碎片不足（需要 ' + SHARDS_PER_STONE + ' 个）' };
    }
    bagAdd(stoneBag(), 'stone_' + e, 1);
    const p = SaveManager.getProfile();
    p.craftStoneCount = (p.craftStoneCount || 0) + 1;
    SaveManager.saveProfile(p);
    return { ok: true };
}

/** 全属性石是否可合成：24 种碎片各 10 个（共 240 个） */
export function canCraftOmni(): boolean {
    const s = shardBag();
    for (const e of ELEMENT_IDS) {
        if (countOf(s, 'shard_' + e) < OMNI_SHARD_COST[e]) return false;
    }
    return true;
}

/**
 * 24 种碎片各 10 个 → 1 个全属性石。
 *
 * 产出物是**万象线**（见本文件末尾 `advanceOmni()`）唯一的燃料 ——
 * 它同时也是缺口 A-6 的关闭点：第九轮防具改为抽卡获取后，
 * 原本的消费方 `craftArmor()` 被移除，全属性石一度是"只能看不能用"的道具；
 * 第十一轮给它接上了隐藏养成线「万象线」（4 级共消耗 4 个 → 四件套「万象套」）。
 */
export function craftOmni(): ForgeResult {
    if (!canCraftOmni()) return { ok: false, reason: '全属性碎片不足' };
    const s = shardBag();
    for (const e of ELEMENT_IDS) bagTake(s, 'shard_' + e, OMNI_SHARD_COST[e]);
    bagAdd(stoneBag(), OMNI_STONE_ID, 1);
    const p = SaveManager.getProfile();
    p.craftStoneCount = (p.craftStoneCount || 0) + 1;
    SaveManager.saveProfile(p);
    return { ok: true };
}

// ====================================================================
// 防具（第九轮：四部位套装）
// ====================================================================

function armorState(): ArmorState {
    const p = SaveManager.getProfile();
    if (!p.armor) p.armor = { owned: [], worn: null };
    if (!p.armor.owned) p.armor.owned = [];
    if (!p.armor.worn) p.armor.worn = null;
    return p.armor;
}

export function ownedArmors(): OwnedArmor[] {
    return armorState().owned.slice();
}

/** 已拥有的防具部件 id 列表（去重，UI / 抽卡保底用） */
export function ownedArmorIds(): string[] {
    const out: string[] = [];
    for (const a of armorState().owned) {
        if (out.indexOf(a.id) < 0) out.push(a.id);
    }
    return out;
}

/** 当前穿戴的防具部件（已解析成 {owned, def} 列表，缺失部位跳过） */
export function wornArmorPieces(): Array<{ owned: OwnedArmor; def: ArmorPieceDef }> {
    const st = armorState();
    if (!st.worn) return [];
    const out: Array<{ owned: OwnedArmor; def: ArmorPieceDef }> = [];
    for (const part of ARMOR_PARTS) {
        const uid = st.worn[part];
        if (!uid) continue;
        const owned = st.owned.find((a) => a.uid === uid);
        if (!owned) continue;
        const def = getArmorDef(owned.id);
        if (!def) continue;
        out.push({ owned, def });
    }
    return out;
}

/** 是否持有某部件（任意品阶/实例都算） */
export function hasArmor(armorId: string): boolean {
    for (const a of armorState().owned) {
        if (a.id === armorId) return true;
    }
    return false;
}

/** 某部件当前持有的最高品阶（未持有返回 0） */
export function armorRarityOf(armorId: string): number {
    let best = 0;
    for (const a of armorState().owned) {
        if (a.id !== armorId) continue;
        const r = normalizeRarity(a.rarity);
        if (r > best) best = r;
    }
    return best;
}

/** 一件防具的可用孔位上限（品阶基础 + 升阶每次 +3 + 额外开孔上限） */
export function armorSlotCap(owned: OwnedArmor): number {
    const def = getArmorDef(owned.id);
    const baseR = def ? def.rarity : 0;
    const asc = Math.max(0, normalizeRarity(owned.rarity) - baseR);
    return raritySockets(owned.rarity) + 3 * asc + ARMOR_MAX_OPENED_SLOTS;
}

/** 取某件防具当前已镶嵌的属性石（非空数组） */
export function armorSocketsOf(owned: OwnedArmor): ElementId[] {
    return (owned.sockets || []).filter((x): x is ElementId => !!x);
}

/** 穿戴某个部位的防具（uid 必须属于该部位） */
export function wearArmorPart(part: ArmorPart, uid: string): ForgeResult {
    const st = armorState();
    const owned = st.owned.find((a) => a.uid === uid);
    if (!owned) return { ok: false, reason: '没有这件防具' };
    const def = getArmorDef(owned.id);
    if (!def || def.part !== part) return { ok: false, reason: '部位不匹配' };
    if (!st.worn) st.worn = {};
    st.worn[part] = uid;
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/** 卸下某个部位 */
export function unwearArmorPart(part: ArmorPart): ForgeResult {
    const st = armorState();
    if (!st.worn) return { ok: false, reason: '当前没有穿戴任何防具' };
    if (!st.worn[part]) return { ok: false, reason: '该部位没有穿戴' };
    delete st.worn[part];
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/**
 * 防具升阶：消耗同阶同部件装备 + 金币，品阶 +1。
 * 每次升阶 +3 镶嵌孔。升到神话（rarity 5）时免费用累计开孔（打开上限）。
 *
 * 与武器升阶共用同一套规则（见 ascendWeapon 的注释），
 * 差别只有两点：
 *   1. 防具升阶要求**同 id（同部位）**，因为一套 4 件各自独立升阶；
 *   2. 防具没有"专属材料"门槛 —— 传说的门槛只卡武器。
 */
export function ascendArmor(uid: string): ForgeResult {
    const st = armorState();
    const target = st.owned.find((a) => a.uid === uid);
    if (!target) return { ok: false, reason: '没有这件防具' };
    const def = getArmorDef(target.id);
    if (!def) return { ok: false, reason: '没有该防具定义' };

    const rarity = normalizeRarity(target.rarity);
    if (isMaxRarity(rarity)) return { ok: false, reason: '已是最高品阶（传说）' };

    const need = ascendCopiesOf(rarity);
    const gold = ascendGoldOf(rarity);

    const p = SaveManager.getProfile();
    if ((p.gold || 0) < gold) {
        return { ok: false, reason: '金币不足（需要 ' + gold + '）' };
    }

    // 燃料：同 id（同部件）+ 同品阶，排除自身（按对象引用）
    const fuels = st.owned.filter(
        (a) => a !== target && a.id === target.id && normalizeRarity(a.rarity) === rarity
    );
    if (fuels.length < need) {
        return {
            ok: false,
            reason: '同阶同部位防具不足（需要 ' + rarityName(rarity) + ' ×' + need +
                '，现有 ' + fuels.length + '）',
        };
    }

    p.gold -= gold;
    for (const f of fuels.slice(0, need)) {
        const i = st.owned.indexOf(f);
        if (i >= 0) st.owned.splice(i, 1);
    }
    target.rarity = rarity + 1;
    // 升阶 +3 孔（含品阶基础 + 升阶累计）
    const newAsc = Math.max(0, normalizeRarity(target.rarity) - (def.rarity || 0));
    const targetLen = raritySockets(target.rarity) + 3 * newAsc;
    const socks = target.sockets || [];
    while (socks.length < targetLen) socks.push(null);
    target.sockets = socks;
    // 神话：免费用累计开孔（用户确认"神话可以开前面的总和的槽位"）
    if (target.rarity >= 5) target.openedSlots = ARMOR_MAX_OPENED_SLOTS;
    p.totalAscends = (p.totalAscends || 0) + 1;

    SaveManager.saveProfile(p);
    console.log('[Ascend] ' + def.name + ' 升阶：' + rarityName(rarity) + ' → ' + rarityName(target.rarity));
    return { ok: true };
}

/** 防具升阶预览 */
export function ascendArmorPreview(uid: string): {
    rarity: number;
    need: number;
    have: number;
    gold: number;
    maxed: boolean;
} {
    const st = armorState();
    const target = st.owned.find((a) => a.uid === uid);
    if (!target) return { rarity: 0, need: 0, have: 0, gold: 0, maxed: false };
    const def = getArmorDef(target.id);
    if (!def) return { rarity: 0, need: 0, have: 0, gold: 0, maxed: false };
    const rarity = normalizeRarity(target.rarity);
    if (isMaxRarity(rarity)) {
        return { rarity, need: 0, have: 0, gold: 0, maxed: true };
    }
    const need = ascendCopiesOf(rarity);
    let have = 0;
    for (const a of st.owned) {
        if (a === target) continue;
        if (a.id !== target.id) continue;
        if (normalizeRarity(a.rarity) !== rarity) continue;
        have += 1;
    }
    return { rarity, need, have, gold: ascendGoldOf(rarity), maxed: false };
}

/** 把一个 ElementBonus 按比例缩放（critMul 相乘，其余相乘） */
function scaleBonus(b: ElementBonus, mul: number): ElementBonus {
    if (mul === 1) return b;
    const out: ElementBonus = {};
    for (const k of Object.keys(b) as (keyof ElementBonus)[]) {
        const v = b[k];
        if (v === undefined) continue;
        (out as Record<string, number>)[k] = (v as number) * mul;
    }
    return out;
}

/** 合并两个 ElementBonus（critMul 取最大，其余相加） */
function addBonus(out: ElementBonus, b: ElementBonus | undefined): void {
    if (!b) return;
    for (const k of Object.keys(b) as (keyof ElementBonus)[]) {
        const v = b[k];
        if (v === undefined) continue;
        if (k === 'critMul') out.critMul = Math.max(out.critMul || 0, v as number);
        else (out as Record<string, number>)[k] = ((out as Record<string, number>)[k] || 0) + (v as number);
    }
}

/**
 * 当前生效的 6 维属性抗性（聚合 4 个穿戴部位）。
 *
 * 每件防具抗性乘各自品阶倍率，软上限压缩后按元素求和，最后再压一次防溢出。
 * 这是用户确认的「双轨并存」里"减伤"那条轨。
 */
export function currentResist(): ResistMap {
    const out = emptyResist();
    for (const { owned, def } of wornArmorPieces()) {
        const mul = rarityPowerMul(owned.rarity);
        for (const e of ELEMENT_IDS) {
            const base = def.resist[e] || 0;
            if (base <= 0) continue;
            let scaled = base * mul;
            scaled = scaled <= 1 ? scaled : scaled / (1 + scaled);
            out[e] = (out[e] || 0) + scaled;
        }
    }
    for (const e of ELEMENT_IDS) {
        const v = out[e];
        if (v > 1) out[e] = v / (1 + v);
    }
    return out;
}

/**
 * 当前防具提供的主动增益（聚合 4 部位）：
 *   单件 innate + 镶嵌属性石 + 套装 2/4 件属性（按同套同部位的平均品阶缩放）。
 *
 * 这是用户确认的「双轨并存」里"增益词条"那条轨：
 *   每件防具自带 1 条 innate；
 *   镶嵌属性石追加词条；
 *   凑齐同套 2 件触发小套属性、4 件触发大套属性（词条数随平均品阶）。
 */
export function armorBonus(): ElementBonus {
    const out: ElementBonus = {};
    const pieces = wornArmorPieces();

    // 单件专属 + 镶嵌
    for (const { owned, def } of pieces) {
        const mul = rarityPowerMul(owned.rarity);
        addBonus(out, scaleBonus(def.innate, mul));
        for (const el of armorSocketsOf(owned)) {
            addBonus(out, elementBonusToModifier(el));
        }
    }

    // 套装 2/4 件
    const bySet: Record<string, number[]> = {};
    for (const { owned, def } of pieces) {
        (bySet[def.setId] = bySet[def.setId] || []).push(owned.rarity);
    }
    for (const setId of Object.keys(bySet)) {
        const rarities = bySet[setId];
        if (rarities.length < 2) continue;
        const avg = rarities.reduce((a, b) => a + b, 0) / rarities.length;
        const set = getArmorSet(setId);
        if (!set) continue;
        const bonus = setBonusOf(set, avg, rarities.length);
        addBonus(out, scaleBonus(bonus, rarityPowerMul(avg)));
    }
    return out;
}

/**
 * 防具对"无视克制"的贡献。
 * 本轮防具不再提供破防（与第八轮"无任何单一路线点满破防"一致，破防完全由武器承担）。
 */
export function armorCounterBreak(): number {
    return 0;
}

/**
 * 某把武器当前的破防比例（无视克制）。
 *
 * 三个来源都要投入：局外等级（金币 + 材料）+ **品阶**（同阶装备 + 金币）+
 * 镶嵌数（属性碎片），再加上防具那一条（本轮为 0）。
 * 所以**没有任何单一路线能点满无视克制**。
 *
 * 多把武器时取**最高那一件**，不是求和 ——
 * 求和会让"三把武器各破防 30%"直接满防，那等于把"专精一把"的路堵死了。
 */
export function counterBreakOfWeapon(equipId: string): number {
    const forge = forgeOf(equipId);
    // 直接读档案里的等级，不走 EquipmentManager.getLevel ——
    // 那个模块已经 import 了文件，再反向 import 就是循环依赖。
    const list = SaveManager.getProfile().equipment;
    let level = 1;
    let rarity = 0;
    for (const e of list) {
        if (e.id !== equipId) continue;
        level = e.level;
        rarity = normalizeRarity(e.rarity === undefined ? 0 : e.rarity);
        break;
    }
    const socks = forge.sockets.filter((x): x is ElementId => !!x).length;
    // 品阶按 0~6 传进去，公式内部会做 BREAK_PER_RANK 的加权
    return counterBreakOf(level, rarity + 1, socks, 0);
}

/** 本局出战武器里的最高破防（战斗层用它收敛克制倍率） */
export function maxCounterBreak(equipIds: string[]): number {
    let m = 0;
    for (const id of equipIds) {
        const b = counterBreakOfWeapon(id);
        if (b > m) m = b;
    }
    return m;
}

// ====================================================================
// 防具镶嵌与开孔
// ====================================================================

/** 某孔能否镶某属性石 */
export function canSocketArmor(uid: string, index: number, element: ElementId): ForgeResult {
    const owned = armorState().owned.find((a) => a.uid === uid);
    if (!owned) return { ok: false, reason: '没有这件防具' };
    const socks = owned.sockets || [];
    if (index < 0 || index >= socks.length) return { ok: false, reason: '没有这个孔位' };
    if (socks.some((s, i) => s === element && i !== index)) {
        return { ok: false, reason: '已经镶了同样的属性' };
    }
    if (countOf(stoneBag(), 'stone_' + element) < 1) {
        return { ok: false, reason: '没有该属性的完整材料' };
    }
    return { ok: true };
}

/** 把属性石镶进防具的孔位（换下的完整材料退还） */
export function socketArmorElement(uid: string, index: number, element: ElementId): ForgeResult {
    const chk = canSocketArmor(uid, index, element);
    if (!chk.ok) return chk;
    const owned = armorState().owned.find((a) => a.uid === uid)!;
    bagTake(stoneBag(), 'stone_' + element, 1);
    const socks = owned.sockets!;
    if (socks[index]) bagAdd(stoneBag(), 'stone_' + socks[index]!, 1);
    socks[index] = element;
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/** 卸下防具镶嵌，退还完整材料 */
export function unsocketArmor(uid: string, index: number): ForgeResult {
    const owned = armorState().owned.find((a) => a.uid === uid);
    if (!owned || !owned.sockets) return { ok: false, reason: '这个槽位是空的' };
    if (index < 0 || index >= owned.sockets.length || !owned.sockets[index]) {
        return { ok: false, reason: '这个槽位是空的' };
    }
    bagAdd(stoneBag(), 'stone_' + owned.sockets[index]!, 1);
    owned.sockets[index] = null;
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/**
 * 开一个额外孔位。
 * 神话及以上：累计开孔免费（用户确认"神话可以开前面的总和的槽位"）。
 * 其余品阶：消耗许愿水晶（"开槽位可以选择水晶开槽"）。
 */
export function openArmorSlot(uid: string): ForgeResult {
    const st = armorState();
    const owned = st.owned.find((a) => a.uid === uid);
    if (!owned) return { ok: false, reason: '没有这件防具' };
    const cur = owned.sockets ? owned.sockets.length : 0;
    const cap = armorSlotCap(owned);
    if (cur >= cap) return { ok: false, reason: '已无可开孔位' };

    if (normalizeRarity(owned.rarity) >= 5) {
        // 神话：累计开孔免费
        owned.openedSlots = Math.min(ARMOR_MAX_OPENED_SLOTS, (owned.openedSlots || 0) + 1);
    } else {
        const p = SaveManager.getProfile();
        if ((p.crystals || 0) < CRYSTAL_PER_ARMOR_SLOT) {
            return { ok: false, reason: '水晶不足（需要 ' + CRYSTAL_PER_ARMOR_SLOT + '）' };
        }
        p.crystals -= CRYSTAL_PER_ARMOR_SLOT;
        owned.openedSlots = (owned.openedSlots || 0) + 1;
    }
    if (!owned.sockets) owned.sockets = [];
    owned.sockets.push(null);
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

/**
 * 青铜防具可用材料开孔（用户确认"青铜…添加材料给添加额外的词条"）。
 * 任意突破材料（mat_*）各 1 个可开 1 孔，走材料线而非水晶。
 */
export function openArmorSlotMaterial(uid: string, matId: string): ForgeResult {
    const st = armorState();
    const owned = st.owned.find((a) => a.uid === uid);
    if (!owned) return { ok: false, reason: '没有这件防具' };
    const def = getArmorDef(owned.id);
    if (!def || def.rarity !== 0) return { ok: false, reason: '仅青铜防具可用材料开孔' };
    const cur = owned.sockets ? owned.sockets.length : 0;
    if (cur >= armorSlotCap(owned)) return { ok: false, reason: '已无可开孔位' };
    const mats = materialBag();
    if ((mats[matId] || 0) < 1) return { ok: false, reason: '缺少材料 ' + matId };
    mats[matId] -= 1;
    owned.openedSlots = (owned.openedSlots || 0) + 1;
    if (!owned.sockets) owned.sockets = [];
    owned.sockets.push(null);
    SaveManager.saveProfile(SaveManager.getProfile());
    return { ok: true };
}

// ====================================================================
// 万象线（第十一轮）—— 隐藏的防具终局养成线，万象套的唯一获取途径
// ====================================================================

/**
 * 万象线各阶段的显示名。
 * 索引即 stage，所以长度必须是 OMNI_MAX_STAGE + 1。
 */
export const OMNI_STAGE_NAMES: string[] = [
    '未开始',
    '万象·碎片之核',
    '万象·镜胚',
    '万象镜甲',
    OMNI_SET_NAME,
];

/** 升到下一级的消耗（索引 = 目标 stage） */
export const OMNI_STAGE_COST: Array<{ stone: number; gold: number }> = [
    { stone: 0, gold: 0 },          // 0 → 1：占位，实际用索引 1
    { stone: 1, gold: 6000 },       // → 1 万象·碎片之核
    { stone: 1, gold: 12000 },      // → 2 万象·镜胚
    { stone: 1, gold: 24000 },      // → 3 万象镜甲
    { stone: 1, gold: 48000 },      // → 4 万象套（授予四件）
];

/**
 * 读「万象线」当前阶段。
 *
 * 缺字段 / 非法值一律按 0 处理，并 clamp 到 `[0, OMNI_MAX_STAGE]`，
 * 保证 UI 与业务逻辑不会因为坏档读到越界阶段。
 */
export function omniStage(): number {
    const p = SaveManager.getProfile();
    const raw = p.omni && typeof p.omni.stage === 'number' ? p.omni.stage : 0;
    if (!isFinite(raw)) return 0;
    return Math.max(0, Math.min(OMNI_MAX_STAGE, Math.floor(raw)));
}

/** 当前阶段名（越界自动 clamp） */
export function omniStageName(stage?: number): string {
    const s = stage === undefined ? omniStage() : Math.max(0, Math.min(OMNI_MAX_STAGE, Math.floor(stage)));
    return OMNI_STAGE_NAMES[s] || OMNI_STAGE_NAMES[0];
}

/** 是否已经拿到整套万象套 */
export function hasOmniSet(): boolean {
    return omniStage() >= OMNI_MAX_STAGE;
}

/** 手里现成的全属性石数量 */
export function omniStoneCount(): number {
    return countOf(stoneBag(), OMNI_STONE_ID);
}

/**
 * 「隐藏合成逻辑」的可见性开关。
 *
 * 三条任一成立才把这条线暴露给玩家：
 *   1. 已经开始了（stage > 0，且**单调不回退**）；
 *   2. 背包里已经有全属性石；
 *   3. 材料已经够合成 1 个全属性石（见 `canCraftOmni`）。
 *
 * 都不满足 → ForgePanel 不渲染该区块，玩家在凑齐 240 碎片之前**不知道有这条线**。
 */
export function omniVisible(): boolean {
    if (omniStage() > 0) return true;
    if (omniStoneCount() > 0) return true;
    return canCraftOmni();
}

/** 升下一级的消耗（已满级返回 null） */
export function omniNextCost(): { stone: number; gold: number } | null {
    const s = omniStage();
    if (s >= OMNI_MAX_STAGE) return null;
    return OMNI_STAGE_COST[s + 1];
}

/** 能否升下一级（不足的理由写在 reason 里，供 UI 直接展示） */
export function canAdvanceOmni(): ForgeResult {
    const s = omniStage();
    if (s >= OMNI_MAX_STAGE) return { ok: false, reason: '已是最终阶段 · 万象套' };
    const cost = OMNI_STAGE_COST[s + 1];
    const haveStone = omniStoneCount();
    if (haveStone < cost.stone) {
        return { ok: false, reason: '缺少全属性石（需要 ' + cost.stone + ' 个，当前 ' + haveStone + '）' };
    }
    const gold = SaveManager.getProfile().gold || 0;
    if (gold < cost.gold) {
        return { ok: false, reason: '金币不足（需要 ' + cost.gold + '）' };
    }
    return { ok: true };
}

/**
 * 升级「万象线」一级。
 *
 * - 消耗：1 个全属性石 + 递增金币（见 `OMNI_STAGE_COST`）；
 * - 到达最后一级时**一次性授予 4 件传说「万象套」并自动穿戴空部位**；
 * - 满级 / 资源不足一律 `ok:false` 且**分毫不扣**（先校验、后扣费）。
 *
 * 这也是缺口 A-6 的关闭点：全属性石从"死道具"变成了这条线唯一的燃料。
 */
export function advanceOmni(): ForgeResult {
    const chk = canAdvanceOmni();
    if (!chk.ok) return chk;

    const s = omniStage();
    const cost = OMNI_STAGE_COST[s + 1];
    const next = s + 1;

    // 先扣费（校验已在上一步做完，这里不会失败）
    if (cost.stone > 0) bagTake(stoneBag(), OMNI_STONE_ID, cost.stone);
    const p = SaveManager.getProfile();
    p.gold = Math.max(0, (p.gold || 0) - cost.gold);

    if (!p.omni) p.omni = { stage: 0 };
    p.omni.stage = next;

    console.log('[Omni] 万象线 ' + s + ' → ' + next + '（' + omniStageName(next) + '）');

    if (next >= OMNI_MAX_STAGE) {
        grantOmniSet(p);
    }

    SaveManager.saveProfile(p);
    return { ok: true };
}

/**
 * 授予整套万象套（4 件，全部传说），并补穿空部位。
 *
 * 幂等：同部位若已穿着万象套部件则不覆盖；
 * 已持有过万象套时不重复发放（`hasOmniSet()` 之外再挡一道，防手滑重复调用）。
 */
function grantOmniSet(p: PlayerProfile): void {
    if (!p.armor) p.armor = { owned: [], worn: null };
    if (!p.armor.owned) p.armor.owned = [];
    if (!p.armor.worn) p.armor.worn = {};
    const already = p.armor.owned.some((a) => a.id.indexOf(OMNI_SET_ID + '_') === 0);
    if (already) {
        console.log('[Omni] 已持有万象套，跳过重复发放');
        return;
    }
    for (const def of omniPieces()) {
        const inst = makeOwnedArmor(def.id, OMNI_RARITY);
        if (!inst) continue;
        p.armor.owned.push(inst);
        // 空部位自动穿上；已有装备的部位不打断玩家当前搭配
        if (!p.armor.worn[def.part]) p.armor.worn[def.part] = inst.uid;
    }
    console.log('[Omni] 万象套 4 件已入库（' + rarityName(OMNI_RARITY) + '）');
}

/**
 * 万象线的 UI 快照（只读，不写档）。
 * `visible === false` 时调用方应整块隐藏。
 */
export function omniPreview(): {
    visible: boolean;
    stage: number;
    name: string;
    maxStage: number;
    owned: boolean;
    stoneHave: number;
    stoneNeed: number;
    goldNeed: number;
    canAdvance: boolean;
    reason: string;
} {
    const stage = omniStage();
    const cost = omniNextCost();
    const chk = canAdvanceOmni();
    return {
        visible: omniVisible(),
        stage,
        name: omniStageName(stage),
        maxStage: OMNI_MAX_STAGE,
        owned: hasOmniSet(),
        stoneHave: omniStoneCount(),
        stoneNeed: cost ? cost.stone : 0,
        goldNeed: cost ? cost.gold : 0,
        canAdvance: chk.ok,
        reason: chk.ok ? '' : (chk.reason || ''),
    };
}

/** 该防具部件是否来自万象线（UI 用它加"隐藏套装"标记） */
export function isOmniArmor(id: string): boolean {
    return isOmniPiece(id);
}

// ====================================================================
// 掉落
// ====================================================================

export interface DropResult {
    /** 突破材料 id → 数量 */
    materials: Record<string, number>;
    /** 属性碎片 id → 数量 */
    shards: Record<string, number>;
    /** 本关掉落的属性列表（UI 展示"这关掉什么"） */
    elements: ElementId[];
}

/**
 * 通关时按关卡发材料。
 *
 * 【掉落规则】
 *   突破材料  关卡里**推荐武器**对应的材料（主）+ 克制武器的材料（少量）
 *             —— 于是"打这关"与"我想要哪把武器变强"直接挂钩，
 *             这是"每关掉落不同的升级材料"落到实处的地方。
 *   属性碎片  该关**全部属性**各掉 1~3 个
 *             —— 于是属性材料与关卡属性一一对应，
 *             想要冰属性材料就去打冰属性关，而不是去刷某一把固定关卡。
 *
 * @param levelId      关卡号
 * @param affinityIds  该关推荐武器 id
 * @param weakIds      该关克制武器 id
 * @param roll         0~1 的随机数（由调用方传入，保证可测试）
 */
export function rollDrops(
    levelId: number,
    affinityIds: string[],
    weakIds: string[],
    roll = 0.5,
    /** 第八轮：难度档位，决定神话之核是否可能掉落 */
    tier = 1
): DropResult {
    const out: DropResult = { materials: {}, shards: {}, elements: elementsForLevel(levelId) };
    const addMat = (type: EquipType, n: number) => {
        const id = 'mat_' + type;
        out.materials[id] = (out.materials[id] || 0) + n;
    };

    // 推荐武器的主材料
    for (const id of affinityIds) {
        const def = getEquipDef(id);
        if (def) addMat(def.type, 2);
    }
    // 克制武器的少量材料：让"非最优解"也有产出，玩家不会觉得白打
    for (const id of weakIds) {
        const def = getEquipDef(id);
        if (def) addMat(def.type, 1);
    }

    // 属性碎片：每种属性 1~3 个
    for (const e of out.elements) {
        const n = 1 + Math.floor(roll * 3);
        if (n > 0) {
            const k = 'shard_' + e;
            out.shards[k] = (out.shards[k] || 0) + n;
        }
    }

    // ---- 第八轮：神话之核（仅三复合关卡 + 噩梦）----
    if (mythCoreDropChance(levelId, tier) > 0) {
        // 用独立的 roll 通道，避免与材料/碎片的随机数互相干扰
        const coreRoll = (roll * 7.13) % 1;
        if (coreRoll < mythCoreDropChance(levelId, tier)) {
            out.materials[MYTH_CORE_ID] = (out.materials[MYTH_CORE_ID] || 0) + 1;
        }
    }
    return out;
}

/**
 * 神话之核的掉落概率。
 *
 * 【为什么只有三复合关卡 + 噩梦才掉】
 *   玩家需求原话："添加专属进化神话的材料, 这个材料在后面复合关卡才会出,
 *                 三复合的关卡才会出, 并且只有噩梦难度才出"。
 *   数据里"三复合关卡"是确定的：`elementsForLevel()` 的属性数曲线是
 *   1（1~4 关）→ 2（5~8 关）→ 3（9~12 关）→ 4（13 关起），
 *   所以属性数正好 = 3 的就是第 9~12 关。
 *
 * 【概率为什么定 25%】
 *   它是全游戏唯一不可替代的材料（不能金币买、不能碎片换、不能广告拿），
 *   但掉落窗口只有 4 关 × 1 个难度 = 4 种组合。
 *   25% 意味着平均 4 次通关拿 1 个，而一次"神话→传说"只要 1 个 ——
 *   也就是"认真打一个下午能出一个传说"。
 *   定 10% 会让平均耗时翻倍到 10 次，那几关的噩梦并不好打，容易变成劝退；
 *   定 50% 又太便宜，传说会泛滥。25% 是这两个极端的中间。
 *
 * @returns 0 表示这一关不掉落；>0 是概率（0~1）
 */
export function mythCoreDropChance(levelId: number, tier: number): number {
    const els = elementsForLevel(levelId);
    if (els.length !== TRIPLE_COMPOSITE_ELEMENTS) return 0;
    if (normalizeTier(tier) !== 3) return 0;
    return MYTH_CORE_DROP_RATE;
}

/** 神话之核在三复合关卡噩梦难度下的掉落概率 */
export const MYTH_CORE_DROP_RATE = 0.25;

/** 把掉落结果真正写进存档 */
export function grantDrops(d: DropResult): void {
    const mats = materialBag();
    const shards = shardBag();
    for (const k of Object.keys(d.materials)) bagAdd(mats, k, d.materials[k]);
    for (const k of Object.keys(d.shards)) bagAdd(shards, k, d.shards[k]);
    SaveManager.saveProfile(SaveManager.getProfile());
}

/**
 * 看广告直接拿一个完整属性材料（**可选加速，不是必经之路**）。
 *
 * 单独做成一个函数而不是通用 reward，是为了让调用点（广告按钮）一眼能看出
 * 它只是"给个材料"，不会有人误把它接进任何必需的流程。
 */
export function grantStoneByAd(e: ElementId): void {
    bagAdd(stoneBag(), 'stone_' + e, 1);
    SaveManager.saveProfile(SaveManager.getProfile());
    SaveManager.bumpAdView();
}

// ====================================================================
// 汇总（防具第九轮起为抽卡获取，不再有材料打造清单）
// ====================================================================

/** 某个属性离合成还差几个碎片 */
export function shardsNeededFor(e: ElementId): number {
    return Math.max(0, SHARDS_PER_STONE - countOf(shardBag(), 'shard_' + e));
}
