/**
 * 攻击生成器 —— 把「瞄准结果 + 武器参数」翻译成具体的伤害判定体
 *
 * 分工：
 *   AimResolver  决定「朝哪打 / 打谁」
 *   AttackFactory 决定「打出去长什么样」（单体 / 三连 / 范围 / 穿透 / 剑雨 / 连锁 / 陨石 / 全屏滚轮）
 *
 * 两者的组合就是一件武器完整的战斗表现，例如：
 *   bow  + SINGLE_RANGED → 锁定最近目标射出一支追踪箭
 *   bow  + TRIPLE_SHOT   → 锁定目标打出三发扇形
 *   hammer + SHOCKWAVE   → 朝拖动方向在身前炸开一圈震荡波
 *   blade + RAIN (阶段3) → 全屏剑雨（瞄准已被覆盖为 SCREEN_ROLL）
 */

import { AttackModeId } from '../data/GameTypes';
import {
    AIMED_SHOT_TAIL,
    EnemyState,
    Projectile,
    ProjectileKind,
    Vec2,
    WeaponSpec,
    fullScreenRange,
    vadd,
    vnorm,
    vrot,
    vscale,
} from './BattleTypes';

/** 内部用的简化战场信息 */
export interface AttackScene {
    arenaW: number;
    arenaH: number;
    playerPos: Vec2;
    /** 开火射程，默认取全屏对角线（"射程按全屏来"） */
    engageRange?: number;
    /** 玩家到本次攻击目标的距离，0 = 没有明确目标 */
    targetDist?: number;
}

/** 需要的判定体类型别名，减少下面重复的类型标注 */
type Scene = AttackScene;

/**
 * 本次攻击的弹道飞行距离。
 *
 * 三条规则合起来才是"射程按全屏来，但不浪费弹药"：
 *   1. **够得着**：至少飞到目标位置再往前一点（`AIMED_SHOT_TAIL`），
 *      所以"锁定了却打不到"不可能再发生；
 *   2. **保留武器射程**：不低于武器自身的 range，
 *      这样进化里的「攻击距离%」依然有意义（弹道更长 = 顺路能扫到更多敌人）；
 *   3. **上限全屏**：最多就是场地对角线，不会飞出屏幕外做无用飞行。
 *
 * 没有明确目标时（前向 / 移动向的远程武器）直接飞满全屏 ——
 * 玩家是在对着空气打，屏幕内的任何敌人都该有机会被扫到。
 *
 * @param aimed 是否制导弹道。穿透类传 false：它的设计意图就是一路贯穿全场
 */
function travelDist(w: WeaponSpec, scene: Scene, aimed: boolean): number {
    const full = scene.engageRange && scene.engageRange > 0
        ? scene.engageRange
        : fullScreenRange(scene.arenaW, scene.arenaH);
    if (!aimed) return full;

    const own = w.range > 0 ? w.range : 0;
    const d = scene.targetDist ?? 0;
    if (d <= 0) return full;
    return Math.min(full, Math.max(own, d + AIMED_SHOT_TAIL));
}

let _pid = 1;
/** 重置判定体自增 id（测试用，保证可复现） */
export function resetProjectileIds(): void {
    _pid = 1;
}

function make(kind: ProjectileKind, partial: Partial<Projectile>): Projectile {
    return {
        id: _pid++,
        kind,
        pos: { x: 0, y: 0 },
        dir: { x: 1, y: 0 },
        speed: 0,
        life: 0.2,
        damage: 10,
        radius: 16,
        growRate: 0,
        pierce: 0,
        chainLeft: 0,
        delay: 0,
        attachDist: -1,
        hitIds: [],
        alive: true,
        ...partial,
    };
}

/**
 * 主入口。
 *
 * @param dir       攻击方向（单位向量，由 AimResolver 给出）
 * @param fullScreen 是否全屏横扫
 * @param w         武器参数
 * @param scene     战场信息
 * @param enemies   存活敌人（剑雨 / 连锁 / 陨石需要）
 * @param rng       随机数（散布角、落点抖动）
 * @returns 本帧要生成的判定体数组，空数组 = 本次不开火
 */
export function buildAttack(
    dir: Vec2,
    fullScreen: boolean,
    w: WeaponSpec,
    scene: Scene,
    enemies: EnemyState[],
    rng: () => number
): Projectile[] {
    const alive = enemies.filter((e) => e.alive);
    const d = vnorm(dir.x === 0 && dir.y === 0 ? { x: 1, y: 0 } : dir);
    const p = scene.playerPos;

    // 全屏类攻击优先，不受 attackModeId 束缚
    if (fullScreen) return buildFullScreen(w, scene, alive, rng);

    switch (w.attackModeId) {
        case AttackModeId.SINGLE_MELEE:
            return buildMelee(d, w, p);

        case AttackModeId.SINGLE_RANGED:
            return buildBullet(d, w, p, 1, scene);

        case AttackModeId.TRIPLE_SHOT:
            return buildBullet(d, w, p, 3, scene);

        case AttackModeId.SWEEP:
            return buildSweep(d, w, p);

        case AttackModeId.PIERCE:
            return buildPierce(d, w, p, scene);

        case AttackModeId.SHOCKWAVE:
            return buildShockwave(w, p);

        case AttackModeId.RAIN:
            return alive.length ? buildRain(w, alive, rng) : [];

        case AttackModeId.CHAIN:
            return alive.length ? buildChain(d, w, p, scene) : [];

        case AttackModeId.METEOR:
            return alive.length ? buildMeteor(w, alive, rng) : [];

        case AttackModeId.FULL_SWEEP:
            return buildFullScreen(w, scene, alive, rng);

        default:
            return buildBullet(d, w, p, 1, scene);
    }
}

// ====================================================================
// 各形态的实现
// ====================================================================

/**
 * 近战挥砍：贴在玩家身前的短命判定体，跟随走位。
 * 速度 0 —— 它不是飞出去的，而是"原地挥一下"。
 */
function buildMelee(d: Vec2, w: WeaponSpec, p: Vec2): Projectile[] {
    const reach = w.range * 0.55;
    return [
        make('melee', {
            pos: vadd(p, vscale(d, reach)),
            dir: d,
            speed: 0,
            life: 0.13,
            damage: w.damage,
            radius: Math.max(30, w.range * 0.5),
            pierce: -1, // 挥砍范围内的敌人全部命中
            attachDist: reach,
        }),
    ];
}

/**
 * 普通弹丸 / 三连射：count 发，±散布。
 * 弹道飞满全屏（锁定目标时在目标身后一点收尾），所以"锁定了就一定打得到"。
 *
 * 散布角是 7° 而不是 12°：
 *   三连射的每发子弹只命中一个敌人（pierce 0），
 *   12° 的间距意味着飞过 200px 后三发相距 42px ——
 *   比敌人半径还大，等于对单目标时只有一发能中，频率优势直接腰斩。
 *   7° 时三发在 200px 处相距约 24px，能落在同一个目标身上，
 *   "靠频率压死敌人"这把武器才立得住。
 *   代价是失去了大范围覆盖，但那是震荡波/横扫类武器的职责，不是速攻武器的。
 */
function buildBullet(d: Vec2, w: WeaponSpec, p: Vec2, count: number, scene: Scene): Projectile[] {
    const speed = 620;
    const spread = count > 1 ? (7 * Math.PI) / 180 : 0;
    const dmg = count > 1 ? w.damage * 0.62 : w.damage;
    const travel = travelDist(w, scene, true);
    const out: Projectile[] = [];

    for (let i = 0; i < count; i++) {
        const offset = count > 1 ? (i - (count - 1) / 2) * spread : 0;
        const dir = vrot(d, offset);
        out.push(
            make('bullet', {
                pos: vadd(p, vscale(dir, 26)),
                dir,
                speed,
                life: Math.max(0.08, travel / speed),
                damage: Math.max(1, Math.round(dmg)),
                radius: 15,
                pierce: 0,
            })
        );
    }
    return out;
}

/** 范围剑气：往前推出去的一段宽判定，能扫到多个敌人 */
function buildSweep(d: Vec2, w: WeaponSpec, p: Vec2): Projectile[] {
    const reach = w.range * 0.5;
    return [
        make('sweep', {
            pos: vadd(p, vscale(d, reach)),
            dir: d,
            speed: 230,
            life: 0.30,
            damage: w.damage,
            radius: w.range * 0.7,
            pierce: -1,
            attachDist: reach,
        }),
    ];
}

/**
 * 穿透弹：一路穿过去，最多打穿 `w.pierce` 个（默认 5）。
 * 穿透要贯穿全场，所以弹道按全屏算，不在目标处收尾。
 *
 * 穿透数按武器配（见 WEAPON_BASE_PIERCE）：长枪 5 / 光矛 3。
 * 如果统一给 5，光矛会因为"同样穿透 + 更长射程 + 自动瞄准"变成长枪的上位替代。
 */
function buildPierce(d: Vec2, w: WeaponSpec, p: Vec2, scene: Scene): Projectile[] {
    const speed = 780;
    return [
        make('pierce', {
            pos: vadd(p, vscale(d, 26)),
            dir: d,
            speed,
            life: travelDist(w, scene, false) / speed,
            damage: w.damage,
            radius: 19,
            pierce: w.pierce ?? 5,
        }),
    ];
}

/** 震荡波：以玩家为中心向外扩散的圆环，自身不动、半径持续变大 */
function buildShockwave(w: WeaponSpec, p: Vec2): Projectile[] {
    const r0 = w.range * 0.35;
    return [
        make('shockwave', {
            pos: p,
            speed: 0,
            life: 0.45,
            damage: w.damage,
            radius: r0,
            growRate: w.range * 2.2,
            pierce: -1,
            attachDist: 0, // 跟着玩家，扩到哪算哪
        }),
    ];
}

/** 剑雨 / 箭雨：每个敌人头顶落一发，先延迟再判定 */
function buildRain(w: WeaponSpec, alive: EnemyState[], rng: () => number): Projectile[] {
    const out: Projectile[] = [];
    for (const e of alive) {
        const jitter = 40;
        out.push(
            make('rain', {
                pos: {
                    x: e.pos.x + (rng() - 0.5) * jitter,
                    y: e.pos.y + (rng() - 0.5) * jitter,
                },
                speed: 0,
                life: 0.18,
                delay: 0.32,
                damage: Math.max(1, Math.round(w.damage * 0.85)),
                radius: 58,
                pierce: -1,
            })
        );
    }
    return out;
}

/**
 * 连锁闪电：命中后跳向下一个敌人。
 *
 * 基础 3 跳；`chainBonus`（虫属性镶嵌）每层 +1，封顶 8 跳 ——
 * 不封顶的话一份材料能连锁到全屏，虫属性会变成"唯一正确的属性"。
 */
function buildChain(d: Vec2, w: WeaponSpec, p: Vec2, scene: Scene): Projectile[] {
    const speed = 1500;
    const travel = travelDist(w, scene, true);
    const chainLeft = Math.max(1, Math.min(8, 3 + Math.floor(w.chainBonus || 0)));
    return [
        make('chain', {
            pos: vadd(p, vscale(d, 20)),
            dir: d,
            speed,
            life: Math.max(0.1, Math.min(0.8, travel / speed)),
            damage: w.damage,
            radius: 24,
            pierce: 0,
            chainLeft,
        }),
    ];
}

/** 陨石：落到目标脚下，延迟后炸开一个大范围 */
function buildMeteor(w: WeaponSpec, alive: EnemyState[], rng: () => number): Projectile[] {
    void rng;
    // 取一个靠中间的敌人作为落点，其余靠爆炸范围覆盖
    const target = alive[Math.floor(alive.length / 2)];
    return [
        make('meteor', {
            pos: { x: target.pos.x, y: target.pos.y },
            speed: 0,
            life: 0.20,
            delay: 0.42,
            damage: Math.round(w.damage * 2.2),
            radius: Math.max(90, w.range * 0.55),
            pierce: -1,
        }),
    ];
}

/**
 * 全屏滚动（割草形态）。
 *
 * 分两种落法，由 attackModeId 决定：
 *   RAIN      → 全屏剑雨：场上每个敌人 + 若干随机点都挨一发
 *   FULL_SWEEP → 滚轮横扫：从屏幕一侧滚到另一侧，无限穿透
 * 其余攻击方式在全屏模式下统一退化成滚轮。
 */
function buildFullScreen(w: WeaponSpec, scene: Scene, alive: EnemyState[], rng: () => number): Projectile[] {
    if (alive.length === 0) return [];

    if (w.attackModeId === AttackModeId.RAIN) {
        // 全屏剑雨：敌人各一发，再补 4 发随机点，铺满屏幕
        const out: Projectile[] = [];
        const spots: Vec2[] = alive.map((e) => ({ x: e.pos.x, y: e.pos.y }));
        for (let i = 0; i < 4; i++) {
            spots.push({
                x: 80 + rng() * (scene.arenaW - 160),
                y: 80 + rng() * (scene.arenaH - 160),
            });
        }
        for (const s of spots) {
            out.push(
                make('rain', {
                    pos: s,
                    speed: 0,
                    life: 0.18,
                    delay: 0.30,
                    damage: Math.max(1, Math.round(w.damage * 0.7)),
                    radius: 66,
                    pierce: -1,
                })
            );
        }
        return out;
    }

    // 滚轮横扫：从场地一侧滚向另一侧，无限穿透
    const fromLeft = rng() < 0.5;
    const y = alive[Math.floor(rng() * alive.length)].pos.y;
    const x = fromLeft ? -70 : scene.arenaW + 70;
    const dir: Vec2 = { x: fromLeft ? 1 : -1, y: 0 };
    const speed = 900;
    const travel = scene.arenaW + 140;

    return [
        make('wheel', {
            pos: { x, y },
            dir,
            speed,
            life: travel / speed,
            damage: w.damage,
            radius: 76,
            pierce: -1,
        }),
    ];
}
