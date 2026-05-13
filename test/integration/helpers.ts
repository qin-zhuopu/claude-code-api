import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname, extname, resolve } from 'path';

/**
 * 生成带时间戳的目录名，每次运行隔离
 */
export function createTimestampDir(subDir: string): string {
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + '-' + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  const dir = join(__dirname, 'tmp', subDir, ts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 递归收集对象中所有的 key
 */
function collectKeys(value: unknown, keys: Set<string>): void {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach(item => collectKeys(item, keys));
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        keys.add(key);
        collectKeys((value as Record<string, unknown>)[key], keys);
      }
    }
  }
}

/**
 * 打印 JSON 对象的 key 树结构
 */
function printTree(value: unknown, prefix = ''): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    if (value.length === 0) return;
    printTree(value[0], prefix);
    return;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  keys.forEach((key, index) => {
    const last = index === keys.length - 1;
    const connector = last ? '└── ' : '├── ';
    const child = (value as Record<string, unknown>)[key];

    if (child && typeof child === 'object' && !Array.isArray(child)) {
      console.log(`${prefix}${connector}${key} {`);
      printTree(child, prefix + (last ? '    ' : '│   '));
      console.log(`${prefix}${last ? '└── ' : '│   '}}`);
    } else if (Array.isArray(child) && child.length > 0) {
      const item = child[0];
      if (item && typeof item === 'object') {
        console.log(`${prefix}${connector}${key} [${child.length}] {`);
        printTree(item, prefix + (last ? '    ' : '│   '));
        console.log(`${prefix}${last ? '└── ' : '│   '}}`);
      } else {
        console.log(`${prefix}${connector}${key} [${child.length}]`);
      }
    } else {
      console.log(`${prefix}${connector}${key}`);
    }
  });
}

/**
 * 对单个 JSON 文件进行 pretty 格式化，生成 .pretty.json 文件并打印 key 信息
 */
/**
 * 对单个 JSON 文件进行 pretty 格式化，生成 .pretty.json 文件并打印 key 信息。
 * 跳过空文件和无法解析的文件。
 */
export function prettyFormatJsonFile(filePath: string): void {
  const absolutePath = resolve(filePath);
  const dir = dirname(absolutePath);
  const base = basename(absolutePath);
  const name = basename(absolutePath, extname(base));
  const outPath = join(dir, `${name}.pretty.json`);

  const raw = readFileSync(absolutePath, 'utf-8');
  if (raw.length === 0) {
    console.log(`Skipped (empty): ${absolutePath}`);
    return;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    console.log(`Skipped (invalid JSON, ${raw.length} bytes): ${absolutePath}`);
    return;
  }

  // 写入格式化后的 JSON
  writeFileSync(outPath, JSON.stringify(obj, null, 2), 'utf-8');
  console.log(`Wrote: ${outPath}`);

  // 收集并打印所有 key
  const allKeys = new Set<string>();
  collectKeys(obj, allKeys);

  console.log(`\nTotal unique keys: ${allKeys.size}\n`);
  [...allKeys].sort().forEach(key => console.log(`  ${key}`));

  console.log('\n=== Key Tree ===\n');
  printTree(obj);
}

/**
 * 对目录下所有 JSON 文件进行 pretty 格式化（跳过已格式化的 .pretty.json）
 */
export function prettyFormatJsonFiles(dir: string): void {
  const jsonFiles = readdirSync(dir).filter(
    f => f.endsWith('.json') && !f.endsWith('.pretty.json'),
  );
  for (const file of jsonFiles) {
    prettyFormatJsonFile(join(dir, file));
  }
}
