/**
 * 把测试要用的纯逻辑模块编译成 JS。
 *
 * 【为什么需要这一步】
 *   `battle/` 与 `core/` 的核心逻辑刻意不依赖 Cocos（当初"战斗层不认识属性表"
 *   这条架构约束带来的红利），所以它们可以在 Node 里直接跑断言。
 *   但配置表 import 了 `cc` —— 而 cc 只在运行时由引擎提供，Node 里没有。
 *   所以编译时把 `cc` 换成一份**最小可运行的桩**。
 *
 * 【桩里只提供什么】
 *   仅配置表实际用到的成员。真实引擎行为不需要模拟 ——
 *   被测的是校验逻辑，不是引擎。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
export const director = chain;
export const sys = chain;
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
  join(scripts, 'data', 'FormConfig.ts'),
  join(scripts, 'data', 'EquipmentConfig.ts'),
  join(scripts, 'data', 'AuxConfig.ts'),
  join(scripts, 'data', 'GameTypes.ts'),
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
      const rel = p.slice(outDir.length).replace(/\\/g, '/');
      const depth = rel.split('/').length - 1;
      const up = '../'.repeat(depth);
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