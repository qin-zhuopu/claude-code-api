#!/usr/bin/env node
/**
 * 比较两个 API request JSON 文件的结构差异
 * Usage: node scripts/compare-requests.js <file1> <file2>
 */

const fs = require('fs');
const path = require('path');

const file1 = process.argv[2];
const file2 = process.argv[3];

if (!file1 || !file2) {
  console.error('Usage: node scripts/compare-requests.js <file1> <file2>');
  process.exit(1);
}

const obj1 = JSON.parse(fs.readFileSync(path.resolve(file1), 'utf-8'));
const obj2 = JSON.parse(fs.readFileSync(path.resolve(file2), 'utf-8'));

// 提取结构摘要
function summarize(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) {
      result[path] = 'null';
    } else if (Array.isArray(value)) {
      result[path] = `Array[${value.length}]`;
      if (value.length > 0 && typeof value[0] === 'object') {
        // 只展开第一个元素的结构
        const sub = summarize(value[0], `${path}[0]`);
        Object.assign(result, sub);
      }
    } else if (typeof value === 'object') {
      result[path] = 'Object';
      const sub = summarize(value, path);
      Object.assign(result, sub);
    } else if (typeof value === 'string') {
      result[path] = `String(${value.length} chars)`;
    } else {
      result[path] = `${typeof value}: ${JSON.stringify(value)}`;
    }
  }
  return result;
}

console.log('=== File 1 结构 ===');
console.log(path.basename(file1));
console.log('');
const s1 = summarize(obj1);
for (const [k, v] of Object.entries(s1)) {
  console.log(`  ${k}: ${v}`);
}

console.log('\n=== File 2 结构 ===');
console.log(path.basename(file2));
console.log('');
const s2 = summarize(obj2);
for (const [k, v] of Object.entries(s2)) {
  console.log(`  ${k}: ${v}`);
}

// 比较顶层字段
console.log('\n=== 顶层字段对比 ===');
const keys1 = new Set(Object.keys(obj1));
const keys2 = new Set(Object.keys(obj2));

const onlyIn1 = [...keys1].filter(k => !keys2.has(k));
const onlyIn2 = [...keys2].filter(k => !keys1.has(k));
const common = [...keys1].filter(k => keys2.has(k));

if (onlyIn1.length) console.log(`\n  仅 File1 有: ${onlyIn1.join(', ')}`);
if (onlyIn2.length) console.log(`  仅 File2 有: ${onlyIn2.join(', ')}`);

console.log('\n=== 共有字段差异 ===');
for (const key of common) {
  const v1 = obj1[key];
  const v2 = obj2[key];

  if (JSON.stringify(v1) === JSON.stringify(v2)) {
    console.log(`  ${key}: 相同`);
    continue;
  }

  // 不同
  if (typeof v1 === 'string' && typeof v2 === 'string') {
    console.log(`  ${key}: 不同 (File1: ${v1.length} chars, File2: ${v2.length} chars)`);
  } else if (Array.isArray(v1) && Array.isArray(v2)) {
    console.log(`  ${key}: 不同 (File1: ${v1.length} items, File2: ${v2.length} items)`);
    // 对于 tools，列出名称
    if (key === 'tools') {
      const names1 = v1.map(t => t.name).join(', ');
      const names2 = v2.map(t => t.name).join(', ');
      console.log(`    File1 tools: ${names1}`);
      console.log(`    File2 tools: ${names2}`);
    }
    // 对于 messages，列出角色
    if (key === 'messages') {
      console.log(`    File1 messages: ${v1.map(m => m.role).join(' → ')}`);
      console.log(`    File2 messages: ${v2.map(m => m.role).join(' → ')}`);
    }
    // 对于 system，比较长度
    if (key === 'system') {
      const len1 = JSON.stringify(v1).length;
      const len2 = JSON.stringify(v2).length;
      console.log(`    File1 system: ${len1} chars total`);
      console.log(`    File2 system: ${len2} chars total`);
      // 列出每段的前 80 字符
      v1.forEach((s, i) => console.log(`    File1 system[${i}]: ${(s.text || '').slice(0, 80)}...`));
      v2.forEach((s, i) => console.log(`    File2 system[${i}]: ${(s.text || '').slice(0, 80)}...`));
    }
    if (key === 'betas') {
      console.log(`    File1: ${JSON.stringify(v1)}`);
      console.log(`    File2: ${JSON.stringify(v2)}`);
    }
  } else if (typeof v1 === 'object' && typeof v2 === 'object') {
    console.log(`  ${key}: 不同`);
    console.log(`    File1: ${JSON.stringify(v1).slice(0, 120)}`);
    console.log(`    File2: ${JSON.stringify(v2).slice(0, 120)}`);
  } else {
    console.log(`  ${key}: 不同 (File1: ${JSON.stringify(v1)}, File2: ${JSON.stringify(v2)})`);
  }
}

// messages 内容详细对比
console.log('\n=== Messages 内容对比 ===');
const msgs1 = obj1.messages || [];
const msgs2 = obj2.messages || [];
console.log(`File1: ${msgs1.length} messages, File2: ${msgs2.length} messages`);

for (let i = 0; i < Math.max(msgs1.length, msgs2.length); i++) {
  const m1 = msgs1[i];
  const m2 = msgs2[i];
  if (!m1) { console.log(`  [${i}] 仅 File2 有: role=${m2.role}`); continue; }
  if (!m2) { console.log(`  [${i}] 仅 File1 有: role=${m1.role}`); continue; }

  if (m1.role !== m2.role) {
    console.log(`  [${i}] role 不同: File1=${m1.role}, File2=${m2.role}`);
    continue;
  }

  const c1 = JSON.stringify(m1.content);
  const c2 = JSON.stringify(m2.content);
  if (c1 === c2) {
    console.log(`  [${i}] ${m1.role}: 相同 (${c1.length} chars)`);
  } else {
    console.log(`  [${i}] ${m1.role}: 不同 (File1: ${c1.length} chars, File2: ${c2.length} chars)`);
    // 如果是 user message，列出 content blocks 的类型和长度
    if (Array.isArray(m1.content) && Array.isArray(m2.content)) {
      console.log(`    File1 blocks: ${m1.content.map(b => `${b.type}(${(b.text||'').length})`).join(', ')}`);
      console.log(`    File2 blocks: ${m2.content.map(b => `${b.type}(${(b.text||'').length})`).join(', ')}`);
    }
  }
}
