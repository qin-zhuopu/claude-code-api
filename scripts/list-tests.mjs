import { readFileSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';

const testDir = resolve('test/integration');
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.spec.ts'))
  .sort();

console.log('\n📋 集成测试:\n');

for (const file of files) {
  const name = basename(file, '.spec.ts');
  const content = readFileSync(resolve(testDir, file), 'utf-8');

  const descMatch = content.match(/describe\(['"](.+?)['"]/);
  const label = descMatch ? descMatch[1] : name;

  console.log(`  npm run test:integration -- ${name.padEnd(25)} - ${label}`);
}

console.log('\n常用参数: --reporter=verbose | --reporter=dot\n');
