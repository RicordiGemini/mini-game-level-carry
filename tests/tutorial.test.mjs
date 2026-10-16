/**
 * 教学体系测试 —— 触发点与文案表的**双向一致**。
 *
 * 【为什么这条最重要】
 *   `showTipById('x')` 里的 id 如果打错（比如写成 `tip_equip` 而表里是
 *   `tip_equipment`），**不会有任何报错**：文案表返回 undefined，
 *   提示静默不弹。这类 bug 玩家看到的是"游戏没教我"，但开发者毫无线索。
 *
 *   历史文档说 `tutorial_e2e.js` 里有这个双向一致断言 —— 那个文件不存在，
 *   于是这条保护此前完全没有代码在守。本套件把它补上。
 *
 * 【双向的含义】
 *   正向：每个 `showTipById('x')` 的 x 都必须有文案（防打错 id）
 *   反向：每条文案都必须有人触发（防死文案 —— 写了但永远不弹）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEWBIE_STEPS, FIRST_TIME_TIPS, NEWBIE_KEY } from '../.test-build/TutorialConfig.js';
import { createSuite } from './assert.mjs';

const t = createSuite('教学体系测试（触发点 ↔ 文案表双向一致）');
const { section, ok, eq, expectClean } = t;

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, '..', 'assets', 'scripts');

// ------------------------------------------------------------------
// 扫源码：找出所有 showTipById('x') 的实参
// ------------------------------------------------------------------
/** @returns {Set<string>} */
function collectTriggerIds() {
  const ids = new Set();
  const re = /showTipById\(\s*'([^']+)'\s*\)/g;

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts')) continue;
      const src = readFileSync(p, 'utf8');
      let m;
      while ((m = re.exec(src)) !== null) ids.add(m[1]);
    }
  }
  walk(scriptsDir);
  return ids;
}

const triggerIds = collectTriggerIds();
const tipKeys = Object.keys(FIRST_TIME_TIPS);

// ==================================================================
section('1 · 双向一致（核心）');

{
  // 1.1 正向：每个触发点都必须有文案
  const missing = [...triggerIds].filter((id) => !FIRST_TIME_TIPS[id]);
  eq(missing, [], '1.1 每个触发点都有对应文案（防打错 id）');
}

{
  // 1.2 反向：每条文案都必须有人触发（防死文案）
  const orphan = tipKeys.filter((id) => !triggerIds.has(id));
  eq(orphan, [], '1.2 每条文案都有人触发（防死文案）');
}

{
  // 1.3 数量本身也该对齐（数量不等必然有一侧出问题）
  eq(triggerIds.size, tipKeys.length, '1.3 触发点数 = 文案条数');
  eq(triggerIds.size, 14, '1.4 首通提示共 14 条');
}

// ==================================================================
section('2 · 文案表自身');

{
  // 2.1 每条都要有标题与正文
  const noTitle = tipKeys.filter((k) => !FIRST_TIME_TIPS[k].title || !FIRST_TIME_TIPS[k].title.trim());
  const noBody = tipKeys.filter((k) => !FIRST_TIME_TIPS[k].body || !FIRST_TIME_TIPS[k].body.trim());
  eq(noTitle, [], '2.1 每条提示都有标题');
  eq(noBody, [], '2.2 每条提示都有正文');
}

{
  // 2.2 正文不能是"单词"级别的占位
  const tooShort = tipKeys.filter((k) => FIRST_TIME_TIPS[k].body.trim().length < 20);
  eq(tooShort, [], '2.3 正文长度足够（不是占位符）');
}

{
  // 2.3 标题不能过长（会溢出卡片）
  const tooLong = tipKeys.filter((k) => FIRST_TIME_TIPS[k].title.trim().length > 12);
  eq(tooLong, [], '2.4 标题不超过 12 字');
}

{
  // 2.4 文案不应重复（两条一模一样的提示等于只教了一遍）
  const bodies = tipKeys.map((k) => FIRST_TIME_TIPS[k].body.trim());
  eq(new Set(bodies).size, bodies.length, '2.5 各条正文互不重复');
}

{
  // 2.5 id 命名规范
  const badNaming = tipKeys.filter((k) => !/^tip_[a-z_]+$/.test(k));
  eq(badNaming, [], '2.6 id 都符合 tip_xxx 命名');
}

// ==================================================================
section('3 · 新手引导');

{
  // 3.1 非空多步
  ok(NEWBIE_STEPS.length > 0, '3.1 新手引导有步骤', `实际 ${NEWBIE_STEPS.length} 步`);
  ok(NEWBIE_STEPS.length <= 10, '3.2 步骤不超过 10 步（跳过率会上升）');
}

{
  // 3.2 每步都要有标题与正文
  const bad = NEWBIE_STEPS.filter((s) => !s.title || !s.title.trim() || !s.body || !s.body.trim());
  eq(bad.length, 0, '3.3 每步都有标题与正文');
}

{
  // 3.3 最后一步要有 CTA（否则玩家不知道下一步干什么）
  const last = NEWBIE_STEPS[NEWBIE_STEPS.length - 1];
  ok(!!last.cta || !!last.action, '3.4 最后一步有 CTA');
}

{
  // 3.4 必须覆盖「操作/目标/产出」三要素
  const all = NEWBIE_STEPS.map((s) => s.title + s.body).join('\n');
  ok(all.includes('拖动') || all.includes('移动'), '3.5 引导讲到怎么操作');
  ok(all.includes('通关') || all.includes('击败') || all.includes('敌人'), '3.6 引导讲到目标');
  ok(all.includes('金币') || all.includes('水晶'), '3.7 引导讲到产出');
}

{
  // 3.5 存档标记 key 固定
  eq(NEWBIE_KEY, 'newbie', '3.8 存档标记 key 是 newbie');
}

// ==================================================================
section('4 · 已知待改（这些断言记录现状，不是"通过"）');

{
  // ⚠️ 第 2 步文案说"角色会自动攻击最近的敌人"，
  // 但初始武器 blade 的瞄准方式是 FRONT（前向，需玩家走位对准）。
  // 文案与实际不符 —— 第一次游玩的玩家会困惑。
  // 这条断言记录**现状**为不一致，等文案修好后会变红提醒更新。
  const step2 = NEWBIE_STEPS[1];
  const saysNearest = step2 && (step2.body.includes('最近的敌人') || step2.body.includes('自动攻击'));
  ok(saysNearest === true,
    '4.1 已知问题：新手引导第 2 步说"自动攻击最近的敌人"，与初始武器 FRONT 不符',
    '此断言在文案修正后应改为 false —— 属于"待办标记"而非质量断言');
}

const result = t.report();
// ⚠️ 必须设置 exitCode：否则 CI 里即使有断言失败，命令也会返回 0，
// 变异测试之类的外部检查会误判为"测试通过"。这个坑踩过一次。
if (result.failed > 0) process.exitCode = 1;
export { result };