/**
 * 关卡策划表 + 难度曲线 + 档案裁剪
 *
 * 【难度基调：微信小游戏，宁可偏简单】
 *
 * 这是个微信小游戏，玩家绝大多数是碎片时间进来的泛用户，不是硬核玩家。
 * 目标体验是"打得爽、进化快、死不掉"，所以：
 *   - 关卡间增长只有 10%（硬核向的 20%+ 曲线在这里会把玩家劝退）
 *   - 敌人血量锚定在"玩家不继承也能轻松打掉"的水平
 *   - 经验产出给得足，一局内就能看到装备进化
 *
 * 【难度维度叠加在关卡维度之上】
 *
 *   最终敌人强度 = 关卡成长(levelScale) × 难度倍率(diff.hpMul / atkMul …)
 *
 * 这两个维度是正交的，各自独立可调：
 *   - 关卡成长让"同一难度下越往后越难"
 *   - 难度倍率让"同一关的困难/噩梦明显更凶"
 *
 * 真机调优时只需要动 DIFFICULTY_EASE 一个数字：
 *   0.8 = 整体更简单，1.2 = 整体更难。改它不影响任何其他逻辑。
 */

import {
    AttrMap,
    DifficultyDef,
    EquipRunState,
    LevelConfigItem,
    LevelState,
} from './GameTypes';
import { EnemySpawnSpec } from '../battle/BattleTypes';
import { getDifficulty, RANGED_RATIO_MAX } from './DifficultyConfig';
import { elementsForLevel, ElementId } from './ElementConfig';
import { affinityForLevel, formationForLevel, weakForLevel } from './LevelAffinity';
import { legacyFormId, requireForm } from './FormConfig';

/** 可被继承的数值白名单：不在表里的字段永远不进档案 */
export const CARRY_WHITELIST: string[] = [
    'coin', 'gem',           // 资源
    'atk', 'hp', 'critRate', 'speed',  // 属性
];

/** 继承系数：1.0 = 全量继承 */
export const CARRY_RATE = 1.0;

/** 全局难度松紧旋钮：0.8 更简单，1.2 更难 */
export const DIFFICULTY_EASE = 1.0;

/** 关卡间难度增长：10% 平缓递增 */
export const LEVEL_GROWTH = 0.10;

/** 第 1 关的敌人基准血量 / 攻击 */
const BASE_ENEMY_HP = 55;
const BASE_ENEMY_ATK = 6;

/**
 * 敌人基准移速（像素/秒）。
 * 明确低于玩家移速（330）—— 这是个"拖动走位"的游戏，
 * 如果敌人跑得比玩家快，走位就失去意义，玩家会被无限贴脸。
 * 敌人只能靠"数量多、从多方向来、远程压制"制造压力，不能靠速度。
 */
const BASE_ENEMY_SPEED = 92;

/** 敌人贴身攻击的间隔（秒） */
const BASE_ENEMY_ATK_INTERVAL = 0.9;

/** 敌人碰撞半径 */
const BASE_ENEMY_RADIUS = 20;

/** 远程怪血量倍率：比近战脆，鼓励玩家优先切入点掉 */
const RANGED_HP_MUL = 0.72;

/** 远程怪移速倍率：比近战灵活，会主动拉开距离 */
const RANGED_SPEED_MUL = 1.15;

/**
 * 远程弹丸伤害相对接触伤害的倍率。
 * 刻意低于 1：远程怪数量多、又是持续骚扰，如果单发和贴脸一样疼
 * 高难度会变成"一进场就被秒"，那是劝退而不是难度。
 */
const RANGED_SHOT_ATK_MUL = 0.72;

/**
 * 关卡进度额外带来的远程怪比例（同一难度下越往后越多）。
 *
 * 封顶 +3 个点：噩梦基础 0.42 + 关卡最多 +3 + 复玩最多 +6 收敛到
 * RANGED_RATIO_MAX = 0.45，恰好就是封顶。普通 / 困难 加完所有加成也到不了，
 * 符合"只有噩梦难度达到 42%+"。
 * 早期关卡（1、2 关）完全不加，保证新手前两关看不到远程弹丸。
 */
function levelRangedBonus(levelId: number): number {
    if (levelId <= 2) return 0;
    return Math.min(0.03, (levelId - 2) * 0.0025);
}

/** 每只敌人提供的经验：随关卡与难度小幅增长，保证一局内能看到进化 */
function expPerEnemy(levelId: number, diff: DifficultyDef): number {
    const base = 30 + levelId * 2;
    // 高难度怪更肉、打得更久，经验给一点补偿，避免"打完一局还没进化"
    return Math.round(base * (1 + (diff.tier - 1) * 0.25));
}

/** 通关发放的永久金币（用于局外升级装备），已乘难度倍率 */
function goldReward(levelId: number, diff: DifficultyDef): number {
    return Math.round((90 + levelId * 22) * diff.goldMul);
}

/**
 * 不继承、从零开局时的初始数据。
 * 刻意不随关卡变化：装备伤害由 EquipmentManager 独立提供，
 * 局内的初始属性只需要保证"有血能扛、能打出去"即可。
 *
 * hp 给得比较厚（100）：走位玩法里玩家挨打往往是操作失误，
 * 一两次失误就死会让泛用户直接流失，给足容错。
 */
function initialFor(): { resources: AttrMap; stats: AttrMap } {
    return {
        resources: { coin: 0, gem: 0 },
        // 注意：这里不放装备的基础伤害，避免"同一份攻击被算两次"。
        stats: { atk: 0, hp: 100, critRate: 0.05, speed: 1 },
    };
}

/**
 * 取某一关某一难度的完整配置。
 *
 * @param levelId     关卡号，从 1 开始
 * @param difficulty  难度层级，1~MAX_TIER，越界自动收敛
 * @param replayBoost 复玩加难百分比，0 = 未加难。
 *                    与档位倍率是**乘算**关系：最终 = 档位倍率 × (1 + boost)。
 *                    金币产出也跟着抬，否则"自己加难"就是纯找苦吃，没人会开。
 */
export function getLevelConfig(levelId: number, difficulty = 1, replayBoost = 0): LevelConfigItem {
    const diff = getDifficulty(difficulty);
    const boost = Math.max(0, replayBoost);
    const boostMul = 1 + boost;

    const levelScale = Math.pow(1 + LEVEL_GROWTH, levelId - 1) * DIFFICULTY_EASE;

    const init = initialFor();
    const baseEnemyAtk = BASE_ENEMY_ATK * levelScale;

    // 敌人数量：关卡成长 × 难度倍率（复玩加难只加数量的一半权重，避免变成纯人海）
    const enemies = Math.max(3, Math.round(
        (4 + Math.floor(levelId / 2)) * diff.countMul * (1 + boost * 0.5)
    ));

    // 远程怪比例：难度基础值 + 关卡进度增量 + 复玩加难，全部收敛到 RANGED_RATIO_MAX。
    // 噩梦基础 0.42 + 关卡最多 +3 + 复玩最多 +6 = 0.51 > 0.45 → 收敛到 0.45（封顶）。
    // 普通 / 困难 加完所有也到不了 0.45，符合"只有噩梦难度远程 42%+"。
    const rangedRatio = Math.min(
        RANGED_RATIO_MAX,
        diff.rangedRatio + levelRangedBonus(levelId) + boost * 0.06
    );

    // 噩梦档新种类合计占 25%（精英 8 + 突进 12 + 冲锋 5），其余 50% 是普通近战。
    // 这个比例是设计上有意的：
    //   精英少而肉：8% 大概一关只刷 1~2 只，是持续压力源
    //   突进较多：12% 给玩家足够多的"突然加速贴脸"练习
    //   冲锋更少：5% 每次出现都给玩家"读招预判"的考验，太多会让战斗变成躲蓄力圈
    const isNightmare = diff.tier === 3;

    return {
        levelId,
        difficulty: diff.tier,
        diff,
        replayBoost: boost,
        formation: formationForLevel(levelId),
        /** 该关的属性池：前期 1 种，越往后复合的属性越多 */
        elements: elementsForLevel(levelId),
        affinityWeaponIds: affinityForLevel(levelId),
        weakWeaponIds: weakForLevel(levelId),
        enemies,
        baseEnemyHp: Math.round(BASE_ENEMY_HP * levelScale * diff.hpMul * boostMul),
        baseEnemyAtk: Math.round(baseEnemyAtk * diff.atkMul * boostMul),
        expPerEnemy: expPerEnemy(levelId, diff),
        goldReward: Math.round(goldReward(levelId, diff) * (1 + boost * 0.8)),
        reward: {
            coin: Math.round(60 * levelScale * diff.goldMul * (1 + boost * 0.8)),
            gem: levelId % 5 === 0 ? 5 + Math.floor(levelId / 5) : 0,
            // 关卡内的属性成长（会进入档案被继承）
            atk: Math.round(6 * levelScale),
            hp: Math.round(15 * levelScale),
        },
        initialResources: init.resources,
        initialStats: init.stats,

        // ---- 战斗层参数 ----
        enemySpeed: Math.round(BASE_ENEMY_SPEED * (1 + (levelScale - 1) * 0.35) * diff.speedMul),
        enemyAtkInterval: BASE_ENEMY_ATK_INTERVAL,
        enemyRadius: BASE_ENEMY_RADIUS,
        // 分 3 波投放，避免一开局就被全场围殴
        batchSize: Math.max(2, Math.ceil(enemies / 3)),
        batchInterval: 3.2,

        // ---- 远程怪参数 ----
        rangedRatio,
        rangedHpMul: RANGED_HP_MUL,
        rangedSpeedMul: RANGED_SPEED_MUL,
        kiteRange: diff.kiteRange,
        shotSpeed: diff.shotSpeed,
        shotAtk: Math.max(2, Math.round(baseEnemyAtk * diff.atkMul * RANGED_SHOT_ATK_MUL * boostMul)),
        shotInterval: diff.shotInterval,

        // ---- 噩梦专有的新种类（普通 / 困难 强制 0）----
        eliteRatio: isNightmare ? 0.08 : 0,
        swiftRatio: isNightmare ? 0.12 : 0,
        chargerRatio: isNightmare ? 0.05 : 0,
    };
}

/** 是否还有下一关 */
export function hasNextLevel(levelId: number): boolean {
    return levelId < 200;
}

/**
 * 把关卡配置翻译成战斗层的敌人生成参数。
 * 战斗层不认识 LevelConfigItem，只吃 EnemySpawnSpec，
 * 这一层转换让"改策划表 → 战斗表现变化"的链路保持单向。
 */
export function buildEnemySpawnSpec(cfg: LevelConfigItem): EnemySpawnSpec {
    return {
        count: cfg.enemies,
        hp: cfg.baseEnemyHp,
        atk: cfg.baseEnemyAtk,
        speed: cfg.enemySpeed,
        radius: cfg.enemyRadius,
        atkInterval: cfg.enemyAtkInterval,
        expValue: cfg.expPerEnemy,
        batchSize: cfg.batchSize,
        batchInterval: cfg.batchInterval,

        formation: cfg.formation,
        elements: cfg.elements,

        rangedRatio: cfg.rangedRatio,
        rangedHpMul: cfg.rangedHpMul,
        rangedSpeedMul: cfg.rangedSpeedMul,
        kiteRange: cfg.kiteRange,
        shotSpeed: cfg.shotSpeed,
        shotAtk: cfg.shotAtk,
        shotInterval: cfg.shotInterval,

        // 噩梦专有三种（普通 / 困难 为 0，所以不会刷出）
        eliteRatio: cfg.eliteRatio,
        swiftRatio: cfg.swiftRatio,
        chargerRatio: cfg.chargerRatio,
    };
}

/**
 * 把本次运行态裁剪成可写入档案的 loadout。
 *
 * 三处裁剪同时发生：
 *   1. resources / stats 按 CARRY_WHITELIST 过滤
 *   2. CARRY_RATE 控制继承系数（当前 1.0 全量）
 *   3. 装备的形态按形态图收敛，防止被改过的存档带入非法 formId
 */
export function buildLoadout(state: LevelState): {
    resources: AttrMap;
    stats: AttrMap;
    equipment: EquipRunState[];
    talents: Record<string, number>;
} {
    const take = (o: AttrMap, isInt: boolean): AttrMap => {
        const out: AttrMap = {};
        for (const k of CARRY_WHITELIST) {
            if (o[k] === undefined) continue;
            const v = o[k] * CARRY_RATE;
            out[k] = isInt ? Math.floor(v) : Number(v.toFixed(4));
        }
        return out;
    };

    const equipment: EquipRunState[] = [];
    const lo = state.loadout;

    /**
     * 形态收敛：老档案只有 (id, stage)，先反查成 formId 再校验。
     * 如果 formId 在形态表里已经不存在（改过配置表），就退回到根形态 ——
     * 宁可让玩家掉一层形态，也不能让一个不存在的形态进入战斗。
     */
    const clip = (st: EquipRunState, kind: 'weapon' | 'aux'): void => {
        let formId = st.formId;
        if (!formId) {
            formId = kind === 'weapon' ? legacyFormId(st.id, st.stage) : st.id;
        }
        let depth = st.stage || 0;
        try {
            depth = requireForm(formId).depth;
        } catch (e) {
            formId = kind === 'weapon' ? legacyFormId(st.id, 0) : st.id;
            depth = 0;
        }
        equipment.push({
            id: st.id,
            formId,
            kind,
            stage: Math.max(0, depth),
            exp: Math.max(0, Math.floor(st.exp)),
        });
    };

    if (lo) {
        for (const st of lo.weapons || []) clip(st, 'weapon');
        for (const st of lo.auxes || []) clip(st, 'aux');
    }

    const talents: Record<string, number> = {};
    if (lo && lo.talents) {
        for (const k of Object.keys(lo.talents)) {
            const n = Math.floor(lo.talents[k]);
            if (n > 0) talents[k] = n;
        }
    }

    return {
        resources: take(state.resources, true),
        stats: take(state.stats, false),
        equipment,
        talents,
    };
}

/** 给 UI 用的一句话摘要 */
export function describeLoadout(loadout: {
    resources: AttrMap;
    stats: AttrMap;
    equipment?: EquipRunState[];
}): string {
    const parts: string[] = [];
    const r = loadout.resources;
    const s = loadout.stats;
    if (r['coin'] !== undefined) parts.push('金币 ' + r['coin']);
    if (r['gem'] !== undefined && r['gem'] > 0) parts.push('宝石 ' + r['gem']);
    if (s['hp'] !== undefined) parts.push('生命 ' + s['hp']);
    return parts.join(' · ') || '基础数据';
}
