/**
 * 关卡武器适配表 —— "每个关卡最合适的武器都不一样"的落地
 *
 * 【为什么不能只写一句推荐文案】
 *
 * 如果推荐武器只是 UI 上的一句话，玩家第一次不信、第二次就无视了。
 * 要让"每关最合适的武器不同"真正成立，必须同时做到两件事：
 *
 *   1. 关卡真的**有一种形状** —— 敌人是散开的、排成一列的、还是扎堆的
 *   2. 那种形状真的**偏爱某些武器** —— 贯穿打一列很强，范围打散兵很弱
 *
 * 所以这里给每一关配一个 `FormationKind`（阵型），
 * 战斗层的刷怪位置生成会照着它摆位，武器适配则按阵型推导。
 * 两者来自同一张表，于是文案和数值不会互相打架。
 *
 * 【为什么同一阵型下的推荐武器还会变】
 *
 *   如果"散兵关"永远推荐铁剑+短弓，玩家打十关就腻了。
 *   所以同一个阵型内部按关卡轮转推荐名单 —— 同样是散兵，
 *   第 1 关推近战单体，第 5 关推远程点射，第 9 关推炮击。
 *   玩家的最优解每关都在动，这才是复玩动机的来源。
 *
 * 【代价与收益】
 *   带推荐武器：伤害 ×1.25、金币 ×1.30
 *   带克制武器：伤害 ×0.80
 * 刻意不做成"必须带"（那是硬克制，泛用户会卡关），
 * 而是做成"带了明显更爽"，让玩家自己发现规律。
 */

import { FormationKind } from './GameTypes';
import { getEquipDef } from './EquipmentConfig';
import { AFFINITY_DAMAGE_MUL, AFFINITY_GOLD_MUL, WEAK_DAMAGE_MUL } from './RunConfig';

/** 阵型循环顺序，关卡号按它取模 */
const FORMATION_CYCLE: FormationKind[] = ['scatter', 'line', 'cluster', 'swarm'];

/** 阵型的中文名与一句话说明 */
export const FORMATION_TEXT: Record<FormationKind, string> = {
    scatter: '零散突进',
    line: '成列推进',
    cluster: '密集扎堆',
    swarm: '人海散兵',
};

export const FORMATION_DESC: Record<FormationKind, string> = {
    scatter: '敌人从各个方向零散出现，彼此离得远',
    line: '敌人倾向于排成一列推进，前排会挡住后排',
    cluster: '敌人挤成一团冲过来，越打越密',
    swarm: '敌人数量多但各自为战，满场乱窜',
};

/**
 * 各阵型的候选推荐名单（按"最合适 → 次合适"排序）。
 *
 * 名单本身来自武器在射程/攻速/打击形状上的特性：
 *   line    需要贯穿 → 长枪 / 光矛 / 冰晶球(穿透形态)
 *   cluster 需要范围或连锁 → 雷杖 / 巨镰 / 铁锤 / 冰晶球
 *   scatter 需要单体高伤 + 打得准 → 铁剑 / 短弓 / 重炮
 *   swarm   需要高频或全屏 → 飞刃 / 手里剑 / 回旋轮 / 铁锤(震荡)
 */
/**
 * 每个阵型的推荐武器池。
 *
 * 【第八轮为什么高阶专属武器不进这个池】
 *   它们是**抽卡专供**的：不走自动发放、不占关卡推荐的坑位。
 *   若硬塞进池子，会同时破坏两件事：
 *     1. 推荐/克制的战力平衡（balance_guard 第 9 关那条会红：
 *        高阶专属的自带属性让"推荐 10.6 vs 克制 11.1"的天平倒向推荐）
 *     2. 轮转节奏 —— 池子从 3~4 件涨到 7 件，同一把武器的推荐间隔翻倍
 *
 *   所以高阶专属**不参与关卡推荐**，它们的引导走另一条路：
 *   抽卡面板上写明"这把适合什么阵型"（见 GachaPanel 的展示）。
 *   balance_guard 的"每把武器至少被推荐一次"因此只对常规 12 把生效。
 */
const AFFINITY_POOL: Record<FormationKind, string[]> = {
    line: ['spear', 'lance', 'orb'],
    cluster: ['staff', 'scythe', 'hammer', 'orb'],
    scatter: ['blade', 'bow', 'cannon'],
    swarm: ['dagger', 'shuriken', 'wheel', 'hammer'],
};

/**
 * 各阵型的克制名单（按"最吃亏 → 次吃亏"排序）。
 *
 * 逻辑和推荐名单正好相反：
 *   散兵关里范围武器只能一次打到一个，等于白给
 *   成列关里"打单体"的武器享受不到队列红利，打不出应有的效率
 *   扎堆关里单体武器溢出严重
 *   人海关里慢攻速武器根本跟不上刷新速度
 *
 * 硬约束（有测试守着）：
 *   1. **同一阵型内，克制名单与推荐名单不能有交集**。
 *      一件武器不可能既是这关的最优解又是最差解 —— 那会让适配倍率互相抵消，
 *      玩家看到的推荐文案与实测手感直接矛盾，比不做适配还糟。
 *   2. **克制名单在机制模型下的输出必须真的低于推荐名单**（balance_guard.js）。
 *      曾经把飞刃/手里剑放进"成列推进"的克制名单，理由是"弹幕大半打空"；
 *      但实测模型显示它们在这种阵型下输出并不低 —— 弹幕撒在一条线上反而命中率更高。
 *      拍脑袋写的名单被测试打回来了，换成了真正"吃不到队列红利"的锁单体重炮与短弓。
 */
const WEAK_POOL: Record<FormationKind, string[]> = {
    scatter: ['staff', 'scythe', 'orb'],
    // 成列推进：想吃队列红利就得"一下打穿一串"，锁单体的重炮与短弓只能一个个点
    line: ['scythe', 'cannon'],
    // 密集扎堆：只能打一个的武器在人群里严重溢出。
    // 光矛虽然是穿透，但只穿 3 个、且射速被 LOCK_ON 的便利性拖慢，
    // 放进克制名单会把整组的均值抬起来，反而让推荐名单失去优势 —— 所以不列它。
    cluster: ['cannon', 'bow'],
    // 回旋轮是横扫全场的，人海关里它恰恰很强，所以不能列进克制名单；
    // 换成定位单线的光矛与慢速重炮 —— 它们跟不上满场散兵。
    swarm: ['cannon', 'lance'],
};

/** 该关的阵型 */
export function formationForLevel(levelId: number): FormationKind {
    const i = ((Math.floor(levelId) - 1) % FORMATION_CYCLE.length + FORMATION_CYCLE.length) %
        FORMATION_CYCLE.length;
    return FORMATION_CYCLE[i];
}

/**
 * 该关的推荐武器（2 件）。
 *
 * 同一阵型内部按"关卡序号 / 阵型数"作为轮转偏移，
 * 于是散兵关的推荐名单会在 铁剑+短弓 → 短弓+重炮 → 重炮+铁剑 之间循环。
 */
export function affinityForLevel(levelId: number): string[] {
    const f = formationForLevel(levelId);
    const pool = AFFINITY_POOL[f];
    const rot = Math.floor((Math.max(1, levelId) - 1) / FORMATION_CYCLE.length);
    const out: string[] = [];
    for (let i = 0; i < 2; i++) {
        out.push(pool[(rot + i) % pool.length]);
    }
    return out;
}

/** 该关的克制武器（2 件） */
export function weakForLevel(levelId: number): string[] {
    const f = formationForLevel(levelId);
    const pool = WEAK_POOL[f];
    const rot = Math.floor((Math.max(1, levelId) - 1) / FORMATION_CYCLE.length);
    const out: string[] = [];
    for (let i = 0; i < 2; i++) {
        out.push(pool[(rot + i) % pool.length]);
    }
    return out;
}

/**
 * 把武器的形态追溯回它的局外装备 id，再判断是否算作"携带了某把武器"。
 *
 * 这一步不能省：玩家后期带的都是"剑雨风暴"这种合成形态，
 * 如果只比对根形态 id，推荐武器的加成会在进化之后莫名消失。
 * 合成形态的 sources 里带着材料武器的 id，所以按 sources 判定。
 */
export function weaponRootIdsOf(equipIds: string[], formSources: string[][]): string[] {
    const out: string[] = equipIds.slice();
    for (const s of formSources) {
        for (const id of s) {
            if (out.indexOf(id) < 0) out.push(id);
        }
    }
    return out;
}

/** 判定这组武器是否吃到了该关的推荐加成 */
export function hasAffinity(levelId: number, roots: string[]): boolean {
    const list = affinityForLevel(levelId);
    for (const id of roots) {
        if (list.indexOf(id) >= 0) return true;
    }
    return false;
}

/**
 * 该关 + 这组武器的伤害倍率。
 * 推荐与克制可以同时命中（带了一把推荐又带了一把克制），此时互相抵消为 1.0，
 * 这是刻意保留的"搭配权衡"：想全吃加成，就得放弃另一把。
 */
export function affinityDamageMul(levelId: number, roots: string[]): number {
    const aff = affinityForLevel(levelId);
    const weak = weakForLevel(levelId);
    let mul = 1;
    let hitAff = false;
    let hitWeak = false;
    for (const id of roots) {
        if (aff.indexOf(id) >= 0) hitAff = true;
        if (weak.indexOf(id) >= 0) hitWeak = true;
    }
    if (hitAff) mul *= AFFINITY_DAMAGE_MUL;
    if (hitWeak) mul *= WEAK_DAMAGE_MUL;
    return mul;
}

/** 推荐武器的金币加成 */
export function affinityGoldMul(levelId: number, roots: string[]): number {
    const aff = affinityForLevel(levelId);
    for (const id of roots) {
        if (aff.indexOf(id) >= 0) return AFFINITY_GOLD_MUL;
    }
    return 1;
}

function namesOf(ids: string[]): string {
    const names: string[] = [];
    for (const id of ids) {
        const def = getEquipDef(id);
        if (def) names.push(def.name);
    }
    return names.join(' · ');
}

/** 该关的阵型 + 适配说明，关卡面板与备战页展示用 */
export function affinityTip(levelId: number): string {
    const f = formationForLevel(levelId);
    const aff = affinityForLevel(levelId);
    const weak = weakForLevel(levelId);
    return FORMATION_TEXT[f] + '：' + FORMATION_DESC[f] +
        '。推荐 ' + namesOf(aff) + '，避免 ' + namesOf(weak);
}

/** 推荐武器的名字串，UI 单独展示用 */
export function affinityNames(levelId: number): string {
    return namesOf(affinityForLevel(levelId));
}

/** 克制武器的名字串 */
export function weakNames(levelId: number): string {
    return namesOf(weakForLevel(levelId));
}
