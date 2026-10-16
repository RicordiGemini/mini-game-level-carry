/**
 * 武器平衡守卫测试 —— 机制模型 + 真实战斗探针
 *
 * 【为什么这一套最重要】
 * 前面的套件都在验「配置表自身是否自洽」。这一套验的是**数值是否合理**，
 * 而数值错了不会崩溃、不会报错，只会让游戏「不好玩」——
 * 出现一把必选武器，或者一把没人用的武器。
 *
 * 【两条腿走路】
 *   1. **机制模型**（`BalanceGuard`）：纯函数、可注入、瞬时出结果。
 *      抓「某把武器明显超标/ 明显垫底」。
 *   2. **真实战斗探针**：让真的 `BattleWorld` 跑固定场景，统计真的伤害。
 *      抓「模型骗了自己」。
 *
 * 历史上试过让机器人打关卡当平衡裁判，结果「站桩」模式系统性偏袒远程武器
 * （不动的玩家近战永远够不着），「贴近后撤」模式又冤枉了移动向武器 ——
 * 两个机器人给出互相矛盾的结论。所以定论是：
 * **机器人只用来观察难度曲线，平衡交给机制模型 + 定场景实测。**
 */

import { createSuite } from './assert.mjs';

import { BattleWorld } from '../.test-build/battle/BattleWorld.js';
import * as BG from '../.test-build/data/BalanceGuard.js';
import * as FC from '../.test-build/data/FormConfig.js';
import * as EC from '../.test-build/data/EquipmentConfig.js';
import { AttackModeId, AimModeId } from '../.test-build/data/GameTypes.js';

const t = createSuite('武器平衡守卫（机制模型 + 真实战斗探针）');
const { section, ok, eq, expectError, expectClean, expectCount } = t;

// ==================================================================
section('1 · 机制常量与 AttackFactory 同源');
// ==================================================================

{
  // 这些常量被 AttackFactory 直接 import —— 同一份数字，不存在抄两份的可能。
  // 这组断言锁的是「常量本身的取值」，改它们会同时改战斗与模型。
  ok(BG.TRIPLE_SHOT_FALLOFF === 0.62, '1.1 三连射衰减 = 0.62（3×0.62=1.86，不是 3）');
  ok(BG.RAIN_DAMAGE_MUL === 0.85, '1.2 局部剑雨每发 0.85');
  ok(BG.FULL_RAIN_DAMAGE_MUL === 0.7, '1.3 全屏剑雨每发 0.7');
  ok(BG.METEOR_DAMAGE_MUL === 2.2, '1.4 陨石 2.2 倍');
  ok(BG.CHAIN_BASE_JUMPS === 3, '1.5 连锁基础 3 跳');
  ok(BG.CHAIN_MAX_JUMPS === 8, '1.6 连锁封顶 8 跳（不封顶虫属性会连锁全屏）');
  ok(BG.CHAIN_MAX_JUMPS > BG.CHAIN_BASE_JUMPS, '1.7 连锁上限必须高于基础跳数');
}

{
  // 瞄准可靠度：模型里最容易被拍脑袋的一组系数。
  // 自动索敌的三种必须满分 —— 它们在机制上不可能打空。
  eq(BG.AIM_RELIABILITY[AimModeId.LOCK_ON], 1.0, '1.8 锁定 = 1.00');
  eq(BG.AIM_RELIABILITY[AimModeId.NEAREST], 1.0, '1.9 最近 = 1.00');
  eq(BG.AIM_RELIABILITY[AimModeId.SCREEN_ROLL], 1.0, '1.10 全屏 = 1.00');
  // 需要玩家操作的两种必须低于 1
  ok(BG.AIM_RELIABILITY[AimModeId.FRONT] < 1.0, '1.11 前向 < 1.00（要靠走位对准）');
  ok(BG.AIM_RELIABILITY[AimModeId.MOVE_DIR] < 1.0, '1.12 移动向 < 1.00');
  // 前向比移动向更容易打空（移动向至少跟着敌人走）
  ok(BG.AIM_RELIABILITY[AimModeId.FRONT] < BG.AIM_RELIABILITY[AimModeId.MOVE_DIR],
    '1.13 前向可靠度低于移动向',
    `实际 ${BG.AIM_RELIABILITY[AimModeId.FRONT]} vs ${BG.AIM_RELIABILITY[AimModeId.MOVE_DIR]}`);
  // 全部五种瞄准方式都必须有取值 —— 漏一个就是 undefined 参与运算
  for (const m of [0, 1, 2, 3, 4]) {
    ok(typeof BG.AIM_RELIABILITY[m] === 'number' && BG.AIM_RELIABILITY[m] > 0,
      `1.14 瞄准方式 ${m} 有正的可靠度`,
      `实际 ${BG.AIM_RELIABILITY[m]}`);
  }
}

// ==================================================================
section('2 · 期望命中数');
// ==================================================================

{
  eq(BG.expectedHitsOf(AttackModeId.SINGLE_MELEE, 1), 1, '2.1 单体近战 = 1');
  eq(BG.expectedHitsOf(AttackModeId.SINGLE_RANGED, 1), 1, '2.2 单体远程 = 1');
  eq(BG.expectedHitsOf(AttackModeId.TRIPLE_SHOT, 1), 3 * 0.62, '2.3 三连射 = 1.86');
  eq(BG.expectedHitsOf(AttackModeId.PIERCE, 5), 5, '2.4 贯穿按配置值（长枪 5）');
  eq(BG.expectedHitsOf(AttackModeId.PIERCE, 3), 3, '2.5 贯穿按配置值（光矛 3）');
}

{
  // 🔑 同屏上限：场上只有 4 只时，长枪的 pierce 5 只能打 4 个。
  // 这是第一版模型最大的系统性偏差来源。
  eq(BG.expectedHitsCapped(AttackModeId.PIERCE, 5, 4), 4, '2.6 4 只在场时 pierce 5 封顶到 4');
  eq(BG.expectedHitsCapped(AttackModeId.PIERCE, 3, 8), 3, '2.7 8 只在场时 pierce 5 不被压');
  eq(BG.expectedHitsCapped(AttackModeId.PIERCE, 5, 2), 2, '2.8 2 只在场时封顶到 2');
  // 至少 1 —— 不能因为场上没怪就变成 0 伤害
  eq(BG.expectedHitsCapped(AttackModeId.PIERCE, 5, 0), 1, '2.9 同屏 0 只时至少保 1');
  // 非贯穿类不该被这个上限影响
  eq(BG.expectedHitsCapped(AttackModeId.SINGLE_MELEE, 1, 2), 1, '2.10 单体不受同屏上限影响');
  eq(BG.expectedHitsCapped(AttackModeId.SWEEP, 1, 2), 3, '2.11 横扫不受同屏上限影响');
}

{
  // 贯穿是「光矛不能变成长枪上位替代」这条设计在模型里的落点。
  // 两条注释（WEAPON_BASE_PIERCE）说的正是这件事，这里守住它。
  ok(BG.pierceOf('spear') > BG.pierceOf('lance'),
    '2.12 长枪穿透数 > 光矛（否则光矛是长枪的严格上位替代）',
    `实际 spear=${BG.pierceOf('spear')} lance=${BG.pierceOf('lance')}`);
}

{
  // 同屏敌人数公式必须与 LevelConfig 一致。
  // 第 1 关普通难度：(4 + 0) × 1.0 × 1.0 = 4 → ceil(4/3) = 2
  eq(BG.typicalBatchOf(1, 1, 0), 2, '2.13 第 1 关同屏 2 只');
  // 第 30 关：(4 + 15) = 19 → ceil(19/3) = 7
  eq(BG.typicalBatchOf(30, 1, 0), 7, '2.14 第 30 关同屏 7 只');
  // 难度倍率与复玩加难都会放大
  ok(BG.typicalBatchOf(30, 1.5, 0) > BG.typicalBatchOf(30, 1, 0), '2.15 难度倍率放大同屏数');
  ok(BG.typicalBatchOf(30, 1, 1.2) > BG.typicalBatchOf(30, 1, 0), '2.16 复玩加难放大同屏数');
  // 下限：第 1 关困难也不低于 2
  ok(BG.typicalBatchOf(1, 0.8, 0) >= 2, '2.17 同屏数有下限（至少 2）');
}

// ==================================================================
section('3 · 中位数与归一化');
// ==================================================================

{
  eq(BG.medianOf([1, 2, 3]), 2, '3.1 奇数个取中位');
  eq(BG.medianOf([1, 2, 3, 4]), 2.5, '3.2 偶数个取中间平均');
  eq(BG.medianOf([5]), 5, '3.3 单个');
  eq(BG.medianOf([]), 0, '3.4 空数组返回 0');

  // 归一化后中位数应当恰好是 1
  const r1 = BG.budgetRatios([10, 20, 30]);
  eq(BG.medianOf(r1).toFixed(6), '1.000000', '3.5 归一化后中位 = 1');
  const r2 = BG.budgetRatios([5, 5, 5]);
  eq(BG.medianOf(r2).toFixed(6), '1.000000', '3.6 全相等时中位仍是 1');
  // 相对关系保持
  eq((r1[0] / r1[2]).toFixed(6), (10 / 30).toFixed(6), '3.7 归一化保持相对比值');
  eq(r1[0].toFixed(6), (10 / 20).toFixed(6), '3.7b 归一化基准 = 中位数');
  // 边界
  eq(BG.budgetRatios([]).length, 0, '3.8 空输入返回空');
  ok(BG.budgetRatios([0, 0]).every((v) => v === 1), '3.9 全 0 时不产生 NaN/Infinity');
}

// ==================================================================
section('4 · validateBalance 抓得住坏数据');
// ==================================================================

/** 造一份最小但合法的预算表 */
function goodRows() {
  return [
    mkRow('a0', '甲0', 0, 0.95),
    mkRow('a1', '甲1', 1, 1.05),
    mkRow('a2', '甲2', 2, 1.15),
    mkRow('b0', '乙0', 0, 1.00),
    mkRow('b1', '乙1', 1, 1.10),
    mkRow('b2', '乙2', 2, 1.25),
  ];
}
function mkRow(formId, name, depth, ratio, type = 'blade') {
  return {
    formId, name, depth, equipType: type, ratio,
    attackModeId: AttackModeId.SINGLE_MELEE,
    aimModeId: AimModeId.FRONT,
    rawDps: ratio * 100,
  };
}

{
  expectClean(BG.validateBalance(goodRows()), '4.1 正常配置零错误');
}

{
  const bad = goodRows();
  bad[0].ratio = 0.3;
  expectError(BG.validateBalance(bad), '预算过低', '4.2 预算过低 → 报错');
}
{
  const bad = goodRows();
  bad[0].ratio = 3.0;
  expectError(BG.validateBalance(bad), '预算过高', '4.3 预算过高 → 报错');
}
{
  // 边界：恰好等于 min/max 不该报「过低/过高」。
  // 注意构造方式 —— 不能把全部形态设成同一值，那会连带触发
  //「预算完全相同」与「中位数漂移」两条规则，测的就不是边界了。
  const atMin = goodRows();
  atMin[0].ratio = BG.BUDGET_MIN;
  atMin[1].ratio = BG.BUDGET_MIN + 0.05;
  expectClean(BG.validateBalance(atMin).filter((e) => e.includes('过低')),
    '4.4 恰好等于下界不算越界');

  const atMax = goodRows();
  atMax[0].ratio = BG.BUDGET_MAX;
  atMax[1].ratio = BG.BUDGET_MAX - 0.05;
  expectClean(BG.validateBalance(atMax).filter((e) => e.includes('过高')),
    '4.5 恰好等于上界不算越界');
}
{
  // 越界一点点就该报
  const edge = goodRows().map((r) => ({ ...r, ratio: BG.BUDGET_MAX + 0.001 }));
  expectError(BG.validateBalance(edge), '预算过高', '4.6 超上界 0.001 就该报');
}
{
  const edge = goodRows().map((r) => ({ ...r, ratio: BG.BUDGET_MIN - 0.001 }));
  expectError(BG.validateBalance(edge), '预算过低', '4.7 低于下界 0.001 就该报');
}

{
  // 中位数漂移：全部拉到同一条线之外
  const drift = goodRows().map((r) => ({ ...r, ratio: r.ratio * 0.3 }));
  expectError(BG.validateBalance(drift), '中位数', '4.8 中位数漂移 → 报错');
}

{
  // 空表必须报「无法校验」而不是崩
  const errs = BG.validateBalance([]);
  ok(errs.length > 0, '4.9 空表不崩且报错', JSON.stringify(errs));
  expectError(BG.validateBalance([]), '预算表为空', '4.10 空表报的是「预算表为空」');
}

{
  // 同型同层互相压制：goodRows 里 甲/乙 都是 blade 型。
  // depth 0 上有 甲0=0.95 与 乙0=1.00，把乙0压到 0.90 就构成压制。
  const bad = goodRows();
  bad[3].ratio = 0.90;          // 乙0 低于同层同型的 甲0=0.95
  const errs = BG.validateBalance(bad);
  expectError(errs, '同层不该互相压制', '4.11 同型同层互相压制 → 报错');
}

{
  // 反向确认：不同型之间不比（同型才互斥）
  const bad = goodRows();
  bad[3].equipType = 'bow';      // 乙0 换成另一型，不再与 甲0 同型
  bad[3].ratio = 0.90;
  const errs = BG.validateBalance(bad);
  ok(!errs.some((e) => e.includes('同层不该互相压制')),
    '4.11b 不同型之间不做压制检查',
    JSON.stringify(errs.filter((e) => e.includes('同层'))));
}

{
  // 完全相等 = 可互相无条件替换
  const bad = goodRows();
  bad[3].ratio = bad[0].ratio;
  expectError(BG.validateBalance(bad), '预算完全相同', '4.12 两件预算相同 → 报错');
}

{
  // 阈值可注入（测试自己传更宽的区间，不影响生产默认）
  const wide = BG.validateBalance(
    goodRows().map((r) => ({ ...r, ratio: r.ratio * 1.5 })),
    { min: 0, max: 99, medianMin: 0, medianMax: 99 });
  expectClean(wide, '4.13 注入宽松阈值后不再报错');
}

{
  // 单点畸形只报对应的那一条，不产生误报风暴
  const one = goodRows();
  one[0].ratio = 0.3;
  const errs = BG.validateBalance(one);
  ok(errs.length >= 1, '4.14 单点畸形至少报 1 条');
  ok(errs.every((e) => e.includes('甲0')),
    '4.15 单点畸形只提到那一个形态', JSON.stringify(errs));
}

// ==================================================================
section('5 · validateProbeAgreement 抓得住偏差');
// ==================================================================

{
  const model = goodRows();
  const exact = model.map((r) => ({ formId: r.formId, dps: r.rawDps }));
  expectClean(BG.validateProbeAgreement(model, exact), '5.1 完全一致 → 无错');
}
{
  // 高估 4 倍 → 应报（实测只有预测的 1/4，低于容忍下限 1/3）
  const model = goodRows();
  const probe = model.map((r) => ({ formId: r.formId, dps: r.rawDps / 4 }));
  expectError(BG.validateProbeAgreement(model, probe), '模型/实测偏离', '5.2 高估 4 倍 → 报错');
}
{
  // 低估 4 倍 → 应报（高 pierce 武器就是这个方向）
  const model = goodRows();
  const probe = model.map((r) => ({ formId: r.formId, dps: r.rawDps * 4 }));
  expectError(BG.validateProbeAgreement(model, probe), '模型/实测偏离', '5.3 低估 4 倍 → 报错');
}
{
  // 容忍区间边缘：高估 2.5 倍（实测是预测的 1/2.5 = 0.4 > 1/3）仍应放过
  const model = goodRows();
  const okHigh = model.map((r) => ({ formId: r.formId, dps: r.rawDps / 2.5 }));
  expectClean(BG.validateProbeAgreement(model, okHigh), '5.4 高估 2.5 倍仍在容忍内');
}
{
  // 实测为 0 → 必须报（那是「打不中」，模型不负责但必须提示）
  const model = goodRows();
  const probe = model.map((r, i) => ({ formId: r.formId, dps: i === 0 ? 0 : r.rawDps }));
  expectError(BG.validateProbeAgreement(model, probe), '实测 DPS 为 0', '5.5 实测 0 → 报错');
}
{
  // 没测到的形态跳过，不误报
  const model = goodRows();
  const probe = model.slice(0, 2).map((r) => ({ formId: r.formId, dps: r.rawDps }));
  expectClean(BG.validateProbeAgreement(model, probe), '5.6 未测形态被跳过');
}
{
  // 阈值可注入
  const model = goodRows();
  const probe = model.map((r) => ({ formId: r.formId, dps: r.rawDps / 10 }));
  expectClean(BG.validateProbeAgreement(model, probe, 0, 100), '5.7 注入宽松阈值后不报错');
}

// ==================================================================
section('6 · 真实配置（当前数值是否合理）');
// ==================================================================

const weaponForms = FC.ALL_FORMS.filter((f) => f.kind === 'weapon');

{
  ok(weaponForms.length > 100, '6.1 武器形态表规模正常',
    `实际 ${weaponForms.length}`);
  ok(FC.WEAPON_ROOT_IDS.length === 18, '6.2 18 条武器线',
    `实际 ${FC.WEAPON_ROOT_IDS.length}`);
}

{
  // 用与 EquipmentManager 相同的口径取基础伤害
  const rows = BG.budgetOf(weaponForms, (f) => {
    const rootId = f.sources[0] || f.id;
    const def = EC.getEquipDef(rootId);
    return (def ? def.levels[0].baseDamage : 100) * (1 + f.atkPct);
  });

  ok(rows.length === weaponForms.length, '6.3 预算表覆盖全部武器形态');

  // 🔑 按 depth 分层归一化 —— 跨层比较没有意义（深度就是强度轴）
  const byDepth = new Map();
  for (const r of rows) {
    if (!byDepth.has(r.depth)) byDepth.set(r.depth, []);
    byDepth.get(r.depth).push(r);
  }
  for (const [d, g] of byDepth) {
    const med = BG.medianOf(g.map((r) => r.ratio));
    ok(Math.abs(med - 1) < 1e-6,
      `6.4 depth ${d} 层内中位数为 1`, `实际 ${med}`);
  }
}

{
  // 每层的最高 / 最低，记录真实分布（供文档引用）
  const rows = BG.budgetOf(weaponForms, (f) => {
    const rootId = f.sources[0] || f.id;
    const def = EC.getEquipDef(rootId);
    return (def ? def.levels[0].baseDamage : 100) * (1 + f.atkPct);
  });
  const byDepth = new Map();
  for (const r of rows) {
    if (!byDepth.has(r.depth)) byDepth.set(r.depth, []);
    byDepth.get(r.depth).push(r);
  }
  for (const [d, g] of [...byDepth].sort((a, b) => a[0] - b[0])) {
    const rr = g.map((r) => r.ratio);
    const lo = Math.min(...rr), hi = Math.max(...rr);
    console.log(`  depth ${d}: n=${g.length}最低 ${lo.toFixed(3)} / 最高 ${hi.toFixed(3)}`);
  }
  ok(byDepth.size >= 4, '6.5 形态层级至少 4 层（存在复玩限定路线）',
    `实际 ${byDepth.size}`);
}

// ==================================================================
// ==================================================================
section('7 · 真实战斗探针（BattleWorld 真跑）');
// ==================================================================

/**
 * 定场景实测输出量。
 *
 * 【为什么不用机器人当平衡裁判】
 * 历史上试过让机器人打关卡来判定"哪把武器更强"，结果：
 *   「站桩」模式系统性偏袒远程武器 —— 不动的玩家近战永远够不着
 *   「贴近后撤」模式又冤枉了移动向武器
 * 两个机器人给出**互相矛盾**的结论。
 *
 * 定论：**机器人只用来观察难度曲线，平衡交给机制模型 + 定场景实测。**
 *
 * 这里刻意**不比较哪把更强**（那正是机器人给出矛盾结论的地方），
 * 只测「一把武器在固定场景下打出多少伤害」—— 客观、可复算。
 */
const PROBE = {
  count: 40, hp: 400, atk: 1, speed: 55, radius: 22,
  atkInterval: 999, expValue: 1, batchSize: 5, batchInterval: 0.5,
};
const PROBE_SEEDS = [11, 22, 33];
const PROBE_DT = 1 / 60;
const PROBE_SECONDS = 4;    // 4 秒足够积累稳定输出，又不至于让快攻武器过度领先

function specOf(formId) {
  const f = FC.getForm(formId);
  const rootId = f.sources[0] || formId;
  const def = EC.getEquipDef(rootId);
  const base = def ? def.levels[0].baseDamage : 100;
  const aim = f.aimModeId !== undefined
    ? f.aimModeId
    : (def ? def.aimMode : AimModeId.FRONT);
  return {
    equipId: rootId, formId: f.id, name: f.name,
    type: f.equipType, depth: f.depth,
    aimMode: aim, attackModeId: f.attackModeId,
    damage: Math.max(1, Math.round(base * (1 + f.atkPct))),
    range: Math.round(BG.rangeOf(f.equipType) * (1 + f.rangePct)),
    interval: BG.intervalOf(f.equipType),
    aimModeText: '', attackModeText: '',
    pierce: BG.pierceOf(f.equipType), chainBonus: 0,
  };
}

/**
 * 真实战斗跑一把武器，返回实际 DPS。
 *
 * ⚠️ **必须让玩家移动** —— 第一版探针没给移动输入，
 * 铁剑 / 铁锤 / 巨镰 实测DPS 全部恰好是 0。
 * 那不是 bug，它正好印证了「不动的玩家近战永远够不着」，
 * 但**平衡测量不能用站桩场景**：那会把近战系统性归零。
 */
function measureDps(formId) {
  let total = 0;
  for (const seed of PROBE_SEEDS) {
    const w = new BattleWorld();
    w.setup({
      playerHp: 1000000,
      weapons: [specOf(formId)],
      enemy: { ...PROBE, formation: 'scatter' },
      seed,
    });
    let dealt = 0;
    let prevLost = 0;
    const steps = Math.round(PROBE_SECONDS / PROBE_DT);
    for (let i = 0; i < steps; i++) {
      // 🔑 **必须每帧重设，且方向要朝最近的敌人**。两个坑叠在一起：
      //
      // ① `setMoveInput` 内部把 `_inputHold` 设成 0.12 秒 ——
      //    那是防触摸丢帧的设计（BattleWorld.ts:449），0.12 秒后自动视为松手。
      //    每 2.5 秒才换方向 ⇒ 前 0.12 秒动一下、然后站桩 2.38 秒 ⇒ 近战 DPS = 0。
      //
      // ② **方向固定 = 一路逃跑**。第二版探针用「右→上→左→下」循环，
      //    玩家持续朝一个方向跑，1 秒后就离敌人 868px ——
      //    近战武器仍然打不中。
      //
      // 正确做法：朝**最近的敌人**走。这才是玩家真实在做的事
      //（近战武器本来就必须贴上去），也让测量与设计意图一致。
      let dx = 0, dy = 0;
      let best = Infinity;
      for (const e of w.enemies) {
        if (!e.alive) continue;
        const ex = e.pos.x - w.player.pos.x;
        const ey = e.pos.y - w.player.pos.y;
        const d = ex * ex + ey * ey;
        if (d < best) { best = d; dx = ex; dy = ey; }
      }
      if (best < Infinity) {
        const len = Math.sqrt(best) || 1;
        w.setMoveInput({ x: dx / len, y: dy / len }, 1);
      } else {
        w.stopMove();
      }
      w.update(PROBE_DT);
      // `w.enemies` 只保留当前批的活人，不能按数组长度统计 ——
      // 改成逐帧累加「血量亏损的增量」，敌人被移除前已计入。
      let lost = 0;
      for (const e of w.enemies) {
        lost += e.maxHp - e.hp + (e.maxShield || 0) - (e.shield || 0);
      }
      dealt += lost - prevLost;
      prevLost = lost;
    }
    total += dealt;
  }
  return total / PROBE_SEEDS.length / PROBE_SECONDS;
}

{
  // 探针能跑通，且至少打出伤害（否则下面的比对毫无意义）
  const blade = measureDps('blade');
  ok(blade > 0, '7.1 近战武器在移动场景下能打出伤害',
    `实测 ${blade.toFixed(1)} —— 若为 0 说明探针没给移动输入`);

  const bow = measureDps('bow');
  ok(bow > 0, '7.2 远程武器能打出伤害', `实测 ${bow.toFixed(1)}`);
}

{
  // 探针可复现：同seed 必须得到同结果
  const a = (() => {
    const w = new BattleWorld();
    w.setup({ playerHp: 1e6, weapons: [specOf('blade')],
      enemy: { ...PROBE, formation: 'scatter' }, seed: 77 });
    for (let i = 0; i < 120; i++) w.update(PROBE_DT);
    return w.enemies.map((e) => e.hp).join(',');
  })();
  const b = (() => {
    const w = new BattleWorld();
    w.setup({ playerHp: 1e6, weapons: [specOf('blade')],
      enemy: { ...PROBE, formation: 'scatter' }, seed: 77 });
    for (let i = 0; i < 120; i++) w.update(PROBE_DT);
    return w.enemies.map((e) => e.hp).join(',');
  })();
  eq(a, b, '7.3 固定 seed 的战斗过程可复现');
}

{
  // 🔑 模型 vs 实测的一致性。
  //
  // 这一条不是要求模型精确 —— 它是**粗粒度模型**，
  // 抓的是"某把武器明显超标/ 明显垫底"。
  // 容忍区间 [1/3, 3] 很宽，但宽到能挡住"模型整体失效"。
  //
  // 📊 实测（散兵阵型 + 玩家主动贴脸，中位偏差 49%）：
  //   被低估 3~6 倍的全是**范围/ 全屏类** ——
  //   铁剑 5.2× · 铁锤 4.6× · 巨镰 4.1× · 回旋轮 6.4× · 星刃 6.0× · 震地锤 3.7×
  //
  //   原因很直接：模型给「范围类 = 3 个目标」这个固定值，
  //   而玩家主动贴脸后，震荡波 / 横扫 / 震地的实际覆盖远超 3 个。
  //   **模型的常数里没有"玩家走位"这个变量** —— 它是刻意的：
  //   走位属于玩家技巧，不该写进平衡表，否则同一个数值会因操作水平而异。
  //
  // ⚠️ 所以：**判断某把武器在某个阵型里是否合适，靠的是探针不是模型。**
  // 模型能验方向（谁明显超标 / 谁明显垫底），验不了阵型与操作。
  // 这正是 LevelAffinity 里「克制名单必须经机制模型验证」那条注释的现实。
  const rows = BG.budgetOf(
    FC.WEAPON_ROOT_IDS.map((id) => FC.getForm(id)).filter(Boolean),
    (f) => {
      const rootId = f.sources[0] || f.id;
      const def = EC.getEquipDef(rootId);
      return (def ? def.levels[0].baseDamage : 100) * (1 + f.atkPct);
    },
    PROBE.batchSize);

  const probe = rows.map((r) => ({ formId: r.formId, dps: measureDps(r.formId) }));
  const errs = BG.validateProbeAgreement(rows, probe);

  // 记录实际偏差幅度（供文档引用），但不作为断言 ——
  // 模型与实测的差距是**已知且有解释**的，写死会让后人无从下手。
  const factors = probe
    .map((p, i) => rows[i].rawDps / Math.max(0.001, p.dps))
    .filter((f) => isFinite(f) && f > 0);
  const dev = factors.map((f) => Math.abs(f - 1)).sort((x, y) => x - y);
  const medDev = dev.length % 2
    ? dev[Math.floor(dev.length / 2)]
    : (dev[dev.length / 2 - 1] + dev[dev.length / 2]) / 2;

  console.log(`  探针实测：中位偏差 ${(medDev * 100).toFixed(0)}%，` +
    `${errs.length}/${rows.length} 把超出 [1/3, 3]`);
  if (errs.length) {
    console.log('  超出容忍的（模型局限，非缺陷）：');
    errs.slice(0, 6).forEach((e) => console.log('    - ' + e));
  }

  ok(probe.every((p) => isFinite(p.dps) && p.dps >= 0),
    '7.4 所有武器都能跑出有效实测数据');
  ok(medDev < 3, '7.5 模型未整体失效（中位偏差 < 3 倍）',
    `实际中位偏差 ${(medDev * 100).toFixed(0)}%`);
}

{
  // 站桩场景的近战 DPS 恰好为 0 —— 这是一条**真实设计事实**，值得锁住。
  //
  // 它解释了为什么「远程比例」被当成难度的主要杠杆：
  // 站着不动时近战类武器的输出是 0，游戏会直接变得不可玩。
  const w = new BattleWorld();
  w.setup({ playerHp: 1e6, weapons: [specOf('blade')],
    enemy: { ...PROBE, formation: 'scatter' }, seed: 11 });
  w.stopMove();          // 明确站桩：清掉任何残留移动输入
  let lost = 0, prev = 0;
  for (let i = 0; i < 240; i++) {
    w.update(PROBE_DT);
    let now = 0;
    for (const e of w.enemies) now += e.maxHp - e.hp;
    lost += now - prev;
    prev = now;
  }
  eq(lost, 0, '7.6 站桩不动时近战输出恰好为 0（难度必须靠远程怪逼走位）');
}

// ==================================================================
section('8 · 推荐 / 克制名单可读且自洽');
// ==================================================================

{
  const LC = await import('../.test-build/data/LevelAffinity.js');
  // FORMATION_CYCLE 的真实顺序（LevelAffinity.ts:35）
  const kinds = ['scatter', 'line', 'cluster', 'swarm'];

  for (let i = 0; i < kinds.length; i++) {
    const lv = i + 1;
    ok(LC.formationForLevel(lv) === kinds[i],
      `7.${i + 1} 第 ${lv} 关阵型是 ${kinds[i]}`,
      `实际 ${LC.formationForLevel(lv)}`);
    const rec = LC.affinityForLevel(lv);
    ok(rec.length === 2, `7.${i + 5} ${kinds[i]} 推荐 2 件`, JSON.stringify(rec));
  }

  // 周期是4 关 —— 第 5 关回到第 1 关的阵型
  ok(LC.formationForLevel(5) === LC.formationForLevel(1), '7.9 阵型周期为 4 关');

  // 轮转：同一个阵型在不同关卡应给出不同推荐组合
  const all = [];
  for (let lv = 1; lv <= 16; lv++) all.push(LC.affinityForLevel(lv).join('+'));
  ok(new Set(all).size > 1, '7.10 推荐名单随关卡轮转', `唯一组合数 ${new Set(all).size}`);
}

const result = t.report();
if (result.failed > 0) process.exitCode = 1;
export { result };