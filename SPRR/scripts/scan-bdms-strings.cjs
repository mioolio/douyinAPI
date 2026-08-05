// 字符串数组扫描
const fs = require('fs');
const path = 'd:/Desktop/DYCC/SPRR/data/capture/bdms.js';
const src = fs.readFileSync(path, 'utf-8');

// 找最长的数组字面量
const arrRe = /\[(?:"(?:[^"\\]|\\.)*"\s*,\s*){5,}/g;
let m;
let cnt = 0;
while ((m = arrRe.exec(src)) !== null && cnt < 10) {
  cnt++;
  console.log('位置:', m.index, '前文:', src.slice(Math.max(0, m.index-30), m.index));
  console.log('内容:', m[0].slice(0, 300));
  console.log('---');
}
