import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/capture/bdms-Z-table.json', 'utf-8'));
const Z = data.Z;

console.log('=== Key constants in Z table ===');
const targets = [253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266];
for (const idx of targets) {
  if (idx < Z.length) {
    console.log(`Z[${idx}] = "${Z[idx]}"`);
  }
}
