/**
 * 突破材料 + 属性材料 —— 局外成长线的第三条
 *
 * 【三条局外成长线的分工】
 *
 *   局外等级（金币）    提武器的基础伤害，无上限
 *   突破材料（掉落）    提武器的**等阶**，等阶决定能镶几个属性
 *   属性材料（掉落/广告）给武器灌属性效果，有槽位上限
 *
 * 为什么要拆成两条而不是合成一条：如果"升级"同时给伤害和属性，
 * 玩家攒够金币就直接满级，材料线就完全没有意义了。
 *
 * 【等阶是槽位上限，不是伤害加成】
 *
 *   玩家原话："一个武器也可以叠加效果, 不存在只可以叠加一个,
 *             但是根据武器的等阶会有上限, 比如一阶只可以加一个"。
 *
 *   所以等阶本身**不加任何伤害**，它唯一的职责是"最多能镶几个属性"。
 *   这样设计的目的是让玩家必须先拿到某把武器的专属材料，
 *   才能开始给第二、第三把武器灌属性 ——
 *   于是"每种武器的突破材料不同"这条规则自动产生了牵引力：
 *   你会想去打那些掉你favorite武器材料的关卡。
 *
 * 【材料获取：全部有免费路径】
 *
 *   玩家原话："不需要那种必须要什么条件才可以突破的要求,
 *             不做任何强制性的必须看广告才可以拿到的升级材料"。
 *
 *   所以：
 *     - 突破材料**只靠关卡掉落**，金币 + 材料就能突破，全程不看广告
 *     - 属性材料**碎片 → 10 个合成 1 个完整**，碎片也是关卡掉的
 *     - 看广告只是"直接给 1 个完整属性材料"，属于**可选加速**，
 *       不看广告一样能攒够，只是慢十倍
 *
 *   唯一有"门槛"感的是全属性石：需要 24 种属性碎片各 10 个（共 240 个）。
 *   但这个门槛是**时间与地图覆盖**上的，不是广告上的 ——
 *   碎片分散在不同的关卡属性里，想凑齐就得把前期的关卡都打一遍。
 *
 *   ⚠️ 第九轮遗留缺口 A-6：防具改为抽卡获取后，原本消费全属性石的
 *    「打造全属性防具」被移除，`OMNI_STONE_ID` 一度没有任何消费方。
 *    ✅ 第十一轮已关闭：它是隐藏养成线「万象线」唯一的燃料，见
 *    `core/ForgeManager.ts` 的 `advanceOmni()` / 本文件 `OMNI_STONE_ID` 注释。
 */

import { ElementId, ELEMENT_IDS } from './ElementConfig';
import { EquipType } from './GameTypes';

// ====================================================================
// 突破材料
// ====================================================================

/**
 * 每种武器的专属突破材料。
 *
 * 为什么按**武器类型**分而不是按关卡分：
 *   材料是"这把武器变强的凭证"，它的意义永远绑定在武器身上。
 *   如果改成"任意材料都能突破任意武器"，玩家就完全没有收集目标了，
 *   掉落表也没法设计出"打这一关会拿到你想要的材料"这种期待。
 *
 * 命名规则：`mat_<equipType>`，与 EQUIPMENT_TABLE 的 type 一一对应。
 */
export type MaterialId = string;

export interface MaterialDef {
    id: MaterialId;
    name: string;
    /** 这份材料是哪把武器的 */
    equipType: EquipType;
    /** 哪个关卡开始掉落（1 起） */
    fromLevel: number;
    /** 一句话说明 */
    desc: string;
    color: [number, number, number];
}

function mat(equipType: EquipType, name: string, fromLevel: number, desc: string,
    color: [number, number, number]): MaterialDef {
    return { id: 'mat_' + equipType, name, equipType, fromLevel, desc, color };
}

/**
 * 12 种突破材料。
 *
 * fromLevel 与 EQUIPMENT_TABLE 的 unlockLevel 对齐：
 * 玩家拿到武器之后不久，它对应的材料才开始掉 ——
 * 否则会出现"为了材料去刷一把还没解锁的武器"这种死循环。
 */
/** 神话 → 传说 的专属进化材料 id */
export const MYTH_CORE_ID = 'mat_myth_core';

export const MATERIAL_TABLE: MaterialDef[] = [
    mat('blade', '精铁', 1, '铁剑的突破材料。锋锐而沉重。', [196, 200, 210]),
    mat('bow', '灵木', 1, '短弓的突破材料。弓臂韧性极佳。', [168, 210, 140]),
    mat('orb', '霜晶', 2, '冰晶球的突破材料。凝结不散。', [140, 210, 236]),
    mat('spear', '玄铁', 3, '长枪的突破材料。贯穿一切的长身。', [150, 160, 178]),
    mat('hammer', '陨铁', 3, '铁锤的突破材料。带着落地的重量。', [186, 130, 96]),
    mat('dagger', '流银', 4, '飞刃的突破材料。薄而快。', [214, 224, 232]),
    mat('staff', '雷石', 5, '雷杖的突破材料。内部有细微电弧。', [246, 200, 110]),
    mat('scythe', '幽铁', 6, '巨镰的突破材料。刃口泛着冷光。', [148, 140, 176]),
    mat('cannon', '重晶', 7, '重炮的突破材料。压舱用的密度。', [206, 118, 92]),
    mat('shuriken', '风羽', 8, '手里剑的突破材料。轻薄如羽。', [170, 220, 190]),
    mat('lance', '星砂', 9, '光矛的突破材料。细碎而恒亮。', [226, 226, 250]),
    mat('wheel', '轮心', 5, '回旋轮的突破材料。整枚装备的中轴。', [200, 196, 208]),

    // ================================================================
    // 第八轮：神话 → 传说 的专属进化材料
    //
    // 它**不对应任何武器类型**（equipType 只是占位），因为它服务的是
    // "神话品阶进化到传说"这一件事，而不是某一把武器的升级。
    //
    // 掉落条件极其严格（见 LevelFlow.rollMythCore）：
    //   - 关卡属性数 = 3（第 9~12 关，"三复合关卡"）
    //   - 难度 = 噩梦
    // 这是全游戏唯一无法用金币、碎片、广告替代的材料 ——
    // 它保证"传说"这个品阶必须真的把那几关的噩梦打通，
    // 而不是靠攒资源就能买到。
    // ================================================================
    {
        id: MYTH_CORE_ID,
        name: '神话之核',
        equipType: 'wheel',
        fromLevel: 9,
        desc: '仅三复合关卡（第 9~12 关）的噩梦难度掉落。神话品阶进化为传说的唯一钥匙',
        color: [240, 200, 120],
    },
];

/** 专属进化材料的显示名 */
export function mythCoreName(): string {
    const d = getMaterialDef(MYTH_CORE_ID);
    return d ? d.name : '神话之核';
}

/** 三复合关卡的属性数门槛：只有属性数正好 3 的关卡才掉专属材料 */
export const TRIPLE_COMPOSITE_ELEMENTS = 3;

const MATERIAL_BY_TYPE: Record<string, MaterialDef> = {};
for (const m of MATERIAL_TABLE) MATERIAL_BY_TYPE[m.equipType] = m;

/** 取某武器类型的突破材料定义 */
export function materialForType(t: EquipType): MaterialDef {
    return MATERIAL_BY_TYPE[t] || MATERIAL_BY_TYPE['blade'];
}

/** 按 id 取材料定义 */
export function getMaterialDef(id: MaterialId): MaterialDef | null {
    for (const m of MATERIAL_TABLE) if (m.id === id) return m;
    return null;
}

// ====================================================================
// 武器等阶
// ====================================================================

/** 最高等阶 */
export const MAX_WEAPON_RANK = 5;

/** 各阶需要的突破材料数 */
export const RANK_MATERIAL_COST: number[] = [3, 6, 12, 20, 0];

/**
 * 各阶能镶嵌的属性数量 —— 这就是"一阶只可以加一个"。
 *
 * 注意最后两阶都是 4：5 阶不给新槽位。
 * 代价随阶数**加速上升**（3 / 6 / 12 / 20），而槽位只在前四阶各 +1，
 * 于是"5 阶"纯粹是"把已有的 4 个槽位喂满"的一次昂贵冲刺，
 * 不会让槽位数超过 4 把武器的属性同时生效。
 *
 * 数组长度必须等于 MAX_WEAPON_RANK —— socketSlotsOf() 用 rank - 1 直接索引它，
 * 长度对不上会读到 undefined，然后 while(len < undefined) 恒假、
 * 紧接着 `.length = undefined` 抛 RangeError。
 */
export const RANK_SOCKET_SLOTS: number[] = [1, 2, 3, 4, 4];

/** 某等阶的镶嵌槽位数 */
export function socketSlotsOf(rank: number): number {
    const r = Math.max(1, Math.min(MAX_WEAPON_RANK, Math.floor(rank)));
    return RANK_SOCKET_SLOTS[r - 1];
}

/** 突破到下一阶需要的材料数，满阶返回 -1 */
export function rankCostOf(rank: number): number {
    const r = Math.max(1, Math.min(MAX_WEAPON_RANK, Math.floor(rank)));
    if (r >= MAX_WEAPON_RANK) return -1;
    return RANK_MATERIAL_COST[r - 1];
}

// ====================================================================
// 属性材料
// ====================================================================

/**
 * 属性材料的名字表（24 种）。
 *
 * 刻意给每种属性配一个**符合它性格**的名字，而不是"属性1/属性2"：
 * 玩家要在背包里一眼认出"这是火的那块"，"烈阳石"比"火属性石"更有收集感。
 */
const STONE_NAME: Record<ElementId, string> = {
    fire: '烈阳石', water: '碧澜石', wood: '青木石', metal: '玄铁石',
    grass: '翠芽石', bug: '蜕甲石', stone: '磐岳石', cute: '灵韵石',
    electric: '迅雷石', ice: '霜寂石', wind: '流风石', light: '曦辉石',
    machine: '机核石', sword: '断锋石', combat: '裂石', poison: '蚀骨石',
    ghost: '幽冥石', devil: '血纹石', dragon: '龙鳞石', flying: '翔羽石',
    space: '虚空石', time: '时砂石', earth: '厚土石', normal: '凡尘石',
};

const SHARD_NAME: Record<ElementId, string> = {
    fire: '余烬', water: '水珠', wood: '枝干', metal: '铁屑',
    grass: '草籽', bug: '虫鳞', stone: '碎石', cute: '铃铛',
    electric: '火星', ice: '霜屑', wind: '气流', light: '光尘',
    machine: '螺丝', sword: '断刃', combat: '掌风', poison: '毒腺',
    ghost: '残影', devil: '邪纹', dragon: '逆鳞', flying: '翎羽',
    space: '裂隙', time: '时屑', earth: '岩屑', normal: '尘粒',
};

/** 一个完整属性材料的名字 */
export function elementStoneName(e: ElementId): string {
    return STONE_NAME[e] || '属性石';
}

/** 碎片名字 */
export function elementShardName(e: ElementId): string {
    return SHARD_NAME[e] || '属性碎片';
}

/** 几个碎片合成一个完整材料 */
export const SHARDS_PER_STONE = 10;

/**
 * 全属性石的物品 id。
 *
 * ⚠️ 第九轮起防具改为抽卡获取，原本的消费方 `craftArmor()` 被移除，
 *    全属性石一度成了**死道具**（缺口 A-6）。
 *
 * ✅ 第十一轮已关闭：它是隐藏养成线「万象线」**唯一的燃料**
 *    （`ForgeManager.advanceOmni()`，4 级共消耗 4 个），终点授予
 *    四件套「万象套」（全部传说 / 24 轴抗性）。
 *    保留 id 与文案的初衷不变 —— 让存档与 UI 不崩。
 */
export const OMNI_STONE_ID = 'stone_omni';

export function omniStoneName(): string {
    return '全属性石';
}

/**
 * 全属性石需要的碎片。
 *
 * 24 种属性各 10 个 = **240 个碎片**。这是全属性防具唯一的门槛，
 * 且它是**时间与地图覆盖**上的门槛 —— 玩家必须把六组属性关都打穿，
 * 而不是"看广告就有"。
 */
export const OMNI_SHARD_COST: Record<ElementId, number> = {
    fire: SHARDS_PER_STONE, water: SHARDS_PER_STONE, wood: SHARDS_PER_STONE, metal: SHARDS_PER_STONE,
    grass: SHARDS_PER_STONE, bug: SHARDS_PER_STONE, stone: SHARDS_PER_STONE, cute: SHARDS_PER_STONE,
    electric: SHARDS_PER_STONE, ice: SHARDS_PER_STONE, wind: SHARDS_PER_STONE, light: SHARDS_PER_STONE,
    machine: SHARDS_PER_STONE, sword: SHARDS_PER_STONE, combat: SHARDS_PER_STONE, poison: SHARDS_PER_STONE,
    ghost: SHARDS_PER_STONE, devil: SHARDS_PER_STONE, dragon: SHARDS_PER_STONE, flying: SHARDS_PER_STONE,
    space: SHARDS_PER_STONE, time: SHARDS_PER_STONE, earth: SHARDS_PER_STONE, normal: SHARDS_PER_STONE,
};

/** 一次掉落的碎片数量下界：保证"打一遍就有收获"，不掉 0 */
export const SHARD_DROP_MIN = 1;
/** 一次掉落的碎片数量上界 */
export const SHARD_DROP_MAX = 3;

/** 某关会掉哪些属性碎片 —— 与该关属性一致 */
export function shardElementsOfLevel(levelId: number, elements: ElementId[]): ElementId[] {
    return elements.slice();
}

export { ELEMENT_IDS };