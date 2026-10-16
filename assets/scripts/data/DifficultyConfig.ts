/**
 * 难度体系配置
 *
 * 【为什么难度要做成"每关 × 三档"而不是一条全局难度线】
 *
 * 一条全局难度线（通关后整局游戏变难）会带来一个致命体验问题：
 * 玩家在第 12 关卡住了，唯一的出路是"变强"，而变强又只能靠打第 12 关 ——
 * 死循环。每关独立解锁不会有这个问题：第 12 关打不过就去打第 11 关的困难难度，
 * 那里既能练手、又能拿更高的金币产出，是**平行可选项**而不是唯一出路。
 *
 * 【难度只能靠"打过了"解锁，不能直接跳级】
 *   第 1 关：只有普通 → 通关普通后解锁困难 → 通关困难后解锁噩梦
 *   这个顺序保证了玩家在进入噩梦之前，已经通过困难难度采集到足够的金币
 *   把装备局外等级升上去，并且已经获得了更高难度的专属装备。
 *
 * 【难度提升是多维度的】
 * 只加血量会让战斗从"刺激"变成"磨损"，玩家体感是累而不是难。所以：
 *   - 血量 / 攻击 / 移速 / 数量 同时抬
 *   - 远程怪比例抬（改变战斗结构：从"贴脸互殴"变成"必须主动切入"）
 *   - 金币产出抬（高难度必须有明确回报，否则没人愿意打）
 *
 * 【难度还是"开放"的闸门】
 *   - 出战槽位：全局最高难度 1/2/3 → 可同时出战 2/3/4 件武器
 *   - 新装备：装备的 unlockDifficulty 卡在这里（见 EquipmentConfig）
 * 于是"推进难度"不只是怪更硬，而是实打实的能力扩张。
 */

import { DifficultyDef } from './GameTypes';

/** 难度档数的上限，等于 DIFFICULTY_TABLE.length */
export const MAX_TIER = 3;

/**
 * 难度表。
 *
 * 数值取"能打过，但必须认真走位"为准 —— 这是微信小游戏，
 * 高难度是给少数愿意钻研的玩家准备的自选项，不是卡主线的墙。
 *
 * 【远程怪比例为什么从 40% 放宽到 45%】
 *   上一轮把噩梦的 rangedRatio 压到 0.34 + 关卡进度 +6%，结果被动玩法全通关，
 *   "噩梦必须走位"这堵墙被削平了。玩家原话："把噩梦的远程比例拉到 42% 甚至更高"。
 *   现在噩梦基础值 0.42 + 关卡进度最高 +3%（调小以免超出太多），
 *   **正好顶到 45%**。45% 仍然低于"同屏弹丸挤占注意力"的体感门槛
 *   （实测 50%+ 才会出现明显的手忙脚乱感），但已经远超被动玩法能承受的水平。
 */
export const DIFFICULTY_TABLE: DifficultyDef[] = [
    {
        tier: 1,
        id: 'normal',
        name: '普通',
        hpMul: 1.0,
        atkMul: 1.0,
        speedMul: 1.0,
        countMul: 1.0,
        goldMul: 1.0,
        scoreMul: 1.0,
        rangedRatio: 0.10,
        kiteRange: 300,
        shotSpeed: 260,
        shotInterval: 2.4,
        desc: '标准体验。敌人不算硬，远程小怪零星出现，先把走位和装备手感摸熟',
        color: [78, 154, 214],
    },
    {
        tier: 2,
        id: 'hard',
        name: '困难',
        hpMul: 1.9,
        atkMul: 1.45,
        speedMul: 1.10,
        countMul: 1.3,
        goldMul: 1.8,
        scoreMul: 1.5,
        rangedRatio: 0.24,
        kiteRange: 320,
        shotSpeed: 300,
        shotInterval: 2.0,
        desc: '敌人更硬更凶，远程小怪明显变多，站着不动会被射穿，必须主动切入',
        color: [230, 145, 56],
    },
    {
        tier: 3,
        id: 'nightmare',
        name: '噩梦',
        hpMul: 3.3,
        atkMul: 2.05,
        speedMul: 1.20,
        countMul: 1.6,
        goldMul: 3.0,
        scoreMul: 2.2,
        rangedRatio: 0.42,
        kiteRange: 360,
        shotSpeed: 380,
        shotInterval: 1.5,
        desc: '血厚攻高、远程成片。除了被动挨打还会遇到精英怪 / 突进怪 / 冲锋怪，不带继承装备基本打不动',
        color: [200, 68, 78],
    },
];

/** 把任意输入收敛成合法的难度层级（1 ~ MAX_TIER） */
export function normalizeTier(tier: number): number {
    if (!tier || !isFinite(tier)) return 1;
    return Math.max(1, Math.min(MAX_TIER, Math.floor(tier)));
}

/**
 * 远程怪占全部敌人的**硬上限**，0.45。
 *
 * 这是一个跨三档难度的**总量封顶**：难度基础值 + 关卡进度加成 + 复玩加难加成
 * 相加后必须收敛到这里，不允许任何组合突破。
 *
 * 历史：原本是 0.40（第一轮用户原话"上限 40% 就够"），上一轮保持。
 * 第五轮因为噩梦的 rangedRatio 提到 0.42，本封顶放宽到 0.45 让噩梦+靠后关卡
 * 能叠到 42~45%。**普通 / 困难 永远到不了这个上限**（它们的基础值 0.10/0.24 +
 * 关卡进度最高 +0.03 ≈ 0.37），所以放宽只影响噩梦，符合用户"只有恶魔难度达到 42%"。
 */
export const RANGED_RATIO_MAX = 0.45;

/** 取某一档难度定义，越界自动收敛 */
export function getDifficulty(tier: number): DifficultyDef {
    return DIFFICULTY_TABLE[normalizeTier(tier) - 1];
}

export function getDifficultyName(tier: number): string {
    return getDifficulty(tier).name;
}

/** 是否还有更高一档难度 */
export function hasNextTier(tier: number): boolean {
    return normalizeTier(tier) < MAX_TIER;
}

// ====================================================================
// 难度驱动的能力解锁
// ====================================================================

/** 出战槽位的硬上限 */
export const EQUIP_SLOT_LIMIT = 4;

/**
 * 出战槽位数量 = 1 + 全局最高难度，封顶 EQUIP_SLOT_LIMIT。
 *
 * 普通 2 件 / 困难 3 件 / 噩梦 4 件。
 * 这是"推进难度"最直接的回报：多一件武器不是数值增长，
 * 而是多一套瞄准方式同时生效（前向 + 锁定 + 全屏可以一起带）。
 */
export function getEquipSlotCount(globalMaxTier: number): number {
    const t = Math.max(1, Math.floor(globalMaxTier || 1));
    return Math.min(EQUIP_SLOT_LIMIT, 1 + t);
}

/** 下一档难度会额外开放什么，用于结算页与难度面板的引导文案 */
export function describeTierReward(tier: number): string {
    const parts: string[] = [];
    const curSlots = getEquipSlotCount(tier - 1 < 1 ? 1 : tier - 1);
    const nextSlots = getEquipSlotCount(tier);
    if (nextSlots > curSlots) parts.push('出战槽位 +' + (nextSlots - curSlots));
    const d = getDifficulty(tier);
    parts.push('金币 ×' + d.goldMul);
    if (d.rangedRatio > 0) parts.push('远程小怪增多');
    return parts.join(' · ');
}
