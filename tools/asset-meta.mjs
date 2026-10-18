import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 格式来自官方 cocos-test-projects/v3.8.7；来源及编辑器验证边界见开发指南。
function templateFor(path, directory) {
  if (directory) {
    return { ver: '1.2.0', importer: 'directory', userData: { compressionType: {}, isRemoteBundle: {} } };
  }
  if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
    return { ver: '4.0.24', importer: 'typescript', userData: {} };
  }
  return null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 默认只检查；写入前先完成扫描，已有 .meta 永不重写。assets 根目录本身不生成 meta。 */
export function assetMeta(assetRoot, { write = false } = {}) {
  const report = { assets: 0, existing: 0, missing: [], created: [], errors: [] };
  const pending = [];
  const uuids = new Map();

  function registerUuid(uuid, location, subAsset = false) {
    const base = typeof uuid === 'string' ? uuid.split('@')[0] : '';
    if (!uuidPattern.test(base) || (!subAsset && base !== uuid) ||
        (subAsset && !new RegExp(`^${base}(?:@[a-z0-9_-]+)?$`, 'i').test(uuid))) {
      report.errors.push(`${location}: 无效 UUID`);
      return;
    }
    const key = uuid.toLowerCase();
    if (uuids.has(key)) report.errors.push(`${location}: UUID 重复，与 ${uuids.get(key)} 冲突`);
    else uuids.set(key, location);
  }

  function readMeta(path, template) {
    let meta;
    try {
      // 允许 UTF-8 BOM；读取不会重写文件。
      meta = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      report.errors.push(`${path}: 无法读取 JSON (${error.message})`);
      return;
    }
    if (!object(meta) || typeof meta.ver !== 'string' || !meta.ver ||
        typeof meta.importer !== 'string' || !meta.importer ||
        typeof meta.imported !== 'boolean' || !Array.isArray(meta.files) ||
        !object(meta.subMetas) || !object(meta.userData)) {
      report.errors.push(`${path}: .meta 基础结构不完整`);
      return;
    }
    if (template && meta.importer !== template.importer) {
      report.errors.push(`${path}: importer 应为 ${template.importer}，实际为 ${meta.importer}`);
    }
    // 既有版本可能由其他 3.8 补丁生成，不自动升级或覆盖。
    registerUuid(meta.uuid, path);
    function visitSubMetas(subMetas, parent) {
      for (const [name, sub] of Object.entries(subMetas)) {
        const location = `${parent}/subMetas/${name}`;
        if (!object(sub)) {
          report.errors.push(`${location}: 无效子资源`);
          continue;
        }
        registerUuid(sub.uuid, location, true);
        if (sub.subMetas !== undefined) {
          if (object(sub.subMetas)) visitSubMetas(sub.subMetas, location);
          else report.errors.push(`${location}: 无效 subMetas`);
        }
      }
    }
    visitSubMetas(meta.subMetas, path);
  }

  function scan(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        report.errors.push(`${path}: 不处理符号链接或目录联接`);
        continue;
      }
      if (entry.name.endsWith('.meta')) {
        if (!entry.isFile() || !byName.has(entry.name.slice(0, -5))) {
          report.errors.push(`${path}: 孤立 .meta 或不是普通文件`);
        }
        continue;
      }
      if (!entry.isFile() && !entry.isDirectory()) {
        report.errors.push(`${path}: 不支持的文件类型`);
        continue;
      }
      report.assets++;
      const template = templateFor(path, entry.isDirectory());
      const metaPath = `${path}.meta`;
      const metaEntry = byName.get(`${entry.name}.meta`);
      if (metaEntry) {
        if (metaEntry.isFile() && !metaEntry.isSymbolicLink()) {
          report.existing++;
          readMeta(metaPath, template);
        }
      } else {
        report.missing.push(metaPath);
        if (template) pending.push({ path: metaPath, template });
        else report.errors.push(`${path}: 请由 Cocos 编辑器生成此类资源的 .meta`);
      }
      if (entry.isDirectory()) scan(path);
    }
  }

  try {
    const root = lstatSync(assetRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('assets 必须是普通目录');
    scan(assetRoot);
  } catch (error) {
    report.errors.push(`${assetRoot}: ${error.message}`);
  }
  if (!write || report.errors.length) return report;

  for (const { path, template } of pending) {
    let uuid;
    do { uuid = randomUUID(); } while (uuids.has(uuid));
    uuids.set(uuid, path);
    const meta = {
      ver: template.ver, importer: template.importer, imported: true, uuid,
      files: [], subMetas: {}, userData: template.userData,
    };
    try {
      // 排他创建：即使扫描后有其他进程写入，也不会覆盖它的 UUID。
      writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      report.created.push(path);
    } catch (error) {
      report.errors.push(`${path}: 创建失败 (${error.message})，已停止；可检查后重试`);
      break;
    }
  }
  report.missing = report.missing.filter(path => !report.created.includes(path));
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--write')) {
    console.error('用法：node tools/asset-meta.mjs [--write]');
    process.exitCode = 1;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
    const result = assetMeta(root, { write: args.includes('--write') });
    console.log(`资源 ${result.assets} 项，已有 .meta ${result.existing} 项，新建 ${result.created.length} 项，缺失 ${result.missing.length} 项。`);
    for (const path of result.missing) console.error(`缺失：${path}`);
    for (const error of result.errors) console.error(error);
    if (result.missing.length || result.errors.length) process.exitCode = 1;
  }
}
