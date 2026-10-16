/**
 * 24 属性编排的测试。
 *
 * 覆盖两个层面：
 *   A. 表自身的一致性（`validateElementGroups`）—— 2026-10-16 新增，
 *      此前这四条不变式**完全没有代码在守**
 *   B. 关卡编排的四条玩家可感知不变式（`validateElementInvariants`）
 *
 * 【为什么属性编排特别需要测试】
 *   历史文档说 `forge_e2e.js` 里有"四条不变式"的断言，但那个文件不存在。
 *   而这份编排是**纯数据驱动**的：`LEVELS_PER_GROUP` 从 4 改成 3，
 *   或者某个组的元素个数写错，都不会有任何运行时报错，
 *   只会让关卡主题悄悄变得不合理 —— 典型的"改坏了但没人发现"。
 */

import {
  validateElementGroups, validateElementInvariants,
  ELEMENT_IDS, ELEMENT_GROUPS,
  elementCountForLevel, elementsForLevel, elementGroupOfLevel,
  countersOf, resistedBy, pairMul, isSelfCounter, isMutualCounter,
  COUNTER_MUL, COUNTERED_MUL, ELEMENT_MUL_MAX,
  counterBreakOf, COUNTER_BREAK_MAX,
  BREAK_PER_LEVEL, BREAK_PER_RANK, BREAK_PER_SOCKET,
} from '../.test-build/data/ElementConfig.js';
import { createSuite } from './assert.mjs';

const t = createSuite('24 属性编排测试');
const { section, ok, eq, expectError, expectClean } = t;

const PER_GROUP = 4;

// ==================================================================
section('1 · 属性表规模');

{
  eq(ELEMENT_IDS.length, 24, '1.1 属性总数 24');
  eq(new Set(ELEMENT_IDS).size, 24, '1.2 属性 id 无重复');
  eq(ELEMENT_GROUPS.length, 6, '1.3 属性组 6 个');
}

{
  // 每组恰好 4 种，且覆盖全部 24 种
  for (const g of ELEMENT_GROUPS) {
    eq(g.els.length, PER_GROUP, `1.4 属性组「${g.name}」恰好 4 种`);
  }
  const flat = ELEMENT_GROUPS.flatMap((g) => g.els);
  eq(flat.length, 24, '1.5 六组合计 24 种');
  eq(new Set(flat).size, 24, '1.6 六组无交叉');
  ok(ELEMENT_IDS.every((id) => flat.includes(id)), '1.7 每种属性都在某组里');
}

// ==================================================================
section('2 · 表自洽校验器（喂坏数据）');

{
  // 2.1 基线：真实配置必须通过
  expectClean(validateElementGroups(ELEMENT_GROUPS, ELEMENT_IDS, PER_GROUP, elementCountForLevel),
    '2.1 真实属性表通过校验');
}

{
  // 2.2 组内数量不对 → 报错
  const bad = ELEMENT_GROUPS.map((g, i) => (i === 0 ? { ...g, els: g.els.slice(0, 3) } : g));
  expectError(validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel),
    '应为 4 种', '2.2 组内只有 3 种 → 报错');
}

{
  // 2.3 组内有重复 → 报错
  const bad = ELEMENT_GROUPS.map((g, i) =>
    (i === 0 ? { ...g, els: [g.els[0], g.els[0], g.els[1], g.els[2]] } : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(errs.some((e) => e.includes('内部有重复')), '2.3 组内重复 → 报错');
}

{
  // 2.4 组间交叉 → 报错
  const bad = ELEMENT_GROUPS.map((g, i) =>
    (i === 1 ? { ...g, els: [g.els[0], g.els[1], g.els[2], ELEMENT_GROUPS[0].els[0]] } : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(errs.some((e) => e.includes('重复出现') || e.includes('未出现在任何组')),
    '2.4 组间交叉 → 报错');
}

{
  // 2.5 漏掉某属性 → 报错
  const bad = ELEMENT_GROUPS.map((g, i) => (i === 5 ? { ...g, els: g.els.slice(0, 3) } : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(errs.some((e) => e.includes('未出现在任何组')), '2.5 有属性没被任何组覆盖 → 报错');
}

{
  // 2.6 组里出现未知属性 → 报错
  const bad = ELEMENT_GROUPS.map((g, i) =>
    (i === 0 ? { ...g, els: [g.els[0], g.els[1], g.els[2], 'nonexistent'] } : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(errs.some((e) => e.includes('未知属性')), '2.6 组里有未知属性 → 报错');
}

{
  // 2.7 组间交叉：把 A 组的元素塞进 B 组。
  //     这一处会同时触发两条独立校验，所以**两条都必须断言**——
  //     只断言"报了任意一条"的话，把其中一条删掉测试仍然会绿
  //     （这个漏网是变异测试抓出来的）。
  const g2 = { ...ELEMENT_GROUPS[1], els: [
ELEMENT_GROUPS[1].els[0], ELEMENT_GROUPS[1].els[1],
    ELEMENT_GROUPS[1].els[2], ELEMENT_GROUPS[0].els[0]] };
  const bad = ELEMENT_GROUPS.map((g, i) => (i === 1 ? g2 : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(errs.some((e) => e.includes('属性在各组间重复出现')),
    '2.7 组间交叉 → 报「重复出现」');
  ok(errs.some((e) => e.includes('属性未出现在任何组里')),
    '2.8 组间交叉 → 同时报「未覆盖」（被挤掉的那两种）');
}

{
  // 2.9 组里只有 3 种，但该组覆盖的关卡要 4 种 → 必须报错
  //     这是最危险的一类：玩家点进第 13 关，UI 说"四属性"，
  //     实际只拿到 3 种，而且不会有任何运行时异常。
  //
  //     注意必须挑**要 4 种属性的那三组**（造物/灵异/法则，即第 13 关起）——
  //     前三组覆盖的关卡最多只要 3 种，给它们减种数不会触发这条。
  const g3 = { ...ELEMENT_GROUPS[3], els: ELEMENT_GROUPS[3].els.slice(0, 3) };
  const bad = ELEMENT_GROUPS.map((g, i) => (i === 3 ? g3 : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(errs.some((e) => e.includes('但所在组只有')),
    '2.9 四属性关的组只有 3 种 → 报错');
}

{
  // 2.9b 反向确认：给**单属性组**减种数不会触发这条
  //（前三组覆盖的关卡最多要 2~3 种，2 种够用）
  const g0 = { ...ELEMENT_GROUPS[0], els: ELEMENT_GROUPS[0].els.slice(0, 2) };
  const bad = ELEMENT_GROUPS.map((g, i) => (i === 0 ? g0 : g));
  const errs = validateElementGroups(bad, ELEMENT_IDS, PER_GROUP, elementCountForLevel);
  ok(!errs.some((e) => e.includes('但所在组只有')),
    '2.9b 单属性组减到 2 种 → 不触发「不够」');
}

{
  // 2.10 组内属性种类发生变化 → 破坏「相邻两关共享」不变式
  //     构造：让第 1~4 关（同一组）里第 2 关突然要 2 种属性。
  const weirdCount = (lv) => (lv === 2 ? 2 : (lv <= 4 ? 1 : elementCountForLevel(lv)));
  const errs = validateElementGroups(ELEMENT_GROUPS, ELEMENT_IDS, PER_GROUP, weirdCount);
  ok(errs.some((e) => e.includes('组内属性种类发生变化')),
    '2.10 组内种类变化 → 报错');
}

// ==================================================================
section('3 · 组周期与种类边界');

{
  // 3.1 种类边界：1~4 关 1 种、5~8 关 2 种、9~12 关 3 种、13+ 关 4 种
  for (let lv = 1; lv <= 4; lv++) eq(elementCountForLevel(lv), 1, `3.1 lv${lv} 1 种`);
  for (let lv = 5; lv <= 8; lv++) eq(elementCountForLevel(lv), 2, `3.2 lv${lv} 2 种`);
  for (let lv = 9; lv <= 12; lv++) eq(elementCountForLevel(lv), 3, `3.3 lv${lv} 3 种`);
  for (let lv = 13; lv <= 24; lv++) eq(elementCountForLevel(lv), 4, `3.4 lv${lv} 4 种`);
}

{
  // 3.2 越界收敛
  eq(elementCountForLevel(0), 1, '3.5 lv0 → 1 种');
  eq(elementCountForLevel(-3), 1, '3.6 lv-3 → 1 种');
}

{
  // 3.3 组周期 = 24 关走完一轮回到第一组
  eq(elementGroupOfLevel(1), ELEMENT_GROUPS[0].name, '3.7 lv1 在第 1 组');
  eq(elementGroupOfLevel(4), ELEMENT_GROUPS[0].name, '3.8 lv4 仍在第 1 组');
  eq(elementGroupOfLevel(5), ELEMENT_GROUPS[1].name, '3.9 lv5 进入第 2 组');
  eq(elementGroupOfLevel(24), ELEMENT_GROUPS[5].name, '3.10 lv24 在第 6 组');
  eq(elementGroupOfLevel(25), ELEMENT_GROUPS[0].name, '3.11 lv25 回到第 1 组（24 关一轮）');
}

{
  // 3.4 组内属性种类必须恒定（这是"相邻两关共享 ≥1 种"的前提）
  for (let g = 0; g < ELEMENT_GROUPS.length; g++) {
    const base = g * PER_GROUP;
    const kinds = new Set();
    for (let lv = base + 1; lv <= base + PER_GROUP; lv++) {
      kinds.add(elementCountForLevel(lv));
    }
    eq(kinds.size, 1, `3.12 第 ${g + 1} 组内属性种类恒定`);
  }
}

// ==================================================================
section('4 · 四条编排不变式');

{
  expectClean(
    validateElementInvariants(ELEMENT_GROUPS, PER_GROUP, elementsForLevel, elementCountForLevel),
    '4.1 真实编排通过四条不变式');
}

{
  // 不变式 1：同一关内属性互不重复
  let allUnique = true;
  for (let lv = 1; lv <= 24; lv++) {
    const els = elementsForLevel(lv);
    if (new Set(els).size !== els.length) allUnique = false;
  }
  ok(allUnique, '4.2 不变式1：同关内属性互不重复');
}

{
  // 不变式 2：双属性以上，同组内相邻两关必然共享 ≥1 种
  let allShared = true;
  for (let lv = 2; lv <= 24; lv++) {
    const n = elementCountForLevel(lv);
    if (n < 2) continue;
    const sameGroup = Math.floor((lv - 1) / 4) === Math.floor((lv - 2) / 4);
    if (!sameGroup) continue;
    const prev = elementsForLevel(lv - 1);
    const cur = elementsForLevel(lv);
    if (!cur.some((e) => prev.includes(e))) allShared = false;
  }
  ok(allShared, '4.3 不变式2：双属性以上同组相邻关必然共享 ≥1 种');
}

{
  // 不变式 3：单属性关之间不重叠（长度就是 1，本来就不可能）
  let singleNoOverlap = true;
  for (let lv = 2; lv <= 4; lv++) {
    const prev = elementsForLevel(lv - 1);
    const cur = elementsForLevel(lv);
    if (cur.some((e) => prev.includes(e))) singleNoOverlap = false;
  }
  ok(singleNoOverlap, '4.4 不变式3：单属性关之间不重叠');
  eq(elementsForLevel(1).length, 1, '4.5 lv1 确实只有 1 种');
  eq(elementsForLevel(2).length, 1, '4.6 lv2 确实只有 1 种');
}

{
  // 不变式 4：换组的那一关属性完全不同
  let groupSwitch = true;
  for (let g = 1; g < ELEMENT_GROUPS.length; g++) {
    const lv = g * PER_GROUP + 1;
    const prev = elementsForLevel(lv - 1);
    const cur = elementsForLevel(lv);
    if (cur.some((e) => prev.includes(e))) groupSwitch = false;
  }
  ok(groupSwitch, '4.7 不变式4：换组关属性完全不同（主题切换）');
}

{
  // 属性必须全部取自所在组
  let fromGroup = true;
  for (let lv = 1; lv <= 24; lv++) {
    const g = Math.floor((lv - 1) / PER_GROUP) % ELEMENT_GROUPS.length;
    const group = ELEMENT_GROUPS[g];
    if (!elementsForLevel(lv).every((e) => group.els.includes(e))) fromGroup = false;
  }
  ok(fromGroup, '4.8 每关属性全部取自所在组');
}

{
  // 4.9 不变式校验器本身：喂"同关内重复"的元素序列
  const dupElements = (lv) => (lv === 1 ? ['fire', 'fire'] : elementsForLevel(lv));
  const errs = validateElementInvariants(
    ELEMENT_GROUPS, PER_GROUP, dupElements, elementCountForLevel);
  ok(errs.some((e) => e.includes('属性重复')),
    '4.9 喂「同关内重复」→ 不变式校验器报错');
}

{
  // 4.10 不变式校验器：喂"同组相邻两关不共享"
  //     第 2 关改成一个完全不相干的属性，且仍是 1 种
  //     → 会触发「应有 1 种」以外的那条吗？不会，所以改用双属性场景。
  //     构造：把第 6、7 关（自然组，双属性）换成毫无交集的两个属性。
  const noShare = (lv) => {
    if (lv === 6) return ['fire', 'water'];
    if (lv === 7) return ['grass', 'bug'];
    return elementsForLevel(lv);
  };
  const count2 = (lv) => (lv === 6 || lv === 7 ? 2 : elementCountForLevel(lv));
  const errs = validateElementInvariants(ELEMENT_GROUPS, PER_GROUP, noShare, count2);
  ok(errs.some((e) => e.includes('没有任何共享属性')),
    '4.10 喂「同组相邻两关无交集」→ 报错');
}

{
  // 4.11 不变式校验器：喂「换组仍共享」
  //     第 4 关（五行组）实际是 ['metal']，所以第 5 关混进 'metal'
  //     就构成"换了组却仍有共同属性"。
  //     ⚠️ 不能用 'fire' —— fire 本身也是五行组的，那样第 5 关仍属五行组，
  //     测到的会是另一条规则。
  const leak = (lv) => (lv === 5 ? ['grass', 'metal'] : elementsForLevel(lv));
  const count2 = (lv) => (lv === 5 ? 2 : elementCountForLevel(lv));
  const errs = validateElementInvariants(ELEMENT_GROUPS, PER_GROUP, leak, count2);
  ok(errs.some((e) => e.includes('换了组却仍与上一关共享')),
    '4.11 喂「换组仍共享」→ 报错');
}

// ==================================================================
section('5 · 克制表');

{
  // 5.1 表里不能有自指（自指会让"抵抗反推"永远失败）
  let noSelfRef = true;
  for (const id of ELEMENT_IDS) {
    if (countersOf(id).includes(id)) noSelfRef = false;
  }
  ok(noSelfRef, '5.1 COUNTERS 里没有自指');
}

{
  // 5.2 普通系不克任何（洛克设定）
  eq(countersOf('normal'), [], '5.2 普通不克任何');
  ok(countersOf('normal').length === 0, '5.3 普通系克制列表为空');
}

{
  // 5.3 除普通外每种属性都有克制的与被克的
  const noCounter = ELEMENT_IDS.filter((id) => id !== 'normal' && countersOf(id).length === 0);
  const noResisted = ELEMENT_IDS.filter((id) => id !== 'normal' && resistedBy(id).length === 0);
  eq(noCounter, [], '5.4 除普通外每种都克某些属性');
  eq(noResisted, [], '5.5 除普通外每种都被某些属性克');
}

{
  // 5.4 抵抗关系完全由反推得出，两者不可能矛盾
  //    验证方式：对每一对 (x,y)，若 x 克 y 则 y 必须在 resistedBy(x) 里
  let consistent = true;
  for (const x of ELEMENT_IDS) {
    for (const y of countersOf(x)) {
      if (!resistedBy(y).includes(x)) consistent = false;
    }
  }
  ok(consistent, '5.6 抵抗关系与克制表完全自洽');
}

{
  // 5.5 倍率
  eq(COUNTER_MUL, 1.6, '5.7 克制倍率 1.6');
  eq(COUNTERED_MUL, 0.9, '5.8 被克倍率 0.9');
  eq(pairMul('fire', 'grass'), COUNTER_MUL, '5.9 火克草 → 1.6');
  eq(pairMul('grass', 'fire'), COUNTERED_MUL, '5.10 草被火克 → 0.9');
  eq(pairMul('normal', 'normal'), 1, '5.11 普通打普通 → 1');
}

{
  // 5.6 双向克制只算一次（光↔幽），不能叠成 1.6²
  ok(isMutualCounter('light', 'ghost'), '5.12 光↔幽 是双向克制');
  ok(isMutualCounter('space', 'time'), '5.13 空间↔时间 是双向克制');
  eq(pairMul('light', 'ghost'), COUNTER_MUL, '5.14 双向克制只算一次（1.6 而非 2.56）');
}

{
  // 5.7 同属性互克只在 SELF_COUNTER 里
  ok(isSelfCounter('dragon'), '5.15 龙同属性互克');
  ok(isSelfCounter('ghost'), '5.16 幽同属性互克');
  ok(!isSelfCounter('fire'), '5.17 火不同属性互克');
  eq(pairMul('dragon', 'dragon'), COUNTER_MUL, '5.18 龙打龙 → 1.6');
  eq(pairMul('ghost', 'ghost'), COUNTER_MUL, '5.19 幽打幽 → 1.6');
  eq(pairMul('fire', 'fire'), 1, '5.20 火打火 → 1');
}

{
  // 5.8 多属性叠加的封顶
  eq(ELEMENT_MUL_MAX, 2.0, '5.21 多属性封顶 2.0');
}

// ==================================================================
section('6 · 破防');

{
  // 6.1 公式： (lv-1)*0.03 + (rank-1)*0.06 + sockets*0.03 + armor
  eq(counterBreakOf(1, 1, 0, 0), 0, '6.1 新装备破防 0');
  eq(counterBreakOf(5, 1, 0, 0), BREAK_PER_LEVEL * 4, '6.2 满级 → 0.12');
  eq(counterBreakOf(1, 6, 0, 0), BREAK_PER_RANK * 5, '6.3 rank6 → 0.30');
}

{
  // 6.2 单条线无法点满
  const onlyLevel = counterBreakOf(5, 1, 0, 0);
  const onlyRank = counterBreakOf(1, 7, 0, 0);
  const onlySocket = counterBreakOf(1, 1, 4, 0);
  ok(onlyLevel < COUNTER_BREAK_MAX, '6.4 只堆等级点不满');
  ok(onlyRank < COUNTER_BREAK_MAX, '6.5 只堆品阶点不满');
  ok(onlySocket < COUNTER_BREAK_MAX, '6.6 只堆镶嵌点不满');
}

{
  // 6.3 满配实算
  const max = counterBreakOf(5, 7, 4, 0);
  eq(max, 0.6, '6.7 满级+品阶+4镶 = 0.60');
  ok(max < COUNTER_BREAK_MAX, '6.8 实算 0.60 < 硬上限 0.90（上限永不触及）');
}

{
  // 6.4 破防越高，实际倍率越接近 1
  //    收敛公式：实际 = 1 + (原始 - 1) × (1 - 破防)
  const base = COUNTER_MUL;
  const at0 = 1 + (base - 1) * (1 - 0);
  const at60 = 1 + (base - 1) * (1 - 0.6);
  ok(Math.abs(at0 - 1.6) < 1e-9, '6.9 破防 0 → ×1.6');
  ok(Math.abs(at60 - 1.24) < 1e-9, '6.10 破防 0.6 → ×1.24');
  ok(at60 < at0, '6.11 破防越高倍率越低');
}

{
  // 6.5 破防拉满（0.9）时倍率向 1 收敛，但不会低于 1
  //    实际 = 1 + (1.6 - 1) × (1 - 0.9) = 1 + 0.06 = 1.06
  const atMax = 1 + (COUNTER_MUL - 1) * (1 - COUNTER_BREAK_MAX);
  ok(Math.abs(atMax - 1.06) < 1e-9, '6.12 破防 0.9 → ×1.6 收敛到 1.06');
  ok(atMax > 1, '6.13 破防拉满后倍率仍高于 1（不追求完全免疫）');
  ok(atMax < COUNTER_MUL, '6.14 破防拉满后倍率低于原值（破防确实生效）');
}

const result = t.report();
// ⚠️ 必须设置 exitCode：否则 CI 里即使有断言失败，命令也会返回 0，
// 变异测试之类的外部检查会误判为"测试通过"。这个坑踩过一次。
if (result.failed > 0) process.exitCode = 1;
export { result };