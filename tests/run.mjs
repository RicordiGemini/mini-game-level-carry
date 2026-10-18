/**
 * 测试统一入口。
 *
 * 逐个 import 各个 `*.test.mjs`，任何一个失败都会让本进程以非零码退出，
 * 于是 `npm test` 能被 CI 直接使用。
 *
 * 【为什么不做成并行】
 *   测试量很小（几十毫秒），串行跑更容易读输出。
 *   以后套件多了再换并发。
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('[test] 没有找到任何 *.test.mjs');
  process.exit(1);
}

let failedSuites = 0;

for (const f of files) {
  const url = pathToFileURL(join(here, f)).href;
  try {
    // 各套件自己process.exit(code)，所以这里只要捕获"非零退出"这件事
    await import(url);
  } catch (e) {
    failedSuites++;
    console.error(`\n❌ ${f} 抛出异常:`);
    console.error(e);
  }
  // 套件内部已report 并 exit(0)，正常情况下这里不会重复处理
}

process.exit(failedSuites > 0 || process.exitCode ? 1 : 0);
