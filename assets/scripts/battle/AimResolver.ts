/**
 * 瞄准解析器 —— 五种瞄准方式的行为分水岭
 *
 * 这是玩家需求里那句话的技术落点：
 *   "有的只有前攻击，有的可以锁定，有的根据移动方向攻击，
 *    有的根据最近距离攻击，有的是全屏滚动"
 *
 * 五种模式的**本质区别是"目标信息的来源"**：
 *
 *   FRONT       方向来自玩家朝向      —— 不索敌，命中靠走位
 *   LOCK_ON     方向来自锁定的敌人     —— 有记忆，跨帧保持
 *   MOVE_DIR    方向来自拖动输入       —— 无记忆，实时跟随
 *   NEAREST     方向来自最近敌人       —— 无记忆，每帧重算
 *   SCREEN_ROLL 没有方向              —— 全屏横扫
 *
 * FRONT / NEAREST / LOCK_ON 三者最容易混淆，区别在于：
 *   FRONT 是"我朝哪打哪"，玩家可以故意打空；
 *   NEAREST 是"哪近打哪"，每帧都可能换目标，子弹会左右横跳；
 *   LOCK_ON 是"锁住不放"，目标死了才换，弹道稳定但可能追着一个远目标跑。
 * 手感差别很大，三条路都要能配得出来。
 */

import { AimModeId } from '../data/GameTypes';
import { AimContext, AimResult, EnemyState, Vec2, vdist, vlen, vnorm, vsub } from './BattleTypes';

/**
 * 瞄准射程余量。
 *
 * 射程由 BattleWorld 传入，默认就是**全屏射程**（场地对角线），
 * 所以正常游戏里这条判断几乎不会触发 —— 屏幕上的敌人全都够得着。
 *
 * 它真正的作用是一个安全网：一旦关卡把射程调小
 * （BattleSetup.engageRange），或者敌人跑到场地外，
 * 就宁可不开火也不要对着打不到的目标一直挥 —— 那样既浪费弹药又让人困惑。
 */
export const AIM_RANGE_SLACK = 1.6;

/** 从敌人列表里找出距离 from 最近的一个，没有存活敌人返回 null */
export function findNearest(
    enemies: EnemyState[],
    from: Vec2,
    exclude?: number[],
    maxDist?: number
): EnemyState | null {
    let best: EnemyState | null = null;
    let bestD = Infinity;
    for (const e of enemies) {
        if (!e.alive) continue;
        if (exclude && exclude.indexOf(e.id) >= 0) continue;
        const d = vdist(e.pos, from);
        if (maxDist !== undefined && d > maxDist) continue;
        if (d < bestD) {
            bestD = d;
            best = e;
        }
    }
    return best;
}

function findById(enemies: EnemyState[], id: number): EnemyState | null {
    if (!id) return null;
    for (const e of enemies) {
        if (e.id === id && e.alive) return e;
    }
    return null;
}

function result(mode: AimModeId, dir: Vec2, partial?: Partial<AimResult>): AimResult {
    return {
        mode,
        dir,
        targetId: 0,
        lockedId: 0,
        fullScreen: false,
        skip: false,
        ...partial,
    };
}

/**
 * 解析一次攻击的取目标结果。
 *
 * 注意：本函数**不修改任何输入**，锁定状态由调用方（BattleWorld）
 * 根据返回的 lockedId 自行写回。保持纯函数，测试才好写。
 */
export function resolveAim(ctx: AimContext): AimResult {
    const facing = vlen(ctx.facing) > 1e-6 ? vnorm(ctx.facing) : { x: 1, y: 0 };

    switch (ctx.mode) {
        // ---------------------------------------------------------------
        // 前向攻击：只打面朝方向。不索敌 —— 背后有敌人也完全不管。
        // 玩家必须靠走位把敌人甩到正前方，这是铁剑的操作门槛。
        // ---------------------------------------------------------------
        case AimModeId.FRONT: {
            return result(AimModeId.FRONT, facing);
        }

        // ---------------------------------------------------------------
        // 锁定：优先沿用既有锁定目标，目标死亡或跑出射程才重新索敌。
        // 这是唯一带"记忆"的索敌方式，弹道因此最稳定。
        //
        // 射程 = 全屏（BattleWorld 传入），所以"跑出射程"通常不会发生；
        // 一旦发生就**解锁 + 停火**：宁可这一发不打，
        // 也不要把子弹浪费在射程外的目标上（子弹会在半路消失，看起来像 bug）。
        // ---------------------------------------------------------------
        case AimModeId.LOCK_ON: {
            const limit = ctx.range * AIM_RANGE_SLACK;
            let target = findById(ctx.enemies, ctx.lockedId);
            if (target && vdist(target.pos, ctx.playerPos) > limit) {
                target = null; // 跑太远了，解锁
            }
            // 注意：重新索敌时也必须受射程约束，否则"解锁"等于没解
            if (!target) target = findNearest(ctx.enemies, ctx.playerPos, undefined, limit);
            if (!target) {
                return result(AimModeId.LOCK_ON, facing, { skip: true, lockedId: 0 });
            }
            return result(AimModeId.LOCK_ON, vnorm(vsub(target.pos, ctx.playerPos)), {
                targetId: target.id,
                lockedId: target.id,
            });
        }

        // ---------------------------------------------------------------
        // 移动方向：方向 = 拖动方向。原地不动时退回当前朝向，
        // 保证站桩输出不至于打不出去。
        // 这是唯一让玩家能"主动指定攻击方向"的方式（可以对着空气挥）。
        // ---------------------------------------------------------------
        case AimModeId.MOVE_DIR: {
            const moving = vlen(ctx.moveDir) > 1e-3 && ctx.moveStrength > 0.01;
            const dir = moving ? vnorm(ctx.moveDir) : facing;
            return result(AimModeId.MOVE_DIR, dir);
        }

        // ---------------------------------------------------------------
        // 最近距离：每次攻击重新算最近目标，且只在射程内挑。
        // 无记忆 —— 敌人在你身边快速换位时，弹道会跟着左右横跳。
        // ---------------------------------------------------------------
        case AimModeId.NEAREST: {
            const target = findNearest(
                ctx.enemies,
                ctx.playerPos,
                undefined,
                ctx.range * AIM_RANGE_SLACK
            );
            if (!target) {
                return result(AimModeId.NEAREST, facing, { skip: true });
            }
            return result(AimModeId.NEAREST, vnorm(vsub(target.pos, ctx.playerPos)), {
                targetId: target.id,
            });
        }

        // ---------------------------------------------------------------
        // 全屏滚动：不需要方向，也不需要目标。
        // 但场上必须还有敌人，否则空放横扫毫无意义。
        // ---------------------------------------------------------------
        case AimModeId.SCREEN_ROLL: {
            if (!findNearest(ctx.enemies, ctx.playerPos)) {
                return result(AimModeId.SCREEN_ROLL, facing, { fullScreen: true, skip: true });
            }
            return result(AimModeId.SCREEN_ROLL, facing, { fullScreen: true });
        }

        default: {
            return result(AimModeId.FRONT, facing);
        }
    }
}
