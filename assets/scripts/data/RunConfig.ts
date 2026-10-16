/**
 * 局内规则配置 —— 槽位上限、经验曲线、三选一规则
 *
 * 【为什么槽位上限要有两组数字】
 *
 *   基准 6 个武器槽 + 6 个辅助槽，这是"一局正常能玩到的手感"。
 *   复玩时各 +2 —— 这是玩家明确要的："复玩的时候可以加两个"。
 *
 *   把它做成"复玩加成"而不是直接提高基准，是因为：
 *   首次开荒时槽位少，玩家的每一次三选一都是**取舍**（要不要换掉现有武器）；
 *   槽位多了之后取舍变松，是复玩才配得上的松弛感。
 *   如果基准就是 8，首局也会变成"全都拿着"，选择就没有重量了。
 *
 * 【为什么三选一要按类别轮转】
 *
 *   如果每次升级都从混池里随机抽 3 个，会出现两种坏情况：
 *     - 抽到 3 个武器进化，但槽位都满了 / 都没到进化条件 → 三张卡全是灰的
 *     - 连续几次抽到 3 个辅助装备，玩家想要武器却拿不到 → 节奏被打断
 *
 *   所以按 level 轮转"主类别"，主类别出 2 张、其他类别补 1 张：
 *   既保证每类都会规律出现，又保证同一屏内的选项是可比的（同类比较才有意义）。
 */

/** 武器槽基准上限 */
export const WEAPON_SLOT_BASE = 6;
/** 辅助装备槽基准上限 */
export const AUX_SLOT_BASE = 6;

/**
 * 复玩（携带老档进入）时，武器槽与辅助槽各额外开放的数量。
 * 玩家原话："复玩的时候可以加两个"。
 */
export const REPLAY_SLOT_BONUS = 2;

/** 一次三选一给几个候选 */
export const REWARD_CHOICES = 3;

/** 主类别每轮出几张卡 */
export const FOCUS_TAKE = 2;

/** 关卡等级经验的起点与增长率 */
export const LEVEL_EXP_BASE = 70;
export const LEVEL_EXP_GROWTH = 1.30;

/** 一局内等级上限（防止极端情况下的无限循环） */
export const MAX_RUN_LEVEL = 60;

/** 武器槽上限 */
export function weaponSlotCap(replay: boolean): number {
    return WEAPON_SLOT_BASE + (replay ? REPLAY_SLOT_BONUS : 0);
}

/** 辅助装备槽上限 */
export function auxSlotCap(replay: boolean): number {
    return AUX_SLOT_BASE + (replay ? REPLAY_SLOT_BONUS : 0);
}

/** 从 level 升到 level+1 需要的经验 */
export function levelExpFor(level: number): number {
    const l = Math.max(1, Math.min(MAX_RUN_LEVEL, Math.floor(level)));
    return Math.round(LEVEL_EXP_BASE * Math.pow(LEVEL_EXP_GROWTH, l - 1));
}

// ====================================================================
// 三选一的类别轮转
// ====================================================================

/** 奖励主类别 */
export type RewardFocus = 'weapon' | 'talent' | 'aux';

const REWARD_FOCUS_ORDER: RewardFocus[] = ['weapon', 'talent', 'aux'];

/**
 * 主类别的轮转偏移。
 *
 * 本作**第一次三选一发生在升到 2 级**时（1 级是开局，没有面板）。
 * 不加偏移时 `2 % 3 = 2` 会落到辅助档上 —— 玩家开局第一张卡是件辅助装备，
 * 完全感受不到"武器会进化"这个核心。
 * 加 1 之后首次落到武器档，开局就能看到武器进化，玩法的重心第一眼就交代清楚。
 */
const FOCUS_OFFSET = 1;

/**
 * 本次升级的主类别。
 *
 * 用 level 取模轮转而不是随机 —— 随机会出现连续三次都是辅助装备的情况，
 * 而轮转保证"最多隔一次就会轮到武器"，玩家对节奏有预期。
 */
export function rewardFocusFor(level: number): RewardFocus {
    const n = REWARD_FOCUS_ORDER.length;
    const i = ((Math.floor(level) + FOCUS_OFFSET) % n + n) % n;
    return REWARD_FOCUS_ORDER[i];
}

// ====================================================================
// 关卡武器适配（"每个关卡最合适的武器都不一样"的数值落地）
// ====================================================================

/** 携带该关推荐武器时的伤害加成 */
export const AFFINITY_DAMAGE_MUL = 1.25;
/** 携带该关推荐武器时的金币加成 */
export const AFFINITY_GOLD_MUL = 1.30;
/** 携带该关克制武器时的伤害惩罚 */
export const WEAK_DAMAGE_MUL = 0.80;

/** 判定"是否用到了推荐武器"所需的最少件数 */
export const AFFINITY_MIN_COUNT = 1;
