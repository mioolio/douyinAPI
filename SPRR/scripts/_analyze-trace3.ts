/**
 * 用更详细的事件序列分析 trace
 * 关注 btoa 和 TextEncoder.encode 的输入
 */
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/trace-abogus.json', 'utf-8'));
const events = data.events;

console.log('=== All btoa events with full details ===');
for (const e of events) {
  if (e.type === 'btoa') {
    console.log(`[id=${e.id} ts=${e.ts.toFixed(2)}] in_len=${e.data.input_len} out_len=${e.data.output_len}`);
    console.log(`  in: ${JSON.stringify(e.data.input_head || e.data.input).slice(0, 200)}`);
    console.log(`  out: ${e.data.output_head || e.data.output}`);
  }
}
console.log('\n=== All TextEncoder.encode events ===');
for (const e of events) {
  if (e.type === 'TextEncoder.encode') {
    console.log(`[id=${e.id} ts=${e.ts.toFixed(2)}] in_len=${e.data.input_len} out_len=${e.data.output_len}`);
    console.log(`  in: ${JSON.stringify(e.data.input_head || e.data.input).slice(0, 200)}`);
  }
}
console.log('\n=== All atob events ===');
for (const e of events) {
  if (e.type === 'atob') {
    console.log(`[id=${e.id} ts=${e.ts.toFixed(2)}] in_len=${e.data.input_len} out_len=${e.data.output_len}`);
    console.log(`  in_head: ${e.data.input_head}`);
    console.log(`  out: ${e.data.output_head || e.data.output}`);
  }
}
