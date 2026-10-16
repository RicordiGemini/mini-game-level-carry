/**
 * 把测试要用的纯逻辑模块编译成 JS。
 *
 * 【为什么需要这一步】
 *   `battle/` 与 `core/` 的核心逻辑刻意不依赖 Cocos（当初"战斗层不认识属性表"
 *   这条架构约束带来的红利），所以它们可以在 Node 里直接跑断言。
 *   但它们 import 了 `cc` —— 而 cc 只在运行时由引擎提供，Node 里没有。
 *   所以编译时把 `cc` 换成一份**最小可运行的桩**。
 *
 * 【桩提供什么】
 *   - UI 组件类：`Component` / `Node` / `Label` / …（够解析 import 即可）
 *   - **`sys.localStorage`：内存实现**。这是让业务逻辑进Node 的关键 ——
 *     `SaveManager` 的全部存储访问都走这一个出口（`sys.localStorage.getItem`
 *     / `setItem` / `removeItem`），桩里实现它，整个存档与迁移链就能在 Node 跑。
 *   真实引擎行为不需要模拟 —— 被测的是我们自己的逻辑，不是 Cocos。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.test-build');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ---------------- cc 的运行时桩 ----------------
const stub = `
const noop = () => {};
const chain = new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : chain),
  apply: () => chain,
  construct: () => chain,
});
export const _decorator = {
  ccclass: () => (cls) => cls,
  property: () => () => noop,
  executeInEditMode: () => noop,
  requireComponent: () => () => noop,
  disallowMultiple: () => noop,
};
export class Component { constructor() {} onLoad() {} start() {} update() {} }
export class Node { constructor(n) { this.name = n || ''; } }
export class Graphics {}
export class Label {}
export class Color {}
export class Vec3 {}
export class Prefab {}
export class UITransform {}
export class Button {}
export class Sprite {}
export class Widget {}

/**
 * 内存版 localStorage —— 语义对齐浏览器 / 微信小游戏的 Storage。
 *
 * 【为什么要真的实现】
 *   SaveManager 的全部持久化都走 sys.localStorage，
 *   签名校验、键位迁移、坏档兜底这些逻辑只有在"真能存真能取"时才能测。
 *   用空壳 Proxy 的话，getItem 永远返回 Proxy，测出来的东西毫无意义。
 *
 * 【语义细节（都与浏览器一致，改动时注意）】
 *   - getItem 命中返回字符串，**未命中返回 null**（不是 undefined）
 *   - 写入的值统一转字符串
 *   - key 为 null 时不抛错，返回 undefined（浏览器行为）
 *   - 提供 __clear() 供测试重置
 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) {
      const v = map.get(String(k));
      return v === undefined ? null : v;
    },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    get length() { return map.size; },
    __dump() { return Object.fromEntries(map); },
  };
}
const storage = createMemoryStorage();

export const sys = {
  localStorage: storage,
  platform: 'test',
  os: 'test',
  /** 供测试直接摸到底层存储（清档、塞坏数据） */
  __storage: storage,
};
export const director = chain;
export const game = chain;
export const input = chain;
export const screen = chain;
export const view = chain;
export const macro = chain;
export const math = chain;
export const find = () => null;
export const instantiate = (x) => x;
export const warn = (...a) => console.warn(...a);
export const error = (...a) => console.error(...a);
export const log = (...a) => console.log(...a);
export const tween = chain;
export const easing = chain;
export default { Component, Node, _decorator };
`;
writeFileSync(join(outDir, 'cc-stub.mjs'), stub, 'utf8');

// 产物目录里放一份 package.json 声明 ESM，
// 否则 Node 会报 MODULE_TYPELESS_PACKAGE_JSON 警告并反复尝试按 CommonJS 解析
writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2),
  'utf8',
);

// ---------------- 编译 ----------------
const scripts = join(root, 'assets', 'scripts');
const tsBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

execFileSync(process.execPath, [
  tsBin,
  '--outDir', outDir,
  '--target', 'ES2020',
  '--module', 'ES2020',
  '--moduleResolution', 'node',
  '--skipLibCheck',
  '--experimentalDecorators',
  '--esModuleInterop',
  '--noEmitOnError', 'false',
  // 与 tsc 共用同一份 cc 类型声明，避免"编译能过但类型检查报错"的不一致
  join(root, 'types', 'cc-stub.d.ts'),
  join(scripts, 'data', 'FormConfig.ts'),
  join(scripts, 'data', 'EquipmentConfig.ts'),
  join(scripts, 'data', 'AuxConfig.ts'),
  join(scripts, 'data', 'GameTypes.ts'),
  join(scripts, 'data', 'RarityConfig.ts'),
  join(scripts, 'data', 'ElementConfig.ts'),
  join(scripts, 'data', 'TutorialConfig.ts'),
  join(scripts, 'data', 'LevelAffinity.ts'),
  join(scripts, 'data', 'BalanceGuard.ts'),
  join(scripts, 'battle', 'BattleTypes.ts'),
  join(scripts, 'battle', 'AttackFactory.ts'),
  join(scripts, 'battle', 'AimResolver.ts'),
  join(scripts, 'battle', 'BattleWorld.ts'),
  // ---- 业务逻辑（依赖 sys.localStorage，靠内存桩进 Node）----
  join(scripts, 'core', 'HashUtil.ts'),
  join(scripts, 'core', 'SaveManager.ts'),
  join(scripts, 'core', 'TutorialManager.ts'),
  join(scripts, 'core', 'AchievementManager.ts'),
], { cwd: root, stdio: 'inherit' });

// ---------------- 把产物里的 'cc' 重定向到桩，并补 ESM 扩展名 ----------------
/**
 * Node 的 ESM 解析器**不认**不带扩展名的相对路径（`./GameTypes` 会失败），
 * 而 tsc 输出的 ES2020 模块保持原样。所以必须在这一步补 `.js`。
 */
function patch(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { patch(p); continue; }
    if (!p.endsWith('.js')) continue;
    let src = readFileSync(p, 'utf8');
    let changed = false;

    if (/from\s+['"]cc['"]/.test(src)) {
      // 按**产物目录内的相对路径**算深度，不能用绝对路径切前缀 ——
// 递归到子目录时切不准会少算一层，指向不存在的 cc-stub.mjs。
      const rel = relative(outDir, p).replace(/\\/g, '/');   // 例 data/FormConfig.js
      const depth = rel.split('/').length - 1;       // 目录层数（data/ → 1）
      const up = depth === 0 ? './' : '../'.repeat(depth);
      src = src.replace(/from\s+['"]cc['"]/g, `from '${up}cc-stub.mjs'`);
      changed = true;
    }
    // 相对路径补扩展名：'./X' → './X.js'（已是 .js/.mjs 或非相对的不动）
    src = src.replace(/from\s+(['"])(\.[^'"]*?)\1/g, (m, q, spec) => {
      if (/\.(js|mjs|json)$/.test(spec)) return m;
      return `from ${q}${spec}.js${q}`;
    });
    changed = true;

    if (changed) writeFileSync(p, src, 'utf8');
  }
}
patch(outDir);

console.log('[build:test] 编译完成 →', outDir);