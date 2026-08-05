const fs = require('fs');
const s = fs.readFileSync('data/capture/js/c58fe66133bc_1625.21b88a34.js', 'utf-8');

// Find IMCMD enum definition
console.log('=== GET_USER_CONVERSATION_LIST value ===');
const patterns = [
  /GET_USER_CONVERSATION_LIST\s*[:=]\s*(\d+)/,
  /GET_USER_CONVERSATION_LIST\s*[:=]\s*"(.*?)"/,
  /GET_USER_CONVERSATION_LIST\s*[:=]\s*([a-zA-Z_]\w*)/,
];
for (const p of patterns) {
  const m = s.match(p);
  if (m) {
    console.log(`Match: ${m[0]} -> ${m[1]}`);
  }
}

// Find all IMCMD definitions
console.log('\n=== IMCMD enum entries ===');
const imcmdBlockIdx = s.indexOf('GET_USER_CONVERSATION_LIST');
if (imcmdBlockIdx > 0) {
  // Search backward for IMCMD definition block
  const before = s.slice(Math.max(0, imcmdBlockIdx - 5000), imcmdBlockIdx);
  // Find pattern like: IMCMD = { ... } or GET_USER_CONVERSATION_LIST: 1234
  const enumMatch = before.match(/IMCMD\s*[:=]\s*\{([^}]+)\}\s*[,;]/);
  if (enumMatch) {
    console.log('IMCMD enum block:');
    console.log(enumMatch[1].slice(0, 2000));
  } else {
    // Try to find individual cmd: number patterns
    console.log('Searching for cmd:number pairs...');
    const cmdPattern = /(\w+)\s*[:=]\s*(\d{2,4})\s*[,;]/g;
    let m;
    const cmds = {};
    while ((m = cmdPattern.exec(before)) !== null) {
      if (m[1].toUpperCase() === m[1] && m[1].length > 3) {
        cmds[m[1]] = m[2];
      }
    }
    console.log('Found CMD-like entries:');
    for (const [k, v] of Object.entries(cmds)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

// Also look for "GET_USER_CONVERSATION_LIST" in a different context
console.log('\n=== GET_USER_CONVERSATION_LIST all occurrences ===');
let idx = 0;
let count = 0;
while ((idx = s.indexOf('GET_USER_CONVERSATION_LIST', idx)) !== -1 && count < 5) {
  console.log(`\n--- occurrence ${count + 1} at ${idx} ---`);
  console.log(s.slice(Math.max(0, idx - 200), idx + 200));
  idx += 5;
  count++;
}

// Find all IMCMD.* references
console.log('\n=== IMCMD.XXX references ===');
const imcmdRefPattern = /IMCMD\.(\w+)/g;
let m;
const refs = {};
while ((m = imcmdRefPattern.exec(s)) !== null) {
  refs[m[1]] = (refs[m[1]] || 0) + 1;
}
console.log('All IMCMD references (with counts):');
for (const [k, v] of Object.entries(refs).sort()) {
  console.log(`  IMCMD.${k}: ${v}`);
}

// Find IMCMD definition
console.log('\n=== IMCMD definition block ===');
const defPatterns = [
  /IMCMD\s*\(?[^{]*\{[^}]+\}/,
  /exports\.IMCMD\s*=\s*\{[^}]+\}/,
  /\bIMCMD\b\s*[:=]\s*\{[^}]+\}/,
];
for (const p of defPatterns) {
  const m = s.match(p);
  if (m) {
    console.log('Found definition:');
    console.log(m[0].slice(0, 3000));
    break;
  }
}
