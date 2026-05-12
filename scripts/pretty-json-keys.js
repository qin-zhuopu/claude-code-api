#!/usr/bin/env node

// Read a JSON file, format it pretty, write <original>.pretty.json alongside it,
// and print all unique keys to stdout.
// Usage: node scripts/pretty-json-keys.js <json-file-path>

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node scripts/pretty-json-keys.js <json-file-path>');
  process.exit(1);
}

const absolutePath = path.resolve(filePath);
const dir = path.dirname(absolutePath);
const base = path.basename(absolutePath);
const name = path.basename(absolutePath, path.extname(base));
const outPath = path.join(dir, `${name}.pretty.json`);

const raw = fs.readFileSync(absolutePath, 'utf-8');
const obj = JSON.parse(raw);

// Write pretty JSON next to original file
fs.writeFileSync(outPath, JSON.stringify(obj, null, 2), 'utf-8');
console.log(`Wrote: ${outPath}`);

// Extract all keys recursively
// Collect keys as a tree
const allKeys = new Set();

function collectKeys(value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach(collectKeys);
    } else {
      Object.keys(value).forEach((key) => {
        allKeys.add(key);
        collectKeys(value[key]);
      });
    }
  }
}

collectKeys(obj);

console.log(`\nTotal unique keys: ${allKeys.size}\n`);
[...allKeys].sort().forEach((key) => console.log(`  ${key}`));

// Print tree structure
function printTree(value, prefix = '', isLast = true) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    if (value.length === 0) return;
    // For arrays, just show the first element's structure
    printTree(value[0], prefix, isLast);
    return;
  }

  const keys = Object.keys(value);
  keys.forEach((key, index) => {
    const last = index === keys.length - 1;
    const connector = last ? '└── ' : '├── ';
    const child = value[key];

    if (child && typeof child === 'object' && !Array.isArray(child)) {
      console.log(`${prefix}${connector}${key} {`);
      printTree(child, prefix + (last ? '    ' : '│   '), true);
      console.log(`${prefix}${last ? '└── ' : '│   '}}`);
    } else if (Array.isArray(child) && child.length > 0) {
      const item = child[0];
      if (item && typeof item === 'object') {
        console.log(`${prefix}${connector}${key} [${child.length}] {`);
        printTree(item, prefix + (last ? '    ' : '│   '), true);
        console.log(`${prefix}${last ? '└── ' : '│   '}}`);
      } else {
        console.log(`${prefix}${connector}${key} [${child.length}]`);
      }
    } else {
      console.log(`${prefix}${connector}${key}`);
    }
  });
}

console.log('\n=== Key Tree ===\n');
printTree(obj);
