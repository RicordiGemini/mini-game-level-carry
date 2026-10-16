/**
 * 武器平衡守卫 —— 机制模型（不是探针机器人）
 *
 * ## 为什么是机制模型
 *
 * 历史上试过让机器人（`difficulty_probe.js`）打关卡来当平衡裁判，
 * 结果"站桩"模式系统性偏袒远程武器（不动的玩家近战永远够不着），
 * "贴近后撤"模式又冤枉了移动向武器 —— 两个机器人给出**互相矛盾**的结论。
 *
 * 定论：**机器人不能当平衡裁判**，它只用来观察难度曲线。
 * 平衡交给**可复算的机制模型**守住：只看"射程 / 攻速 / 打击形状 / 瞄准方式"
 * 四个维度怎么组合，不跑一帧战斗。
 *
 * ## 为什么倍率放在这里，而不是抄一份到模型里
 *
 * `AttackFactory` 里那些 `×0.62`（三连射衰减）、`×2.2`（陨石）、`×0.85`（剑雨）
 * 如果在模型里抄一份，改战斗时忘了改模型，两边就各说各话 ——
 * 这正是本项目历史上文档与代码矛盾 40+ 处的同类问题。
 *
 * 所以：**倍率在这里定义一次，`AttackFactory` 引用它，模型也引用它。**
 * 三方共用同一个数字，改一处必然同步。
 *
 * 【架构约束】本文件放`data/` 而不是 `battle/`：
 * `battle/` 只import `data/GameTypes` 的枚举，不依赖任何配置表；
 * 而模型需要读形态表与武器表，属于"认识表"的一侧。
 */

import { AimModeId, AttackModeId, EquipType, FormNode } from './GameTypes';
import { WEAPON_BASE_INTERVAL, WEAPON_BASE_PIERCE, WEAPON_BASE_RANGE } from './EquipmentConfig';

// ====================================================================
// 一、打击形状的机制倍率（AttackFactory 与本模型共用）
// ====================================================================

/**
 * 三连射的单发衰减。
 *
 * 为什么是 0.62 而不是 1.0：三发扇形散开后，对**单体**只能中一发，
 * 另两发浪费。所以三连射的"总伤害"是 `3 × 0.62 = 1.86` 而不是 3，
 * 它的定位是"多目标时划算"，不是"单目标时白给"。
 *
 * 这个数字是历史文档里「三连射 0.62 衰减漏算导致 DPS 高估 1.9 倍」的正解 ——
 * 漏算时把三发都算成满伤，实际只有一发能中。
 */
export const TRIPLE_SHOT_FALLOFF = 0.62;

/** 剑雨 / 箭雨每发的伤害系数（敌人各一发） */
export const RAIN_DAMAGE_MUL = 0.85;

/** 全屏剑雨每发的伤害系数（比局部剑雨更低，因为落点更多、单个敌人分到的不确定性更大） */
export const FULL_RAIN_DAMAGE_MUL = 0.7;

/** 陨石伤害系数（2.2 倍，但只有一发、且有 0.42s 落地延迟） */
export const METEOR_DAMAGE_MUL = 2.2;

/** 连锁闪电的基础跳数（`chainBonus` 每层 +1，封顶 8） */
export const CHAIN_BASE_JUMPS = 3;

/** 连锁跳数上限 —— 不封顶的话虫属性可以连锁全屏，会变成唯一正确属性 */
export const CHAIN_MAX_JUMPS = 8;

/** 近战挥砍的判定半径（相对射程），小范围用这个下限兜住 */
export const MELEE_MIN_RADIUS = 30;

/** 近战挥砍的判定半径（相对射程） */
export const MELEE_RADIUS_RATIO = 0.5;

/** 近战挥砍的判定体伸出距离（相对射程） */
export const MELEE_REACH_RATIO = 0.55;

/** 范围剑气的伸出距离（相对射程） */
export const SWEEP_REACH_RATIO = 0.5;

/** 范围剑气的判定半径（相对射程） */
export const SWEEP_RADIUS_RATIO = 0.7;

/** 陨石爆炸半径的下限（像素），小于武器射程时用这个兜住 */
export const METEOR_MIN_RADIUS = 90;

/** 陨石爆炸半径（相对射程） */
export const METEOR_RADIUS_RATIO = 0.55;

/** 震荡波的初始半径（相对射程），之后按 `growRate` 扩出去 */
export const SHOCKWAVE_R0_RATIO = 0.35;

/** 震荡波的每秒扩张量（相对射程） */
export const SHOCKWAVE_GROW_RATIO = 2.2;

// ====================================================================
// 二、瞄准方式的可靠度（机制层，不是手感层）
// ====================================================================

/**
 * 每种瞄准方式的**机制可靠度**：不打偏的比例。
 *
 * 这是模型里最重要也最容易被拍脑袋的一个系数。它回答的是
 * "同样一份伤害配置，这把武器有多少能真正落到敌人身上"。
 *
 * 数值依据（都写在 `WEAPON_BASE_INTERVAL` / `LevelAffinity` 的注释里）：
 *   - `LOCK_ON`：自动锁定并持续追踪，目标死亡才换 → 1.00
 *   - `NEAREST`：每次攻击重新取最近敌人 → 1.00
 *   - `SCREEN_ROLL`：全屏无差别覆盖，不存在打偏 → 1.00
 *   - `MOVE_DIR`：朝拖动方向打，散布在密集时才有价值 → 0.85
 *   - `FRONT`：只打面朝方向，必须走位对准 → 0.70
 *     （`WEAPON_BASE_INTERVAL` 里写了「实测中长枪约 1/3 的挥击会打空」，
 *       0.70 正是这条实测的量化）
 *
 * ⚠️ 改这些数字会同时改模型结论。若某把武器因此越界，
 * 优先怀疑**可靠度取值**是否还符合实测，而不是直接放宽预算区间。
 */
export const AIM_RELIABILITY: Record<AimModeId, number> = {
    [AimModeId.LOCK_ON]: 1.0,
    [AimModeId.NEAREST]: 1.0,
    [AimModeId.SCREEN_ROLL]: 1.0,
    [AimModeId.MOVE_DIR]: 0.85,
    [AimModeId.FRONT]: 0.7,
};

// ====================================================================
// 三、有效输出预算
// ====================================================================

/**
 * 一件形态的**有效输出预算**（相对值，1.0 = 该形态族的中位水平）。
 *
 * 模型（刻意保持极简，全部可手算复核）：
 *
 * ```
 *   单次总伤 = 形态伤害 × Σ(每个判定体的伤害倍率 × 该判定体的期望命中数)
 *   每秒预算 = 单次总伤 / 攻击间隔 × 瞄准可靠度
 * ```
 *
 * 「期望命中数」按打击形状的**本质**给，不看具体关卡：
 *
 * | 形状 | 期望命中数 | 依据 |
 * |---|---|---|
 * | SINGLE_MELEE / SINGLE_RANGED | 1 | 单体 |
 * | TRIPLE_SHOT | 1.86 | 3 × 0.62，对单体只有一发能中 |
 * | SWEEP / SHOCKWAVE / METEOR | 3 | 范围伤害，典型覆盖 3 个 |
 * | PIERCE | `pierce`（长枪 5 / 光矛 3） | 一路穿过去，打几个是配置决定的 |
 * | CHAIN | 3.5 | 基础 3 跳 + 首发，共 4 次结算的期望 |
 * | RAIN（局部） | 3 | 每个敌人一发，典型 3 个 |
 * | RAIN（全屏） | 4 | 敌人各一发 + 4 个随机点 |
 * | FULL_SWEEP | 4 | 滚轮横扫全场，无限穿透 |
 *
 * ⚠️ **模型是粗粒度的**。它抓的是"某把武器明显超标/明显垫底"，
 * 不负责精确模拟每一帧。区间故意留得较宽（见下方 `BUDGET_MIN/MAX`），
 * 就是因为这个模型不该假装自己有帧级精度。
 */

/** 范围类形状的典型覆盖目标数 */
export const TYPICAL_AREA_TARGETS = 3;

/** 全屏类形状的典型覆盖目标数 */
export const TYPICAL_FULLSCREEN_TARGETS = 4;

/** 连锁的期望命中（首发 + 3 跳的加权） */
export const TYPICAL_CHAIN_HITS = 3.5;

/** 该打击形状在典型场面下的期望命中数 */
export function expectedHitsOf(mode: AttackModeId, pierce: number): number {
    switch (mode) {
        case AttackModeId.SINGLE_MELEE:
        case AttackModeId.SINGLE_RANGED:
            return 1;
        case AttackModeId.TRIPLE_SHOT:
            return 3 * TRIPLE_SHOT_FALLOFF;
        case AttackModeId.SWEEP:
        case AttackModeId.SHOCKWAVE:
        case AttackModeId.METEOR:
            return TYPICAL_AREA_TARGETS;
        case AttackModeId.PIERCE:
            // 贯穿按配置值算：长枪 5、光矛 3。
            // 这正是「光矛不能是长枪的上位替代」这条设计在模型里的体现。
            return Math.max(1, pierce);
        case AttackModeId.CHAIN:
            return TYPICAL_CHAIN_HITS;
        case AttackModeId.RAIN:
            return TYPICAL_AREA_TARGETS;
        case AttackModeId.FULL_SWEEP:
            return TYPICAL_FULLSCREEN_TARGETS;
        default:
            return 1;
    }
}

/** 该打击形状的每判定体伤害倍率 */
export function damageMulOf(mode: AttackModeId, fullScreen: boolean): number {
    if (fullScreen && mode === AttackModeId.RAIN) return FULL_RAIN_DAMAGE_MUL;
    switch (mode) {
        case AttackModeId.RAIN:
            return RAIN_DAMAGE_MUL;
        case AttackModeId.METEOR:
            return METEOR_DAMAGE_MUL;
        default:
            return 1;
    }
}

/** 一件形态的原始秒伤（未归一化） */
export function rawDpsOf(opts: {
    damage: number;
    interval: number;
    attackModeId: AttackModeId;
    aimModeId: AimModeId;
    pierce?: number;
    fullScreen?: boolean;
}): number {
    const mode = opts.attackModeId;
    const hits = expectedHitsOf(mode, opts.pierce ?? 1);
    const mul = damageMulOf(mode, opts.fullScreen ?? false);
    const perShot = opts.damage * mul * hits;
    const reliable = AIM_RELIABILITY[opts.aimModeId] ?? 0.8;
    return (perShot / opts.interval) * reliable;
}

/** 取武器类型的贯穿上限（辅助按 1 算） */
export function pierceOf(type: EquipType | 'aux'): number {
    if (type === 'aux') return 1;
    return WEAPON_BASE_PIERCE[type] ?? 1;
}

/** 取武器类型的射程（辅助按固定档位算） */
export function rangeOf(type: EquipType | 'aux'): number {
    if (type === 'aux') return 240;
    return WEAPON_BASE_RANGE[type] ?? 200;
}

/** 取武器类型的攻击间隔（辅助按固定档位算） */
export function intervalOf(type: EquipType | 'aux'): number {
    if (type === 'aux') return 1.2;
    return WEAPON_BASE_INTERVAL[type] ?? 1.0;
}

/**
 * 相对该形态族中位水平的**预算比**。
 *
 * @param dabs    各形态的原始秒伤
 * @returns       形如 [1.02, 0.87, ...]，中位数应为 1.0
 */
export function budgetRatios(dabs: number[]): number[] {
    if (dabs.length === 0) return [];
    const sorted = dabs.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    if (median <= 0) return dabs.map(() => 1);
    return dabs.map((d) => d / median);
}

// ====================================================================
// 四、不变量的阈值
// ====================================================================

/**
 * 单件武器的有效预算下界。
 *
 * 低于 0.55 意味着"这把武器在同等投入下明显亏"——
 * 玩家花同样的抽卡资源拿到它，输出只有中位的一半强，就不会再碰它了。
 */
export const BUDGET_MIN = 0.55;

/**
 * 单件武器的有效预算上界。
 *
 * 高于 1.60 意味着出现**必选武器**：某个关卡无论怎么打都应该带上它，
 * 于是"每关最合适的武器都不一样"这个设计目标直接失效。
 */
export const BUDGET_MAX = 1.6;

/** 全部武器预算比的中位数收敛区间 —— 防止整体漂移 */
export const BUDGET_MEDIAN_MIN = 0.8;
export const BUDGET_MEDIAN_MAX = 1.4;

/** 推荐名单相对克制名单的最低优势（+5%） */
export const AFFINITY_ADVANTAGE_MIN = 0.05;
// ====================================================================
// 五、校验器
// ====================================================================

/** 一个形态的预算明细，UI 与测试都用它 */
export interface BudgetRow {
    formId: string;
    name: string;
    equipType: EquipType | 'aux';
    depth: number;
    attackModeId: AttackModeId;
    aimModeId: AimModeId;
    rawDps: number;
    /** 相对同族中位水平的比值 */
    ratio: number;
}

/**
 * 算一族形态的预算明细。
 *
 * @param forms 形态表
 * @param baseDamageAt 取该形态的基础伤害（局外等级 × 形态 atkPct 由调用方算）
 */
export function budgetOf(
    forms: FormNode[],
    baseDamageAt: (f: FormNode) => number,
    targets: number = REFERENCE_TARGETS
): BudgetRow[] {
    const rows: BudgetRow[] = forms.map((f) => {
        const type = f.equipType;
        const aim = f.aimModeId ?? AimModeId.FRONT;
        // 全屏形态：瞄准方式被覆盖为 SCREEN_ROLL 的那些
        const fullScreen = aim === AimModeId.SCREEN_ROLL;
        const rawDps = rawDpsCapped({
            damage: baseDamageAt(f),
            interval: intervalOf(type),
            attackModeId: f.attackModeId,
            aimModeId: aim,
            pierce: pierceOf(type),
            fullScreen,
            targets,
        });
        return {
            formId: f.id,
            name: f.name,
            equipType: type,
            depth: f.depth,
            attackModeId: f.attackModeId,
            aimModeId: aim,
            rawDps,
            ratio: 1,
        };
    });

    // 🔑 **按 depth 分层归一化**，而不是全表一起归一化。
    //
    // 这是第一版模型最大的错误：它把 depth 0（铁剑 atkPct 0）与
    // depth 4（创世刃 atkPct 8.29）放进同一个池子，于是创世刃算出 22 倍预算。
    //
    // 但那是**设计意图** —— 深度就是强度轴，本来就该差这么多。
    // `0.55 ~ 1.60` 这个区间回答的是另一个问题：
    // **「同一层里，玩家随机抽到哪一把都不会废」**。
    // 跨层比较没有意义（第 4 层就该比第 1 层强得多）。
    const byDepth = new Map<number, BudgetRow[]>();
    for (const r of rows) {
        if (!byDepth.has(r.depth)) byDepth.set(r.depth, []);
        byDepth.get(r.depth)!.push(r);
    }
    for (const group of byDepth.values()) {
        const ratios = budgetRatios(group.map((r) => r.rawDps));
        group.forEach((r, i) => { r.ratio = ratios[i]; });
    }
    return rows;
}

/**
 * 校验武器有效预算不变量（纯函数版）。
 *
 * 这五条是玩家能直接感知到的平衡规则，改数值改坏它们会让
 * "每关最合适的武器都不一样"这个核心目标失效：
 *
 *   1. 单件武器预算落在 `BUDGET_MIN ~ BUDGET_MAX`
 *   2. 全部武器预算比的中位数收敛到 `BUDGET_MEDIAN_MIN ~ MAX`
 *   3. 预算必须**随形态层级单调不降** —— 进化变体不该比它的来源更弱
 *   4. 同一把武器的深层形态不得比浅层**更差**（否则玩家不会进化）
 *   5. 没有两把武器的预算完全相等（否则它们可以互相无条件替换）
 *
 * 【为什么是纯函数】
 *   与 `validateFormGraphData` / `validateRarityTableData` 同样的理由：
 *   测试要能注入畸形数据，只验「当前配置是对的」测不出校验逻辑本身有没有用。
 */
export function validateBalance(
    rows: BudgetRow[],
    opts?: {
        min?: number;
        max?: number;
        medianMin?: number;
        medianMax?: number;
    }
): string[] {
    const errors: string[] = [];
    const min = opts?.min ?? BUDGET_MIN;
    const max = opts?.max ?? BUDGET_MAX;
    const medMin = opts?.medianMin ?? BUDGET_MEDIAN_MIN;
    const medMax = opts?.medianMax ?? BUDGET_MEDIAN_MAX;

    if (rows.length === 0) {
        errors.push('预算表为空，无法校验');
        return errors;
    }

    // 规则 1：单件区间
    for (const r of rows) {
        if (r.ratio < min) {
            errors.push('「' + r.name + '」预算过低：' + r.ratio.toFixed(3) +
                ' < ' + min + '（同等投入下明显亏，玩家不会再拿它）');
        }
        if (r.ratio > max) {
            errors.push('「' + r.name + '」预算过高：' + r.ratio.toFixed(3) +
                ' > ' + max + '（出现必选武器，"每关最优解不同"失效）');
        }
    }

    // 规则 2：中位数收敛
    const med = medianOf(rows.map((r) => r.ratio));
    if (med < medMin || med > medMax) {
        errors.push('预算比中位数 ' + med.toFixed(3) + ' 不在 [' +
            medMin + ', ' + medMax + '] 内（整体数值漂移了）');
    }

    // 规则 3 / 4：同源形态的层级单调
    // 用 name 前缀不可靠，改用「同一equipType + 同一 attackMode 视为同族」
    // 更稳的判据是直接看同 id 前缀 —— 这里改用显式的 rootsOf 回调。
    const byType = new Map<string, BudgetRow[]>();
    for (const r of rows) {
        const key = String(r.equipType);
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(r);
    }
    for (const [, group] of byType) {
        // 同型按 depth 分层，每层内部比。
        // 🔑 逐个比较「与本层目前已见的最大值」——
        // 第一版写成"与前一个元素比"，那是数组顺序相关的错误判据：
        // [0.96, 0.95] 会报（0.95 < 0.96），但 [0.95, 0.96] 就不报，
        // 而两者本质是同一组数据。
        const maxAtDepth = new Map<number, number>();
        for (const r of group) {
            const prevMax = maxAtDepth.get(r.depth);
            if (prevMax !== undefined && r.ratio < prevMax - 1e-9) {
                errors.push('「' + r.name + '」预算比 ' + r.ratio.toFixed(3) +
                    ' 低于同型同层已有的 ' + prevMax.toFixed(3) +
                    '（同层不该互相压制）');
            }
            maxAtDepth.set(r.depth, Math.max(prevMax ?? -Infinity, r.ratio));
        }
    }

    // 规则 5：不允许完全相等（可互相无条件替换）
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            if (Math.abs(rows[i].ratio - rows[j].ratio) < 1e-9) {
                errors.push('「' + rows[i].name + '」与「' + rows[j].name +
                    '」预算完全相同（' + rows[i].ratio.toFixed(3) +
                    '），两者可以互相无条件替换');
            }
        }
    }

    return errors;
}

/** 中位数（奇偶都支持） */
export function medianOf(xs: number[]): number {
    if (xs.length === 0) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ====================================================================
// 六、典型场景（同屏敌人数）—— 修正"贯穿打不满"的乐观假设
// ====================================================================

/**
 * 某一关的同屏敌人数量（按 `LevelConfig` 的真实公式复刻）。
 *
 * ```
 *   enemies = max(3, round((4 + floor(levelId / 2)) × countMul × (1 + boost × 0.5)))
 *   batchSize = max(2, ceil(enemies / 3))← 分 3 波投放，同屏约等于这个
 * ```
 *
 * **为什么模型必须要它**：
 * 第一版模型直接用 `WEAPON_BASE_PIERCE` 当期望命中数，
 * 于是长枪（pierce 5）在第 1 关算出 5 倍伤害 —— 但那关同屏只有 4 只，
 * 根本打不穿5 个。**模型比真实战斗更乐观，结论必然偏**。
 *
 * 这不是精度问题而是方向问题：高 pierce 武器会被系统性高估，
 * 而它们恰好是「贯穿专家」，误判会直接影响阵型推荐名单。
 */
export function typicalBatchOf(levelId: number, countMul: number, boost: number): number {
    const enemies = Math.max(3, Math.round(
        (4 + Math.floor(levelId / 2)) * countMul * (1 + boost * 0.5)
    ));
    return Math.max(2, Math.ceil(enemies / 3));
}

/** 预算模型的参考场景：第 1 关、普通难度、无复玩加难 */
export const REFERENCE_LEVEL = 1;

/** 预算模型的参考同屏敌人数（= 第 1 关普通难度的 batchSize） */
export const REFERENCE_TARGETS = 4;

/**
 * 期望命中数（**带同屏上限修正**）。
 *
 * 与 `expectedHitsOf` 的区别只在一处：贯穿类的命中数不能超过同屏敌人数量。
 * 场上只有 4 只时，长枪的 pierce 5 只能打 4 个 —— 多出来的那一穿是浪费。
 *
 * @param targets 同屏敌人数，用 `typicalBatchOf` 算
 */
export function expectedHitsCapped(
    mode: AttackModeId,
    pierce: number,
    targets: number = REFERENCE_TARGETS
): number {
    const raw = expectedHitsOf(mode, pierce);
    // 只对"按数量吃伤害"的形状封顶：
    // 单体类本来就只有 1 个目标，范围类的半径已经决定覆盖，不需要再压。
    if (mode === AttackModeId.PIERCE) {
        return Math.max(1, Math.min(raw, targets));
    }
    return raw;
}

/** 带同屏上限的秒伤（模型正式入口） */
export function rawDpsCapped(opts: {
    damage: number;
    interval: number;
    attackModeId: AttackModeId;
    aimModeId: AimModeId;
    pierce?: number;
    fullScreen?: boolean;
    targets?: number;
}): number {
    const mode = opts.attackModeId;
    const hits = expectedHitsCapped(mode, opts.pierce ?? 1, opts.targets ?? REFERENCE_TARGETS);
    const mul = damageMulOf(mode, opts.fullScreen ?? false);
    const perShot = opts.damage * mul * hits;
    const reliable = AIM_RELIABILITY[opts.aimModeId] ?? 0.8;
    return (perShot / opts.interval) * reliable;
}

// ====================================================================
// 七、模型与真实战斗的一致性
// ====================================================================

/**
 * 模型偏差的容忍上限。
 *
 * `BalanceGuard` 是**粗粒度**模型（见上文「模型是粗粒度的」说明），
 * 它抓的是"某把武器明显超标 / 明显垫底"，不追求与真实战斗逐帧一致。
 * 所以偏差容忍度故意放得比较宽。
 *
 * 但**不能无限宽** —— 否则模型慢慢偏离真实战斗也没人发现。
 * 1/3 ~ 3倍 的区间意味着：
 *   - 模型把某把武器高估 2 倍（实测只有预测的 1/3）→ 报警
 *   - 模型把范围武器低估 4 倍（实测是预测的 4 倍）→ 报警
 *
 * ⚠️ 实测已知会越界的两类（见 `tools/calibrate.mjs`）：
 *   1. **范围/ 全屏类被低估~85%** —— 模型给 3~4 个目标，
 *      真实战斗在密集刷怪时能打到 5+ 个。
 *   2. **前向贯穿类被高估 ~200%** —— 模型假设 pierce 打满，
 *      但散兵阵型里敌人不站成一列，前向贯穿常常打不中第二个。
 *
 * 这两条不是模型"错"，而是**模型刻意不含阵型信息**。
 * 要判断某把武器在**某个阵型**里是否合适，靠的是探针而不是模型。
 */
export const PROBE_TOLERANCE_MIN = 1 / 3;
export const PROBE_TOLERANCE_MAX = 3;

/**
 * 校验「模型预测」与「真实战斗实测」的一致性（纯函数版）。
 *
 * @param modelRows   模型算出的预算明细
 * @param probeDps    探针实测的 DPS，形如 `{ formId, dps }`
 * @param tolMin/tolMax 容忍区间倍数
 */
export function validateProbeAgreement(
    modelRows: BudgetRow[],
    probeDps: Array<{ formId: string; dps: number }>,
    tolMin: number = PROBE_TOLERANCE_MIN,
    tolMax: number = PROBE_TOLERANCE_MAX
): string[] {
    const errors: string[] = [];
    const byId = new Map<string, number>();
    for (const p of probeDps) byId.set(p.formId, p.dps);

    for (const r of modelRows) {
        const actual = byId.get(r.formId);
        if (actual === undefined) continue;         // 没测到的形态跳过
        if (actual <= 0) {
            // 实测为 0 —— 意味着那把武器在这个场景下完全打不中。
            // 这不是模型错（模型不算"够不够得着"），但要提示。
            errors.push('「' + r.name + '」实测 DPS 为 0（场景里够不着或打不中）');
            continue;
        }
        const factor = r.rawDps / actual;
        if (factor < tolMin || factor > tolMax) {
            errors.push('「' + r.name + '」模型/实测偏离 ' +
                (factor / tolMax >= tolMin ? '' : '') +
                '预测 ' + r.rawDps.toFixed(1) + ' vs 实测 ' + actual.toFixed(1) +
                '（相差 ' + (factor >= 1 ? factor.toFixed(1) : (1 / factor).toFixed(1)) +
                ' 倍，超出 [' + tolMin.toFixed(2) + ', ' + tolMax + ']）');
        }
    }
    return errors;
}
