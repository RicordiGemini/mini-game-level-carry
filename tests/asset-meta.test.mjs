import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetMeta } from '../tools/asset-meta.mjs';

// 当前统一入口通过同步 import 捕获异常；断言失败直接上抛，避免异步测试被提前退出。
function test(name, run) {
  const cleanups = [];
  try {
    run({ after: cleanup => cleanups.push(cleanup) });
    console.log(`✅ 资源 meta：${name}`);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cocos-asset-meta-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = join(root, 'assets');
  const scripts = join(assets, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'Example.ts'), 'export const example = 1;\n');
  return { assets, scripts, meta: join(scripts, 'Example.ts.meta') };
}

test('只读检查不写文件；补齐目录和脚本后重复执行保留原文和 UUID', t => {
  const { assets, meta } = fixture(t);
  const before = assetMeta(assets);
  assert.equal(before.missing.length, 2);
  assert.equal(existsSync(meta), false);
  assert.deepEqual(assetMeta(assets, { write: true }).errors, []);
  const original = readFileSync(meta, 'utf8');
  const data = JSON.parse(original);
  data.userData.custom = '应保留的设置';
  const customized = JSON.stringify(data, null, 4);
  writeFileSync(meta, customized);
  const again = assetMeta(assets, { write: true });
  assert.equal(again.created.length, 0);
  assert.equal(again.missing.length, 0);
  assert.deepEqual(again.errors, []);
  assert.equal(readFileSync(meta, 'utf8'), customized);
  assert.equal(JSON.parse(readFileSync(meta)).uuid, JSON.parse(original).uuid);
  assert.equal(existsSync(`${assets}.meta`), false);
});

test('损坏 JSON 阻止其他缺失 meta 的写入，且不改损坏文件', t => {
  const { assets, scripts, meta } = fixture(t);
  assetMeta(assets, { write: true });
  writeFileSync(meta, '{broken');
  writeFileSync(join(scripts, 'New.ts'), '');
  const result = assetMeta(assets, { write: true });
  assert.match(result.errors.join('\n'), /无法读取 JSON/);
  assert.equal(result.created.length, 0);
  assert.equal(existsSync(join(scripts, 'New.ts.meta')), false);
  assert.equal(readFileSync(meta, 'utf8'), '{broken');
});

test('重复 UUID（含子资源）报错，预检失败时不生成任何文件', t => {
  const { assets, scripts, meta } = fixture(t);
  assetMeta(assets, { write: true });
  const data = JSON.parse(readFileSync(meta));
  data.subMetas = { duplicate: { uuid: data.uuid } };
  writeFileSync(meta, JSON.stringify(data));
  writeFileSync(join(scripts, 'New.ts'), '');
  const result = assetMeta(assets, { write: true });
  assert.match(result.errors.join('\n'), /UUID 重复/);
  assert.equal(result.created.length, 0);
});

test('跨文件 UUID 冲突、空标识和 importer 错配均可定位', t => {
  const { assets, scripts, meta } = fixture(t);
  assetMeta(assets, { write: true });
  writeFileSync(join(scripts, 'Other.ts'), '');
  writeFileSync(join(scripts, 'Other.ts.meta'), readFileSync(meta));
  assert.match(assetMeta(assets).errors.join('\n'), /UUID 重复/);
  const data = JSON.parse(readFileSync(meta));
  data.uuid = '';
  data.importer = 'text';
  writeFileSync(meta, JSON.stringify(data));
  const errors = assetMeta(assets).errors.join('\n');
  assert.match(errors, /无效 UUID/);
  assert.match(errors, /importer 应为 typescript/);
});

test('孤立 meta 和未知资源阻止生成，不猜测图片、声明文件导入格式', t => {
  const { assets, scripts } = fixture(t);
  writeFileSync(join(scripts, 'Missing.ts.meta'), '{}');
  writeFileSync(join(assets, 'image.png'), 'placeholder');
  writeFileSync(join(scripts, 'Types.d.ts'), '');
  const result = assetMeta(assets, { write: true });
  assert.match(result.errors.join('\n'), /孤立 .meta/);
  assert.equal(result.errors.filter(error => error.includes('请由 Cocos 编辑器')).length, 2);
  assert.equal(result.created.length, 0);
});

test('已有其他类型的合法 meta 和子资源标识不被覆盖', t => {
  const { assets } = fixture(t);
  const path = join(assets, 'image.png');
  writeFileSync(path, 'placeholder');
  const uuid = randomUUID();
  const original = JSON.stringify({
    ver: '1.0.0', importer: 'image', imported: true, uuid,
    files: [], subMetas: { texture: { uuid: `${uuid}@6c48a` } }, userData: {},
  });
  writeFileSync(`${path}.meta`, original);
  assert.deepEqual(assetMeta(assets, { write: true }).errors, []);
  assert.equal(readFileSync(`${path}.meta`, 'utf8'), original);
});
