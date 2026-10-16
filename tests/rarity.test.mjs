/**
 * `validateRarityTableData()` 的硬校验测试。
 *
 * 与形态图测试同思路：**喂坏数据**，
 * 而不是只验"当前品阶表是对的"（那样校验逻辑写错了测试也会绿）。
 */

import {
  validateRarityTable, validateRarityTableData,
  RARITY_TABLE, RARITY_COUNT, GACHA_MAX_RARITY,
  rarityPowerMul, raritySockets, rarityAffixCount,
  ascendCopiesOf, ascendGoldOf, ascendNeedsCore,
  normalizeRarity, isMaxRarity, rarityHasInnate,
} from '../.test-build/RarityConfig.js';
import { createSuite } from './assert.mjs';

const t = createSuite('validateRarityTable 硬校验测试');
const { section, ok, eq, expectError, expectClean, expectCount } = t;

// ------------------------------------------------------------------
// 工厂：造一份合法的 7 阶品阶表
// ------------------------------------------------------------------
function goodTable(overrides = {}) {
  const names = ['bronze', 'silver', 'gold', 'diamond', 'epic', 'myth', 'legend'];
  return names.map((id, i) => ({
    tier: i,
    id,
    name: id,
    color: [0, 0, 0],
    powerMul: 1 + i * 0.5,
    sockets: Math.min(4, 1 + Math.floor(i / 2)),
    ascendCopies: i === 6 ? 0 : 1,
    ascendGold: i === 6 ? 0 : 400 * (i + 1),
    innate: i >= 3,
    desc: '',
    ...overrides,
  }));
}

/** 跑校验（可覆盖 gachaMax 以测边界） */
function run(table, count = 7, gachaMax = 5) {
  return validateRarityTableData(table, count, gachaMax);
}

// ==================================================================
section('0 · 基线');

{
  expectClean(run(goodTable()), '0.1 合法品阶表无错误');
  expectClean(validateRarityTable(), '0.2 真实品阶表无错误');
}

// ==================================================================
section('1 · 表结构');

{
  // 1.1 长度必须等于声明的品阶数
  const bad = goodTable().slice(0, 5);
  expectError(run(bad, 7, 5), '品阶表长度应为', '1.1 长度不足 → 报错');
}

{
  // 1.2 索引必须连续（tier === i），否则查表会错位
  const bad = goodTable();
  bad[3].tier = 9;
  expectError(run(bad), '品阶表索引不连续', '1.2 tier 与索引不符 → 报错');
}

{
  // 1.3 倍率必须为正
  const bad = goodTable();
  bad[2].powerMul = 0;
  expectError(run(bad), '品阶倍率必须为正', '1.3 倍率为 0 → 报错');
}

{
  // 1.4 槽位不能为负
  const bad = goodTable();
  bad[1].sockets = -1;
  expectError(run(bad), '镶嵌槽位不能为负', '1.4 槽位为负 → 报错');
}

// ==================================================================
section('2 · 单调性');

{
  // 2.1 倍率必须严格递增 —— 否则"升阶变强"这件事不成立
  const bad = goodTable();
  bad[2].powerMul = bad[1].powerMul;// 相等
  expectError(run(bad), '品阶倍率必须严格递增', '2.1 倍率相等 → 报错');
}

{
  // 2.2 倍率倒退（比前一阶还低）
  const bad = goodTable();
  bad[3].powerMul = bad[1].powerMul - 0.1;
  expectError(run(bad), '品阶倍率必须严格递增', '2.2 倍率倒退 → 报错');
}

{
  // 2.3 槽位不允许回退 —— 否则升阶会镶不上原来的石头
  const bad = goodTable();
  bad[3].sockets = bad[2].sockets - 1;
  expectError(run(bad), '镶嵌槽位不允许减少', '2.3 槽位回退 → 报错');
}

{
  // 2.4 槽位相等是允许的（白银和黄金都是 1 槽）
  const tbl = goodTable();
  tbl[2].sockets = tbl[1].sockets;
  const errs = run(tbl).filter((e) => e.includes('镶嵌槽位'));
  expectClean(errs, '2.4 槽位相等 → 允许');
}

{
  // 2.5 倍率严格递增 + 槽位不减 → 通过
  const tbl = goodTable();
  const errs = run(tbl).filter((e) => e.includes('递增') || e.includes('减少'));
  expectClean(errs, '2.5 合法递增 → 通过');
}

// ==================================================================
section('3 · 自带属性门槛');

{
  // 3.1 低于钻石（tier < 3）不该有 innate
  const bad = goodTable();
  bad[1].innate = true;
  expectError(run(bad), '低于钻石不该有自带属性', '3.1 白银带 innate → 报错');
}

{
  // 3.2 钻石及以上可以带 innate
  const tbl = goodTable();
  tbl[3].innate = true;
  const errs = run(tbl).filter((e) => e.includes('自带属性'));
  expectClean(errs, '3.2 钻石带 innate → 允许');
}

// ==================================================================
section('4 · 抽奖上限');

{
  // 4.1 抽奖上限不能是最高品阶 —— 传说必须留作进化目标
  expectError(run(goodTable(), 7, 6), '抽奖上限不能是最高品阶', '4.1 抽奖上限=传说 → 报错');
}

{
  // 4.2 抽奖上限可以等于次高（神话）
  const errs = run(goodTable(), 7, 5).filter((e) => e.includes('抽奖上限'));
  expectClean(errs, '4.2 抽奖上限=神话 → 允许');
}

// ==================================================================
section('5 · 校验器健壮性');

{
  // 5.1 空表不崩
  const errs = validateRarityTableData([], 7, 5);
  ok(Array.isArray(errs), '5.1 空表返回数组不崩');
  ok(errs.length > 0, '5.2 空表应报长度错误');
}

{
  // 5.3 单点畸形应该只报**与它直接相关**的错误，不产生误报风暴。
  // 用「索引错位」这个单点畸形：只应命中「索引不连续」这一条。
  const bad = goodTable();
  bad[3].tier = 9;
  expectCount(run(bad), 1, '5.3 单点畸形只报 1 条（索引错位）');
}

{
  // 5.3b 但「倍率=0」这种畸形**理应**命中两条独立校验
  //（自身非正 + 与前一阶的递增关系）—— 这是正确行为，不是误报。
  // 写这条是为了防止后人把"多报"当成 bug 去"修"。
  const bad = goodTable();
  bad[2].powerMul = 0;
  const errs = run(bad);
  ok(errs.some((e) => e.includes('倍率必须为正')), '5.4 倍率为 0 → 报「非正」');
  ok(errs.some((e) => e.includes('严格递增')), '5.5 倍率为 0 → 也报「递增断裂」');
}

{
  // 5.4 不修改传入的表（纯函数）
  const tbl = goodTable();
  const before = JSON.stringify(tbl);
  validateRarityTableData(tbl, 7, 5);
  eq(JSON.stringify(tbl), before, '5.4 校验不修改入参');
}

// ==================================================================
section('6 · 查询接口');

{
  // 越界必须收敛，不能返回 undefined
  eq(normalizeRarity(-5), 0, '6.1 rarity=-5 → 0');
  eq(normalizeRarity(99), 6, '6.2 rarity=99 → 6');
  eq(normalizeRarity(NaN), 0, '6.3 NaN → 0');
  eq(normalizeRarity(3.7), 3, '6.4 小数向下取整');
}

{
  // 满阶后升阶信息应返回 -1（而不是抛错或给 0）
  eq(ascendCopiesOf(6), -1, '6.5 传说升阶件数 -1');
  eq(ascendGoldOf(6), -1, '6.6 传说升阶金币 -1');
  eq(ascendCopiesOf(0), 1, '6.7 青铜升阶 1 件');
}

{
  // 只有神话→传说需要专属材料
  eq(ascendNeedsCore(5), true, '6.8 神话需要神话之核');
  eq(ascendNeedsCore(4), false, '6.9 史诗不需要');
  eq(ascendNeedsCore(0), false, '6.10 青铜不需要');
}

{
  eq(isMaxRarity(6), true, '6.11 传说是最高阶');
  eq(isMaxRarity(5), false, '6.12 神话不是最高阶');
  eq(rarityHasInnate(2), false, '6.13 黄金无自带属性');
  eq(rarityHasInnate(3), true, '6.14 钻石有自带属性');
}

// ==================================================================
section('7 · 真实表回归');

{
  expectClean(validateRarityTable(), '7.1 真实品阶表通过');
  eq(RARITY_TABLE.length, RARITY_COUNT, '7.2 品阶数 7');
  eq(RARITY_COUNT, 7, '7.3 RARITY_COUNT=7');
  eq(GACHA_MAX_RARITY, 5, '7.4 抽奖上限=神话');
  eq(rarityPowerMul(0), 1.0, '7.5 青铜倍率 1.00');
  eq(rarityPowerMul(6), 3.3, '7.6 传说倍率 3.30');
  eq(raritySockets(0), 1, '7.7 青铜 1 槽');
  eq(raritySockets(6), 4, '7.8 传说 4 槽');
  eq(rarityAffixCount(0), 1, '7.9 青铜大套词条 1');
  eq(rarityAffixCount(6), 7, '7.10 传说大套词条 7');
}

{
  // 倍率必须严格递增（真实表的硬要求，直接断言一次）
  for (let i = 1; i < RARITY_TABLE.length; i++) {
    ok(RARITY_TABLE[i].powerMul > RARITY_TABLE[i - 1].powerMul,
      `7.11 倍率递增 ${i - 1}→${i}`);
  }
}

{
  // 槽位不减
  for (let i = 1; i < RARITY_TABLE.length; i++) {
    ok(RARITY_TABLE[i].sockets >= RARITY_TABLE[i - 1].sockets,
      `7.12 槽位不减 ${i - 1}→${i}`);
  }
}

{
  // 成品阶名（UI 与日志会用到）
  eq(RARITY_TABLE.map((r) => r.name),
    ['青铜', '白银', '黄金', '钻石', '史诗', '神话', '传说'],
    '7.13 品阶名顺序');
}

const result = t.report();
// ⚠️ 必须设置 exitCode：否则 CI 里即使有断言失败，命令也会返回 0，
// 变异测试之类的外部检查会误判为"测试通过"。这个坑踩过一次。
if (result.failed > 0) process.exitCode = 1;
export { result };