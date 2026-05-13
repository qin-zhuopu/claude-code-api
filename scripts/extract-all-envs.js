const fs = require('fs');
const text = fs.readFileSync('raw/claude-code-docs/docs/env-vars.md', 'utf-8');
const lines = text.split('\n');
const vars = [];
for (const line of lines) {
  // Match: | `VAR_NAME` | description... |
  const m = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*(.+)/);
  if (m) {
    const desc = m[2].replace(/\|\s*$/, '').trim().slice(0, 200);
    vars.push({ name: m[1], desc });
  }
}
// Also get vars from our reference doc
const refText = fs.readFileSync('raw/sdk-query-options-reference.md', 'utf-8');
const refVars = new Set();
const refRe = /`([A-Z][A-Z0-9_]+)`/g;
let rm;
while ((rm = refRe.exec(refText)) !== null) refVars.add(rm[1]);

const docVarNames = new Set(vars.map(v => v.name));
const inRef = vars.filter(v => refVars.has(v.name));
const notInRef = vars.filter(v => !refVars.has(v.name));

console.log(`Official doc: ${vars.length} vars`);
console.log(`In our reference: ${inRef.length}`);
console.log(`NOT in our reference: ${notInRef.length}`);
console.log('\n--- Missing from our reference ---');
for (const v of notInRef) {
  console.log(`${v.name}: ${v.desc.slice(0, 100)}`);
}
