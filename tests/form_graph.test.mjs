/**
 * `validateFormGraphData()` 的硬校验测试。
 *
 * 【本测试的核心思路】
 *   **不是**验证"当前配置是对的" —— 那种测试在校验逻辑写错时也会通过。
 *   而是**故意喂畸形数据，确认校验器每一条都抓得住**。
 *   所以每条用例都遵循同一个结构：
 *     ① 造一份最小的坏配置→ ② 断言校验器报出对应错误
 *     ③ 再断言"只报这一条"（避免一条坏数据触发全屏误报，掩盖真正的问题）
 *
 * 【为什么需要纯函数版】
 *   原实现直接读模块级FORM_MAP，测试无法注入坏配置。
 *   已重构为 `validateFormGraphData(forms, recipes, weaponRoots, auxRoots)`，
 *   生产入口 `validateFormGraph()` 行为不变。
 */

import {
  validateFormGraph, validateFormGraphData,
  ALL_FORMS, FUSION_RECIPES, WEAPON_ROOT_IDS,
} from '../.test-build/FormConfig.js';
import { AUX_ROOT_IDS } from '../.test-build/AuxConfig.js';
import { createSuite } from './assert.mjs';

const t = createSuite('validateFormGraph 硬校验测试');
const { section, ok, eq, expectError, expectClean, expectCount } = t;

// ------------------------------------------------------------------
// 工厂：造最小可用 / 刻意损坏 的配置
// ------------------------------------------------------------------

/** 造一个最小的合法武器形态 */
function w(id, over = {}) {
  return {
    id,
    name: id,
    kind: 'weapon',
    equipType: 'blade',
  sources: [id],
    depth: 0,
    atkPct: 0,
    rangePct: 0,
    attackModeId: 1,
    aimModeId: 0,
    attackModeText: '近战单体',
    evolveTo: [],
    desc: '',
    ...over,
  };
}

/** 造一个最小的合法辅助形态 */
function a(id, over = {}) {
  return {
    id,
    name: id,
    kind: 'aux',
    equipType: 'aux',
    sources: [id],
    depth: 0,
    atkPct: 0,
    rangePct: 0,
    attackModeId: 0,
    aimModeId: 0,
    attackModeText: '挂件射击',
    evolveTo: [],
    desc: '',
    ...over,
  };
}

/** 一份"什么都没错"的最小基线，用来验证校验器不误报 */
function baseline() {
  return {
  forms: [
      w('blade'),
w('blade_b'),
    ],
    recipes: [],
    weaponRoots: ['blade'],
    auxRoots: [],
  };
}

/** 跑校验（补齐 auxRoots 默认值） */
function run(cfg) {
  return validateFormGraphData(
    cfg.forms, cfg.recipes ?? [], cfg.weaponRoots ?? [], cfg.auxRoots ?? []);
}

// ==================================================================
// 第 0 组：基线 —— 合法配置必须零错误
// ==================================================================
section('0 · 基线');

{
  const cfg = baseline();
  expectClean(run(cfg), '最小合法配置无错误');
}

// ==================================================================
// 第 1 组：形态节点自身（3 条）
// ==================================================================
section('1 · 形态节点');

{
  // 1.1武器形态必须有 sources —— 否则基础伤害算不出来
  const cfg = baseline();
  cfg.forms[0].sources = [];
  expectError(run(cfg), '武器形态缺少 sources', '1.1 武器 sources 为空 → 报错');
}

{
  // 1.2 kind=weapon 但 equipType 写成 aux —— 会让基础伤害查到错误的表
  const cfg = baseline();
  cfg.forms[0].equipType = 'aux';
  expectError(run(cfg), '武器形态的 equipType 不能是 aux', '1.2 武器 equipType=aux → 报错');
}

{
  // 1.3 kind=aux 但 equipType 不是 aux —— 辅助会走进武器的伤害计算
  const cfg = baseline();
  cfg.forms = [a('aux_a')];
  cfg.weaponRoots = [];
  cfg.auxRoots = ['aux_a'];
  cfg.forms[0].equipType = 'blade';
  expectError(run(cfg), '辅助形态的 equipType 必须是 aux', '1.3 辅助 equipType=blade → 报错');
}

// ==================================================================
// 第 2 组：进化边的合法性（3 条）
// ==================================================================
section('2 · 进化边');

{
  // 2.1 边指向不存在的形态 —— 点开图鉴会是个问号
  const cfg = baseline();
  cfg.forms[0].evolveTo = [{ to: 'no_such', type: 'upgrade', label: '', desc: '' }];
expectError(run(cfg), '进化边指向不存在的形态', '2.1 边指向不存在的 id → 报错');
}

{
  // 2.2 边跨越了槽位种类 —— 武器进化成辅助会吃掉一整个槽位语义
  const cfg = baseline();
  cfg.forms = [w('blade'), a('aux_a')];
  cfg.weaponRoots = ['blade'];
  cfg.auxRoots = ['aux_a'];
  cfg.forms[0].evolveTo = [{ to: 'aux_a', type: 'upgrade', label: '', desc: '' }];
  expectError(run(cfg), '进化边跨越了槽位种类', '2.2 武器边指向辅助 → 报错');
}

// ==================================================================
// 第 3 组：层级规则（3 条）
// ==================================================================
section('3 · 层级规则');

{
  // 3.1 upgrade 必须严格加深
  const cfg = baseline();
  cfg.forms = [
    w('blade'),
    w('blade_b', { depth: 0, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'upgrade', label: '', desc: '' }];
  expectError(run(cfg), '进化边没有加深层级', '3.1 upgrade 同层 → 报错');
}

{
  // 3.2 fusion {
  // 3.2 fusion 允许同层 —— 合并伤害 vs 极端单项是同层级的两种收束，
  //   真正更高的第 4 层才留给"复玩限定"。所以同层**不该**报错。
  const cfg = baseline();
  cfg.forms = [
    w('blade'),
    w('bow', { equipType: 'bow' }),
    w('fus_x', { depth: 0, sources: ['blade', 'bow'], atkPct: 5 }),
  ];
  cfg.weaponRoots = ['blade', 'bow'];
  cfg.forms[0].evolveTo = [{ to: 'fus_x', type: 'fusion', need: 'bow', label: '', desc: '' }];
  const errs = run(cfg).filter((e) => e.includes('层级低于材料'));
  expectClean(errs, '3.2 fusion 同层合法 → 不报"层级低于材料"');
}

{
  // 3.3 fusion 产物层级**低于**材料 → 必须报错
  //   这是「进化边层级检查」里的 fusion 分支，与配方层的 7.7 是两处独立校验：
  //   7.7 看FUSION_RECIPES 声明，3.3 看 evolveTo 边上挂的边。删掉任一处测试都要变红。
  const cfg = baseline();
  cfg.forms = [
    w('blade', { depth: 2 }),
    w('fus_x', { depth: 1, sources: ['blade'], atkPct: 5 }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'fus_x', type: 'fusion', need: 'blade', label: '', desc: '' }];
  expectError(run(cfg), '合成产物的层级低于材料', '3.3 fusion 边：产物层< 材料层 → 报错');
}

{
  // 3.4 upgrade 边必须严格加深 —— depth 相同也不行
  const cfg = baseline();
  cfg.forms = [
    w('blade', { depth: 1 }),
    w('blade_b', { depth: 1, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'upgrade', label: '', desc: '' }];
  expectError(run(cfg), '进化边没有加深层级', '3.4 upgrade 同层 → 报错');
}

{
  // 3.5 upgrade 边反向（往浅了走）→ 报错
  const cfg = baseline();
  cfg.forms = [
    w('blade', { depth: 3 }),
    w('blade_b', { depth: 1, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'upgrade', label: '', desc: '' }];
  expectError(run(cfg), '进化边没有加深层级', '3.5 upgrade 层数倒退 → 报错');
}

{
  // 3.6 upgrade 正常加深 → 通过
  const cfg = baseline();
  cfg.forms = [
    w('blade', { depth: 1 }),
    w('blade_b', { depth: 2, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'upgrade', label: '', desc: '' }];
  const errs = run(cfg).filter((e) => e.includes('层级'));
  expectClean(errs, '3.6 upgrade 正常加深 1→2 → 通过');
}

// ==================================================================
// 第 4 组：合成边的完整性（3 条）
// ==================================================================
section('4 · 合成边');

{
  // 4.1 fusion 边必须有 need（否则不知道要几件材料）
  const cfg = baseline();
  cfg.forms = [
  w('blade'),
    w('blade_b', { depth: 1, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'fusion', label: '', desc: '' }];
  expectError(run(cfg), '合成边缺少 need', '4.1 fusion 边无 need → 报错');
}

{
  // 4.2 need 指向的形态必须存在
  const cfg = baseline();
  cfg.forms = [
    w('blade'),
    w('blade_b', { depth: 1, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'fusion', need: 'ghost_mat', label: '', desc: '' }];
  expectError(run(cfg), '合成边材料不存在', '4.2 need 指向不存在 → 报错');
}

{
  // 4.3 辅助不允许 fusion（会消耗槽位，玩家养的东西会消失）
  const cfg = baseline();
  cfg.forms = [a('aux_a'), a('aux_b', { depth: 1, sources: ['aux_a'] })];
  cfg.weaponRoots = [];
  cfg.auxRoots = ['aux_a'];
  cfg.forms[0].evolveTo = [{ to: 'aux_b', type: 'fusion', need: 'aux_a', label: '', desc: '' }];
  const errs = run(cfg);
  ok(errs.some((e) => e.includes('辅助装备不允许合成进化')), '4.3 辅助的 fusion 边 → 报错');
}

// ==================================================================
// 第 5 组：辅助铁律（1 条）
// ==================================================================
section('5 · 辅助铁律');

{
  // 5.1 辅助的任何边都必须是 upgrade
  const cfg = baseline();
  cfg.forms = [a('aux_a'), a('aux_b', { depth: 1, sources: ['aux_a'] })];
  cfg.weaponRoots = [];
  cfg.auxRoots = ['aux_a'];
  // kind 一致、depth 加深，但 type 不是 upgrade
  cfg.forms[0].evolveTo = [{ to: 'aux_b', type: 'advanced', label: '', desc: '' }];
  expectError(run(cfg), '辅助装备只能走 upgrade 进化', '5.1 辅助非 upgrade 边 → 报错');
}

// ==================================================================
// 第 6 组：advanced 边（1 条）
// ==================================================================
section('6 · advanced 边');

{
  // 6.1 advanced 只允许出现在 depth >= 2
  //depth 0 的形态带 advanced 会让"复玩限定"过早暴露
  const cfg = baseline();
  cfg.forms = [
    w('blade'),
    w('blade_b', { depth: 1, sources: ['blade'] }),
  ];
  cfg.forms[0].evolveTo = [{ to: 'blade_b', type: 'upgrade', label: '', desc: '', advanced: true }];
  expectError(run(cfg), '高级进化不应该出现在 depth < 2', '6.1 depth0 带 advanced → 报错');
}

// ==================================================================
// 第 7 组：合成配方（7 条）
// ==================================================================
section('7 · 合成配方');

/** 一份合法的最小配方数据 */
function goodRecipeCfg(overRecipe = {}, overProduct = {}) {
  return {
    forms: [
    w('blade'),
      w('bow', { equipType: 'bow' }),
      w('fus_x', { depth: 3, sources: ['blade', 'bow'], atkPct: 5, ...overProduct }),
    ],
    recipes: [{ a: 'blade', b: 'bow', to: 'fus_x', label: '', desc: '', ...overRecipe }],
    weaponRoots: ['blade', 'bow'],
    auxRoots: [],
  };
}

{
  // 7.0 正向：合法配方零错误
  expectClean(run(goodRecipeCfg()), '7.0 合法配方无错误');
}

{
  // 7.1 材料 A 不存在
  const cfg = goodRecipeCfg({ a: 'nope_a' });
  expectError(run(cfg), '合成配方材料 A 不存在', '7.1 材料 A 不存在 → 报错');
}

{
  // 7.2 材料 B 不存在
  const cfg = goodRecipeCfg({ b: 'nope_b' });
  expectError(run(cfg), '合成配方材料 B 不存在', '7.2 材料 B 不存在 → 报错');
}

{
  // 7.3 产物不存在
  const cfg = goodRecipeCfg({ to: 'nope_to' });
  expectError(run(cfg), '合成产物不存在', '7.3 产物不存在 → 报错');
}

{
  // 7.4 产物必须是武器
  const cfg = goodRecipeCfg();
  cfg.forms[2].kind = 'aux';
  cfg.forms[2].equipType = 'aux';
  expectError(run(cfg), '合成产物必须是武器', '7.4 产物是辅助 → 报错');
}

{
  // 7.5 两件材料重复（拿自己合自己）
  const cfg = goodRecipeCfg({ b: 'blade' });
  expectError(run(cfg), '合成配方两件材料重复', '7.5 a===b → 报错');
}

{
  // 7.6 产物必须继承 sources（否则基础伤害为 0）
  const cfg = goodRecipeCfg({}, { sources: [] });
  expectError(run(cfg), '合成产物没有继承基础伤害', '7.6 产物 sources 为空 → 报错');
}

{
  // 7.7 产物层级低于材料 —— "合完反而倒退"
  const cfg = goodRecipeCfg();
  cfg.forms[1].depth = 3;
  cfg.forms[2].depth = 1;
  expectError(run(cfg), '合成产物层级低于材料', '7.7 产物层级 < max(材料) → 报错');
}

{
  // 7.8 产物 atkPct 必须严格高于材料 —— "合完反而更弱"
  //这是玩家最不能接受的一种退化：白赚一格却更弱
  const cfg = goodRecipeCfg();
  cfg.forms[0].atkPct = 3;
  cfg.forms[1].atkPct = 3;
  cfg.forms[2].atkPct = 3;         // 不高于 max(3,3)
  expectError(run(cfg), '攻击加成不高于材料', '7.8 产物 atkPct ≤ max(材料) → 报错');
}

{
  // 7.9 恰好比材料高一点点就该通过（边界）
  const cfg = goodRecipeCfg({}, { atkPct: 3.01 });
  const errs = run(cfg).filter((e) => e.includes('攻击加成'));
  expectClean(errs, '7.9 产物 atkPct=3.01 > 材料 3 → 通过');
}

{
  // 7.10 产物层级高于材料 → 通过（正常情况）
  const cfg = goodRecipeCfg();
  cfg.forms[0].depth = 2;
  cfg.forms[1].depth = 2;
  cfg.forms[2].depth = 3;
  const errs = run(cfg).filter((e) => e.includes('层级低于材料'));
  expectClean(errs, '7.10 产物层级 3 > max(材料 2) → 通过');
}

{
  // 7.11 配方产物与边层校验是两处独立断言 ——
  // 配方层（7.7）过了不代表边层（3.3）也过，反之亦然。
  // 这里把边的 need 指向自己，触发"材料不存在"，配方声明本身合法。
  const cfg = goodRecipeCfg();
  cfg.forms[0].evolveTo.push({
    to: 'fus_x', type: 'fusion', need: 'no_such_mat', label: '', desc: '',
  });
  expectError(run(cfg), '合成边材料不存在', '7.11 边的 need 指向不存在 → 报错');
}

{
  // 7.12 同一份材料既做合法配方又做非法配方时，两处错误都要报出来
  const cfg = goodRecipeCfg();
  cfg.recipes.push({ a: 'blade', b: 'bow', to: 'no_target', label: '', desc: '' });
  const errs = run(cfg);
  ok(errs.some((e) => e.includes('合成产物不存在')),
    '7.12 非法配方与合法配方共存时，错误仍被报出');
}

// ==================================================================
// 第 8 组：根形态（3 条）
// ==================================================================
section('8 · 根形态');

{
  // 8.1 武器根形态缺失
  const cfg = baseline();
  cfg.weaponRoots = ['blade', 'ghost_blade'];
  expectError(run(cfg), '武器根形态缺失', '8.1 根形态 id 不存在 → 报错');
}

{
  // 8.2 根形态 depth 必须是 0
  const cfg = baseline();
  cfg.forms[0].depth = 2;
  expectError(run(cfg), '武器根形态 depth 必须为 0', '8.2 根形态 depth=2 → 报错');
}

{
  // 8.3 辅助根形态缺失
  const cfg = baseline();
  cfg.weaponRoots = ['blade'];
  cfg.auxRoots = ['aux_a', 'aux_ghost'];
  expectError(run(cfg), '辅助根形态缺失', '8.3 辅助根缺失 → 报错');
}

// ==================================================================
// 第 9 组：真实配置必须通过（回归保护）
// ==================================================================
section('9 · 真实配置回归');

{
  // 这是最重要的一条：任何测试环境下，真实配置都必须零错误。
// 它同时保护"校验器重构没有改变生产行为"——
  // 因为 validateFormGraph() 只是薄薄一层包装。
  const errs = validateFormGraph();
  expectClean(errs, '9.1 真实配置通过校验');
  eq(errs, [], '9.2 validateFormGraph 返回空数组');
}

{
  // 纯函数版与包装版必须给出完全一致的结论
  const direct = validateFormGraphData(ALL_FORMS, FUSION_RECIPES, WEAPON_ROOT_IDS, AUX_ROOT_IDS);
  eq(direct, validateFormGraph(), '9.3 纯函数版与包装版结论一致');
}

{
  // 规模快照 —— 加武器/加形态时数量变了会立刻发现
  eq(ALL_FORMS.length, 150, '9.4 形态节点总数 150');
  eq(WEAPON_ROOT_IDS.length, 18, '9.5 武器线 18 条');
  eq(AUX_ROOT_IDS.length, 14, '9.6 辅助线 14 条');
  eq(FUSION_RECIPES.length, 8, '9.7 合成配方 8 条');
}

{
  // 结构性不变量
  const weaponForms = ALL_FORMS.filter((f) => f.kind === 'weapon');
  const auxForms = ALL_FORMS.filter((f) => f.kind === 'aux');
eq(weaponForms.length, 104, '9.8 武器形态节点 104');
  eq(auxForms.length, 46, '9.9 辅助形态节点 46');

  ok(auxForms.every((f) => f.evolveTo.every((e) => e.type === 'upgrade')),
    '9.10 辅助装备全部只走 upgrade（不消耗槽位的铁律）');

  ok(ALL_FORMS.every((f) => f.kind !== 'weapon' || f.sources.length > 0),
    '9.11 每个武器形态都有 sources（基础伤害可算）');

  const depth4 = weaponForms.filter((f) => f.depth === 4);
  eq(depth4.length, 8, '9.12 depth 4（复玩限定）8 个节点');
}

// ==================================================================
// 第 10 组：校验器自身的健壮性
// ==================================================================
section('10 · 校验器健壮性');

{
  // 空输入不能崩
  const errs = validateFormGraphData([], [], [], []);
  expectClean(errs, '10.1 空输入不崩且无错误');
}

{
  // 一条畸形数据应只报一条，不应误报全屏
  const cfg = baseline();
  cfg.forms[0].sources = [];
  expectCount(run(cfg), 1, '10.2 单点畸形只报 1 条（不产生误报风暴）');
}

{
  // 不修改传入的数据（纯函数）—— 否则测试之间会互相污染
  const cfg = baseline();
  const before = JSON.stringify(cfg.forms);
  run(cfg);
  eq(JSON.stringify(cfg.forms), before, '10.3 校验不修改传入的数据');
}

{
  // 多条错误应被全部报出（不能只报第一条就return）
  const cfg = baseline();
  cfg.forms[0].sources = [];
  cfg.forms[0].equipType = 'aux';
cfg.weaponRoots = ['blade', 'missing_root'];
  const errs = run(cfg);
  ok(errs.length >= 3, '10.4 多处错误会被全部报出', `实际 ${errs.length} 条`);
}

/** 交给 tests/run.mjs 汇总；单独 `node tests/form_graph.test.mjs` 也能跑 */
export const result = t.report();