/**
 * 标定探针 —— 用**真实战斗**测出每把武器的实际输出，校准 `BalanceGuard` 的模型
 *
 * 【为什么需要它】
 * `BalanceGuard` 的「期望命中数」是人拍的（范围类 3 个目标、连锁 3.5……）。
 * 拍脑袋的系数会让整个平衡结论偏移 —— 而平衡结论决定阵型推荐名单，
 * 错了就是「推荐文案与实测手感矛盾」，比不做推荐更糟。
 *
 * 所以这里**不用机器人当裁判**（历史上试过，两个机器人给出互相矛盾的结论），
 * 改用一条中立的路径：**让真实的 `BattleWorld` 跑固定场景，统计它真实造成了多少伤害**。
 *
 * - 不比较「哪把更强」—— 那正是机器人给出矛盾结论的地方
 * - 只测「一把武器在固定场景下的输出量」—— 客观、可复算
 *
 * 探针跑完后，模型系数应当与探针结果**同量级**；
 * 若差很多，说明模型某处假设错了，**改模型而不是改数值**。
 *
 * 用法：`npm run calibrate`
 */

import { BattleWorld } from '../.test-build/battle/BattleWorld.js';
import { AimModeId } from '../.test-build/data/GameTypes.js';
import * as BG from '../.test-build/data/BalanceGuard.js';
import * as FC from '../.test-build/data/FormConfig.js';
import * as EC from '../.test-build/data/EquipmentConfig.js';

// ------------------------------------------------------------------
// 固定场景：所有武器在完全相同的条件下战斗
// ------------------------------------------------------------------

const SCENE = {
    count: 40,
    hp: 400,           // 血够高，能持续挨打但会被打死，输出得以累积
    atk: 1,            // 敌人伤害压到最低
    speed: 55,
    radius: 22,
    atkInterval: 999,  // 敌人几乎不攻击，玩家不会被打死中断战斗
    expValue: 1,
    batchSize: 5,
    batchInterval: 0.5,
};

const SEEDS = [11, 22, 33];
const DT = 1 / 60;
const SECONDS = 10;

/** 取该形态的瞄准方式（形态覆盖优先，否则按武器类型） */
function aimOf(form) {
    if (form.aimModeId !== undefined) return form.aimModeId;
    const def = EC.getEquipDef(form.id);
    return def ? def.aimMode : AimModeId.FRONT;
}

/** 把一个根形态包装成能上战场的 WeaponSpec（与 EquipmentManager 口径一致） */
function specOf(formId) {
    const f = FC.getForm(formId);
    const rootId = f.sources[0] || formId;
    const def = EC.getEquipDef(rootId);
    const base = def ? def.levels[0].baseDamage : 100;
    const damage = Math.max(1, Math.round(base * (1 + f.atkPct)));
    const aim = aimOf(f);
    return {
        equipId: rootId,
        formId: f.id,
        name: f.name,
        type: f.equipType,
        depth: f.depth,
        aimMode: aim,
        attackModeId: f.attackModeId,
        damage,
        range: Math.round(BG.rangeOf(f.equipType) * (1 + f.rangePct)),
        interval: BG.intervalOf(f.equipType),
        aimModeText: '',
        attackModeText: '',
        pierce: BG.pierceOf(f.equipType),
        chainBonus: 0,
    };
}

/**
 * 真实战斗跑一把武器，返回实际 DPS。
 *
 * 做法：给敌人足够高的血让它们不死，然后按血量差额统计总输出。
 * 敌人被打死后会立刻补上（分批投放），所以血量差能持续累积。
 */
function measureDps(formId) {
    let total = 0;
    for (const seed of SEEDS) {
        const w = new BattleWorld();
        w.setup({
            playerHp: 1000000,
            weapons: [specOf(formId)],
            enemy: { ...SCENE, formation: 'scatter' },
            seed,
        });
        // 🔑 `w.enemies` 只保留**当前批**的活人（长度 = batchSize，不是 count），
        // 所以不能按数组长度统计伤害。
        //
        // 改成逐帧累加「本帧敌人血量的总减少量」：
        // 每帧扫一遍 enemies，把 (maxHp - hp) 的增量加到累加器。
        // 敌人死亡后从数组移除，它造成的伤害已经在那之前计入，不会漏。
        let dealt = 0;
        let prevLost = 0;
        const steps = Math.round(SECONDS / DT);
        for (let i = 0; i < steps; i++) {
            // 🔑 **必须让玩家移动**，否则近战武器的真实 DPS 恰好是 0。
            //
            // 第一版探针没给移动输入，铁剑 / 铁锤 / 巨镰 测出来全是 0。
            // 这不是 bug —— 它正好印证了历史文档里那句话：
            // 「不动的玩家近战永远够不着」，也解释了为什么
            // 远程比例被当作难度的主要杠杆。
            //
            // 但**平衡测量**不能用站桩场景：那会把所有近战武器
            // 系统性归零，让模型误判成"近战输出为 0"。
            // 所以统一用"绕圈走"这个中立的输入：每2.5 秒换一个方向。
            const phase = (i / 150) % 4;
            const dirs = [{ x: 1, y: 0 }, { x: 0, y: 1 },
                          { x: -1, y: 0 }, { x: 0, y: -1 }];
            w.setMoveInput(dirs[Math.floor(phase)], 1);
            w.update(DT);
            let lost = 0;
            for (const e of w.enemies) {
                lost += e.maxHp - e.hp + (e.maxShield || 0) - (e.shield || 0);
            }
            dealt += lost - prevLost;
            prevLost = lost;
        }
        total += dealt;
    }
    return total / SEEDS.length / SECONDS;
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

const rows = [];
for (const id of FC.WEAPON_ROOT_IDS) {
    const f = FC.getForm(id);
    if (!f) continue;
    const rootId = f.sources[0] || id;
    const def = EC.getEquipDef(rootId);
    const base = def ? def.levels[0].baseDamage : 100;
    const aim = aimOf(f);

    const actual = measureDps(id);
    const predicted = BG.rawDpsCapped({
        damage: Math.max(1, Math.round(base * (1 + f.atkPct))),
        interval: BG.intervalOf(f.equipType),
        attackModeId: f.attackModeId,
        aimModeId: aim,
        pierce: BG.pierceOf(f.equipType),
        targets: SCENE.batchSize,
    });

    rows.push({
        id, name: f.name, mode: f.attackModeId, type: f.equipType,
        aim, predicted, actual,
        ratio: actual > 0 ? predicted / actual : Infinity,
    });
}

const errs = rows.filter((r) => isFinite(r.ratio)).map((r) => Math.abs(r.ratio - 1));
errs.sort((a, b) => a - b);
const medErr = errs.length % 2
    ? errs[Math.floor(errs.length / 2)]
    : (errs[errs.length / 2 - 1] + errs[errs.length / 2]) / 2;
const maxErr = errs[errs.length - 1];

console.log('\n=== 模型预测 vs 真实战斗（散兵场景，' + SECONDS + 's × ' +
    SEEDS.length + ' seeds）===\n');
console.log('武器'.padEnd(12) + '预测DPS'.padStart(9) + '真实DPS'.padStart(10) +
    '   偏差');
rows.sort((a, b) => b.actual - a.actual).forEach((r) => {
    const pct = ((r.ratio - 1) * 100);
    const flag = Math.abs(pct) > 60 ? '  <= 差很多' : '';
    console.log(
        r.name.padEnd(12) +
        r.predicted.toFixed(1).padStart(9) +
        r.actual.toFixed(1).padStart(10) +
        (isFinite(pct) ? pct.toFixed(0).padStart(6) + '%' : '    n/a') + flag);
});
console.log('\n中位偏差 ' + (medErr * 100).toFixed(0) + '%最大偏差 ' +
    (maxErr * 100).toFixed(0) + '%');

export { rows, medErr, maxErr };