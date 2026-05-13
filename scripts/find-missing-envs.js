const fs = require('fs');

// Parse our reference doc - find vars in table rows
const ref = fs.readFileSync('raw/sdk-query-options-reference.md', 'utf-8');
const ourVars = new Set();
for (const line of ref.split('\n')) {
  const m = line.match(/\| `([A-Z_][A-Z0-9_]+)` \|/);
  if (m) ourVars.add(m[1]);
}
console.log('Our table vars:', ourVars.size);

// Parse official doc
const text = fs.readFileSync('raw/claude-code-docs/docs/env-vars.md', 'utf-8');
const official = [];
for (const line of text.split('\n')) {
  const m = line.match(/^\| `([A-Z][A-Z0-9_]+)`\s+\| (.+)/);
  if (m) {
    official.push({ name: m[1], desc: m[2].replace(/\|\s*$/, '').trim().slice(0, 120) });
  }
}
console.log('Official vars:', official.length);

const missing = official.filter(v => !ourVars.has(v.name));
console.log('Missing from our tables:', missing.length);

// Write markdown table for missing vars
const lines = ['', '## 其他环境变量（与封装 Agent 关系不大）', '',
  '以下变量主要用于 CLI 界面、特定云平台区域配置、插件管理等场景，对 SDK 封装 Agent 意义不大，但为完整性列出。', '',
  '| 变量 | 说明 |', '|------|------|'];
for (const v of missing) {
  lines.push(`| \`${v.name}\` | ${v.desc} |`);
}
fs.writeFileSync('tmp-missing-envs-table.md', lines.join('\n'));
console.log('Written to tmp-missing-envs-table.md');
