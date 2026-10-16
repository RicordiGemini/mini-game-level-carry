/**
 * 战斗层数据类型与常量
 *
 * 【为什么单独一层、且不依赖 cocos】
 *
 * 这一层的全部代码只做数学与状态推进，不 import 任何 `cc`。
 * 好处有两个：
 *   1. 可以在 Node 里直接跑完整战斗仿真，写断言验证"锁定真的锁人""前向真的打不到背后"
 *   2. 将来换渲染层（或加帧同步）时，这层一行都不用改
 *
 * 表现层（ui/BattleLayer.ts）只做两件事：把输入喂进来、把状态画出去。
 */

import { AimModeId, AttackModeId, EnemyKind, EquipType, FormationKind } from '../data/GameTypes';

// ====================================================================
// 向量工具（避免为了一个 add 去依赖引擎的 math 模块）
// ====================================================================

export interface Vec2 {
    x: number;
    y: number;
}

/** 零向量常量，别直接改它 */
export const ZERO: Vec2 = { x: 0, y: 0 };

/** 玩家静止时的默认朝向（朝右） */
export const DEFAULT_FACING: Vec2 = { x: 1, y: 0 };

export function v2(x: number, y: number): Vec2 {
    return { x, y };
}

export function vcopy(a: Vec2): Vec2 {
    return { x: a.x, y: a.y };
}

export function vadd(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x + b.x, y: a.y + b.y };
}

export function vsub(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x - b.x, y: a.y - b.y };
}

export function vscale(a: Vec2, s: number): Vec2 {
    return { x: a.x * s, y: a.y * s };
}

export function vlen(a: Vec2): number {
    return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function vdist(a: Vec2, b: Vec2): number {
    return vlen(vsub(a, b));
}

/** 归一化，零向量返回零向量（不返回 NaN —— 这是最容易炸的一个点） */
export function vnorm(a: Vec2): Vec2 {
    const l = vlen(a);
    if (l < 1e-6) return { x: 0, y: 0 };
    return { x: a.x / l, y: a.y / l };
}

/** 绕原点旋转 radians 弧度 */
export function vrot(a: Vec2, radians: number): Vec2 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function vclampLen(a: Vec2, max: number): Vec2 {
    const l = vlen(a);
    if (l <= max || l < 1e-6) return vcopy(a);
    return vscale(a, max / l);
}

// ====================================================================
// 战场常量（按 720×1280 竖屏设计分辨率标定）
// ====================================================================

export const ARENA_W = 720;
export const ARENA_H = 1280;

/** 玩家移动速度（像素/秒），摇杆拉满时的速度 */
export const PLAYER_SPEED = 330;
/** 玩家碰撞半径 */
export const PLAYER_RADIUS = 22;
/** 玩家出生点：底部 1/4 处居中 */
export const PLAYER_SPAWN_X = ARENA_W / 2;
export const PLAYER_SPAWN_Y = ARENA_H * 0.24;

/** 敌人出生点距离玩家至少这么远，避免"贴脸刷怪" */
export const SPAWN_SAFE_DIST = 260;

/**
 * 全屏射程 —— 场地对角线，也就是屏幕上可能出现的最大距离。
 *
 * 【为什么射程统一按全屏来】
 * 原来每件武器各有射程（短弓 270、法球 250…），带来两个坏手感：
 *   1. 屏幕上有敌人，武器却"够不着"，玩家只能干等敌人走进射程才开火；
 *   2. 更糟的是弹道寿命也按射程算，子弹会飞到一半凭空消失 ——
 *      明明锁定了目标却打不到，弹药全浪费在路上。
 *
 * 统一成全屏射程之后，屏幕上任何位置的敌人都打得到；
 * 武器的差异保留在**判定体形状与打击尺度**上（近战要贴身、法球穿透、滚轮横扫），
 * 而不是靠"谁够得着"来区分 —— 那种差异玩家只会觉得是 bug。
 *
 * 想给某关恢复"够不着就不开火"的克制手感，给 BattleSetup.engageRange 传一个小值即可。
 */
export function fullScreenRange(arenaW: number, arenaH: number): number {
    return Math.sqrt(arenaW * arenaW + arenaH * arenaH);
}

/**
 * 制导弹道的收尾余量：飞到目标位置再往前这么多像素就消失。
 * 目标已经被打完，子弹没必要继续飞到屏幕外去。
 */
export const AIMED_SHOT_TAIL = 90;

// ====================================================================
// 远程怪默认参数
// ====================================================================

/** 远程怪保持的间距：小于它会后撤，大于它会靠近，区间内则停下射击 */
export const DEFAULT_KITE_RANGE = 300;
/** 弹丸飞行速度 */
export const DEFAULT_SHOT_SPEED = 260;
/** 射击间隔（秒） */
export const DEFAULT_SHOT_INTERVAL = 2.2;
/** 远程怪血量倍率：比近战脆，鼓励优先切入点掉 */
export const DEFAULT_RANGED_HP_MUL = 0.72;
/** 远程怪移速倍率：更灵活，会主动拉开距离 */
export const DEFAULT_RANGED_SPEED_MUL = 1.15;
/**
 * 间距死区：只有偏离目标间距超过这个量才移动。
 * 没有死区的话，敌人会在"前进-后撤"之间高频抖动，看起来像抽筋。
 */
export const KITE_DEADZONE = 45;

// ====================================================================
// 噩梦专有敌人种类默认参数
// ====================================================================
//
// 这些只对噩梦档生效；普通 / 困难传给 spawn 的 elite/swift/chargerRatio 都是 0，
// 永远不会走到这里。

/** 精英怪：3 倍血、70% 移速、护盾 = 45% × maxHp */
export const DEFAULT_ELITE_HP_MUL = 3.0;
export const DEFAULT_ELITE_SPEED_MUL = 0.7;
export const DEFAULT_ELITE_SHIELD_FRAC = 0.45;

/** 高速突进怪：70% 血、170% 移速（贴脸比普通近战快 70%） */
export const DEFAULT_SWIFT_HP_MUL = 0.7;
export const DEFAULT_SWIFT_SPEED_MUL = 1.7;

/** 冲锋怪：蓄力 0.8s + 冲刺 0.5s × 3.5 倍速度 + 命中伤害 2.0 × atk */
export const DEFAULT_CHARGER_WINDUP = 0.8;
export const DEFAULT_CHARGER_WINDUP_SPEED_MUL = 0.3;
export const DEFAULT_CHARGER_DASH_TIME = 0.5;
export const DEFAULT_CHARGER_DASH_SPEED_MUL = 3.5;
export const DEFAULT_CHARGER_HIT_DMG_MUL = 2.0;

// ====================================================================
// 实体
// ====================================================================

/** 战场上的圆形实体 */
export interface Actor {
    id: number;
    pos: Vec2;
    radius: number;
    hp: number;
    maxHp: number;
    alive: boolean;
}

/** 敌人 */
export interface EnemyState extends Actor {
    /** 近战贴脸 / 远程风筝，AI 与外观都由它区分 */
    kind: EnemyKind;
    /**
     * 敌人的属性。
     * 由关卡属性决定，玩家镶嵌对应克制属性可以获得 ×1.35 伤害。
     * 没传时按 'light' 处理（而不是 undefined），避免战斗层到处判空。
     */
    element?: string;
    /** 接触玩家时的单次伤害（近战） */
    atk: number;
    speed: number;
    atkInterval: number;
    /** 攻击冷却剩余 */
    atkCd: number;
    /** 被击中的闪白剩余时间，纯表现用 */
    hitFlash: number;
    /** 击杀后交给关卡流程的经验值 */
    expValue: number;

    // ---- 仅远程怪有效 ----
    /** 试图保持的间距：小于它会后撤，大于它会靠近 */
    kiteRange: number;
    /** 弹丸伤害 */
    shotAtk: number;
    /** 弹丸飞行速度 */
    shotSpeed: number;
    /** 射击间隔 */
    shotInterval: number;
    /** 射击冷却剩余 */
    shotCd: number;

    // ---- 仅 elite 有效：护盾（先打护盾再扣血） ----
    /** 当前护盾值。> 0 时受击只扣护盾不扣血 */
    shield: number;
    /** 护盾最大初始值（用于重置 / 显示） */
    maxShield: number;

    // ---- 仅 charger 有效：冲锋状态 ----
    /** 蓄力剩余时间（秒）。> 0 视为正在蓄力 */
    chargeTimer: number;
    /** 蓄力时长（满蓄力时 chargeTimer 等于此值） */
    chargeMax: number;
    /** 蓄力时锁定的方向（蓄力完成后朝这个方向冲刺） */
    chargeDir: Vec2;
    /** 冲锋中（冲刺阶段） */
    isCharging: boolean;
    /** 冲刺剩余时间（秒） */
    chargeDashLeft: number;
    /** 冲刺速度（比常规移速快） */
    chargeSpeed: number;
    /** 冲锋命中玩家时的单次伤害（高于常规 atk） */
    chargeDmg: number;
}

/**
 * 敌人发射的弹丸。
 *
 * 【为什么不复用 Projectile】
 * Projectile 承载的是"我方攻击"的语义：穿透层数、连锁跳数、附着距离、
 * 已命中列表…… 这些对敌弹一个都不适用。硬塞进同一个结构会让
 * `resolveHits` 里到处是 `if (friendly)` 分支，是典型的"省一个类型、
 * 换来十处判断"。敌弹只有一个方向、一次判定，单独一个极简结构更清楚。
 */
export interface EnemyShot {
    pos: Vec2;
    dir: Vec2;
    speed: number;
    radius: number;
    damage: number;
    /**
     * 射击者的属性。
     * 敌弹必须带上它 —— 否则属性抗性只对近战贴脸生效，
     * 而远程怪恰恰是"属性压制"的主要来源，这条规则就废了一半。
     */
    element?: string;
    /** 剩余存活秒数 */
    life: number;
    alive: boolean;
}

/** 判定体种类，表现层据此选颜色/形状 */
export type ProjectileKind =
    | 'melee'
    | 'sweep'
    | 'bullet'
    | 'pierce'
    | 'shockwave'
    | 'rain'
    | 'chain'
    | 'meteor'
    | 'wheel';

/**
 * 攻击判定体 —— 战斗层里所有伤害都靠它结算。
 *
 * 用"判定体"而不是"子弹"来命名，是因为近战挥砍、震荡波、陨石
 * 这些并不是飞行物，但它们共享同一套生命周期：出现 → 存在一段时间 → 判定命中 → 消失。
 * 统一之后，战斗循环里只有一条 update 分支。
 */
export interface Projectile {
    id: number;
    kind: ProjectileKind;
    /** 世界坐标（左下角为原点） */
    pos: Vec2;
    /** 单位方向向量；speed 为 0 时无意义 */
    dir: Vec2;
    speed: number;
    /** 剩余存活秒数 */
    life: number;
    damage: number;
    /** 判定半径 */
    radius: number;
    /** 半径每秒增长量（震荡波 / 爆炸） */
    growRate: number;
    /** 剩余可穿透敌人数。-1 = 无限穿透 */
    pierce: number;
    /** 连锁剩余跳数，>0 时命中后会跳到下一个敌人 */
    chainLeft: number;
    /** 落地延迟（陨石 / 剑雨先等待再判定） */
    delay: number;
    /**
     * 跟随玩家的距离（沿玩家朝向）。
     * >= 0 时每帧把 pos 刷新为 player.pos + facing × attachDist，
     * 用来实现"贴着玩家身前的挥砍/剑气/震荡波"，判定会随走位一起移动。
     */
    attachDist: number;
    /** 已命中过的敌人 id，避免同一发判定体重复打同一个目标 */
    hitIds: number[];
    alive: boolean;

    // ---- 伤害性质（由开出它的武器在生成时盖上来）----
    /**
     * 【为什么把暴击/吸血放在判定体上而不是去查武器】
     * 判定体在飞行途中武器参数可能已经变了（进化了、被合成了），
     * 那时候再回查会得到"这一发按新参数结算"的错误结果。
     * 生成瞬间盖一份副本，这一发的性质就固定了。
     */
    /** 暴击率 0~1 */
    critRate?: number;
    /** 暴击伤害倍率 */
    critMul?: number;
    /** 吸血比例 */
    lifesteal?: number;
    /**
     * 开出这一发的武器镶嵌了哪些属性。
     * 与暴击/吸血同样的理由盖在判定体上：命中时才知道敌人是什么属性，
     * 克制倍率必须在这一刻才算得出来。
     */
    elements?: string[];
    /** 对高血量敌人的加伤（龙属性），命中时才知道敌人剩多少血 */
    highHpDmg?: number;
}

// ====================================================================
// 武器运行时
// ====================================================================

/**
 * 一件武器的战斗参数 —— 由 EquipmentManager.buildWeapons() 产出。
 * 战斗层拿到的就是这个纯数据，完全不认识"装备等级""形态图""合成"这些概念。
 */
export interface WeaponSpec {
    /** 局外武器 id（决定基础伤害来源；合成形态取材料第一件） */
    equipId: string;
    /** 当前形态 id，UI 用它去查图鉴与显示名 */
    formId: string;
    /** 当前形态显示名，如"裂空剑" */
    name: string;
    type: EquipType;
    /**
     * 形态层级（0 = 初始形态，4 = 复玩限定的更上级形态）。
     * 原来叫 stage，改成 depth 是因为现在是图而不是链 ——
     * 同 depth 可能有多条分支，"第几层"比"第几阶段"更准确。
     */
    depth: number;
    /** 取目标 / 取方向的方式，由武器类型（或形态覆盖）决定 */
    aimMode: AimModeId;
    /** 打出去的形状 */
    attackModeId: AttackModeId;
    /** 单次伤害（已含天赋、辅助装备与关卡适配的全部乘算） */
    damage: number;
    /**
     * 武器的**打击尺度**（像素）：决定近战够不够得着、剑气有多宽、
     * 震荡波能扩多大、陨石爆炸范围多大 —— 也就是"这件武器打出去长什么样"。
     *
     * 注意它**不是**索敌射程：索敌与弹道飞行距离统一按全屏算
     * （见 fullScreenRange），否则会出现"锁定了却打不到"的假 bug。
     */
    range: number;
    /** 攻击间隔（秒），已含攻速加成 */
    interval: number;
    /** 瞄准方式文案 */
    aimText: string;
    /**
     * 贯穿上限：一次攻击最多打穿几个敌人（1 = 只命中一个）。
     * 只有 PIERCE 类攻击会读它，其余武器忽略。
     */
    pierce?: number;

    // ---- 天赋 / 辅助装备带来的战斗属性（不填 = 该效果不生效）----
    /** 暴击率 0~1 */
    critRate?: number;
    /** 暴击伤害倍率，默认 2.0 */
    critMul?: number;
    /** 吸血比例：造成伤害的该比例回复玩家生命 */
    lifesteal?: number;
    /** 每次攻击额外发射的弹道数 */
    extraShots?: number;
    /**
     * 这把武器镶嵌的属性（来自 ForgeManager）。
     * 克制敌人的对应属性时伤害 ×1.6，被克制 ×0.9，再按破防向 1.0 收敛。
     */
    elements?: string[];
    /** 连锁闪电额外跳数（虫属性） */
    chainBonus?: number;
    /** 无视目标属性抗性的比例（石 / 时间属性） */
    pierceResist?: number;
    /** 对血量高于上限 30% 的敌人加伤（龙属性） */
    highHpDmg?: number;

    // ---- 第八轮：品阶与自带复合属性 ----
    /** 这件武器的品阶（0~6，青铜→传说）。UI 显示品阶徽标用 */
    rarity?: number;
    /**
     * 这件武器**自带**的属性元素列表（钻石及以上专属装备才有）。
     * 与 `elements`（玩家镶嵌的）分开：自带的不随镶嵌变化，
     * 镶嵌的可以卸下。两者都参与克制结算。
     */
    innateElements?: string[];
}

/** 战场内的武器状态：在 spec 之上加了冷却与锁定记忆 */
export interface WeaponRuntime extends WeaponSpec {
    /** 冷却剩余秒数 */
    cd: number;
    /** 锁定模式下当前锁定的敌人 id，0 = 未锁定 */
    lockedId: number;
}

// ====================================================================
// 瞄准解析
// ====================================================================

/** 一次瞄准解析的输入 */
export interface AimContext {
    mode: AimModeId;
    playerPos: Vec2;
    /** 玩家当前朝向（由最后一次移动方向决定，静止时保留） */
    facing: Vec2;
    /** 当前拖动方向（未拖动时为零向量） */
    moveDir: Vec2;
    /** 拖动强度 0~1 */
    moveStrength: number;
    /** 存活敌人列表 */
    enemies: EnemyState[];
    /** 锁定模式下的既有锁定目标 id */
    lockedId: number;
    /**
     * 开火射程（索敌上限）。
     * 默认由 BattleWorld 传入**全屏射程** —— 屏幕上任何敌人都在射程内。
     * 传一个小值就变成"够不着就不开火"的克制手感。
     */
    range: number;
}

/** 一次瞄准解析的输出 */
export interface AimResult {
    mode: AimModeId;
    /** 攻击方向（单位向量） */
    dir: Vec2;
    /** 本次索敌到的目标 id，0 = 没有目标 */
    targetId: number;
    /** 需要写回武器的锁定目标 id（仅 LOCK_ON 会更新） */
    lockedId: number;
    /** 是否横扫全屏（不受方向与射程限制） */
    fullScreen: boolean;
    /** 是否因为没有目标而放弃本次攻击 */
    skip: boolean;
}

// ====================================================================
// 战斗场次配置
// ====================================================================

/** 敌人的生成参数 */
export interface EnemySpawnSpec {
    count: number;
    hp: number;
    atk: number;
    speed: number;
    radius: number;
    atkInterval: number;
    expValue: number;
    /** 每批生成数量 */
    batchSize: number;
    /** 批次间隔秒数 */
    batchInterval: number;

    // ---- 刷怪阵型（可选，不传 = 老的随机方位，旧测试不受影响）----
    /**
     * 敌人怎么摆位。
     * 它是"每关最合适的武器不同"的物理基础：只改推荐文案而不改阵型，
     * 散兵关带范围武器照样能过，推荐就是空话。
     */
    formation?: FormationKind;

    // ---- 属性（可选，不传 = 全是光属性，旧测试与旧关卡不受影响）----
    /**
     * 这一关的属性池。
     * 每只敌人从池子里按轮转取一个属性，于是同一关里会出现多种属性的敌人 ——
     * 这就是"越往后属性复合的越多"的物理体现。
     */
    elements?: string[];
    /**
     * 敌人的属性在池子里的轮转偏移。
     * 不传则用战斗自身的 rng 随机分配；传了就完全可复现（测试用）。
     */
    elementCursor?: number;

    // ---- 远程怪（可选，不传 = 全近战，旧测试与旧关卡不受影响）----
    /** 远程怪占全部敌人的比例 0~1，按数量四舍五入后均匀打散到各批次 */
    rangedRatio?: number;
    /** 远程怪血量倍率，默认 0.72 */
    rangedHpMul?: number;
    /** 远程怪移速倍率，默认 1.15 */
    rangedSpeedMul?: number;
    /** 远程怪保持间距，默认 300 */
    kiteRange?: number;
    /** 弹丸速度，默认 260 */
    shotSpeed?: number;
    /** 弹丸伤害，默认取 atk 的 0.72 */
    shotAtk?: number;
    /** 射击间隔，默认 2.2 */
    shotInterval?: number;

    // ---- 噩梦专有的新种类（普通 / 困难不传 / 传 0 → 不会刷出）----
    /**
     * 精英怪比例：高血低速 + 护盾，是持续压力源。
     * 噩梦档默认 0.08，关卡进度会再加。
     */
    eliteRatio?: number;
    /** 精英怪血量倍率（默认 3.0：3 倍血） */
    eliteHpMul?: number;
    /** 精英怪护盾值（按 maxHp 计算，默认 0.45 倍血） */
    eliteShieldFrac?: number;
    /** 精英怪移速倍率（默认 0.7，比常规慢） */
    eliteSpeedMul?: number;

    /**
     * 高速突进怪比例：贴脸比 melee 还快，是短期爆发。
     * 噩梦档默认 0.12。
     */
    swiftRatio?: number;
    /** 突进怪移速倍率（默认 1.7） */
    swiftSpeedMul?: number;
    /** 突进怪血量倍率（默认 0.7：偏脆） */
    swiftHpMul?: number;

    /**
     * 冲锋怪比例：蓄力后朝玩家方向冲刺。
     * 噩梦档默认 0.05（少而精，太多会让玩家全程躲蓄力圈）。
     */
    chargerRatio?: number;
    /** 蓄力时长（默认 0.8 秒，给玩家 0.4 秒窗口躲） */
    chargerWindup?: number;
    /** 蓄力期间移速倍率（默认 0.3：蓄力时几乎不动） */
    chargerWindupSpeedMul?: number;
    /** 冲刺持续时间（默认 0.5 秒） */
    chargerDashTime?: number;
    /** 冲刺速度倍率（默认 3.5） */
    chargerDashSpeedMul?: number;
    /** 冲锋命中伤害倍率（默认 2.0） */
    chargerHitDmgMul?: number;
}

/** 开一场战斗所需的全部输入 */
export interface BattleSetup {
    /** 战场尺寸，默认 ARENA_W × ARENA_H */
    arenaW?: number;
    arenaH?: number;
    /** 玩家血量 */
    playerHp: number;
    /** 玩家移速，默认 PLAYER_SPEED */
    playerSpeed?: number;
    /**
     * 开火 / 索敌射程。
     * 不传 = 全屏对角线（场上任何敌人都在射程内，这是默认的"射程按全屏来"）。
     */
    engageRange?: number;
    /** 出战的每件武器 */
    weapons: WeaponSpec[];
    /** 敌人生成参数 */
    enemy: EnemySpawnSpec;
    /** 随机种子，固定后战斗过程可复现（写测试用） */
    seed?: number;

    // ---- 天赋 / 辅助装备带来的玩家侧属性 ----
    /** 开局护盾（圣盾符 / 守护印记） */
    shield?: number;
    /** 荆棘反伤：被近战击中时反弹的固定伤害 */
    thorns?: number;
    /**
     * 玩家的属性抗性向量 { fire: 0.3, ... }。
     * 敌人带什么属性打过来，就减免对应那条轴（上限 0.75，不给免疫）。
     */
    resist?: Record<string, number>;
    /**
     * 无视抗性的比例（石 / 时间属性）。
     * 与抗性相乘：抗性 30% + 无视 15% → 实际只吃 70% × 85% = 59.5%
     */
    pierceResist?: number;
    /**
     * 破防比例 0~0.9：把属性克制倍率向 1.0 收敛。
     * 0 = 正常吃克制，0.9 = 几乎完全无视。
     */
    counterBreak?: number;
}

/** 战斗结束的原因 */
export type BattleResult = 'ongoing' | 'won' | 'lost';

/** 战斗事件回调 —— 表现层与关卡流程通过它挂钩 */
export interface BattleCallbacks {
    /** 击杀一只敌人（关卡流程在这里加分/掉资源/涨经验） */
    onEnemyKilled?: (e: EnemyState) => void;
    /** 玩家血量变化 */
    onPlayerHpChanged?: (hp: number, maxHp: number) => void;
    /** 玩家阵亡 */
    onPlayerDead?: () => void;
    /** 全部敌人清空 */
    onCleared?: () => void;
    /** 某件武器开火（表现层播特效） */
    onWeaponFired?: (w: WeaponRuntime, p: Projectile) => void;
    /** 玩家受到伤害（表现层震屏/飘字） */
    onPlayerHurt?: (dmg: number, remainHp: number) => void;
    /** 远程怪开火（表现层可播起手动作/音效） */
    onEnemyShoot?: (e: EnemyState, shot: EnemyShot) => void;
}

// ====================================================================
// 可复现随机数（mulberry32）
// ====================================================================

/**
 * 固定种子的伪随机数发生器。
 * 战斗里只用在"敌人从哪个方向刷"这类无关公平性的地方，
 * 但它让整场战斗可以完整复现 —— 写自动化测试时这点非常关键。
 */
export function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return function (): number {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
