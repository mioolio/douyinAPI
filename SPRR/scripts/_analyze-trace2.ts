import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/trace-abogus.json', 'utf-8'));
const events = data.events;

const important = events.filter((e: any) => 
  e.type !== 'Math.random' && 
  e.type !== 'String.fromCharCode' && 
  e.type !== 'Array.push'
);

for (const e of important) {
  let info = '';
  if (e.data?.value !== undefined) info = `value=${JSON.stringify(e.data.value).slice(0, 100)}`;
  else if (e.data?.input_len !== undefined) info = `in_len=${e.data.input_len} out_len=${e.data.output_len}`;
  else if (e.data?.output_head) info = `out="${e.data.output_head}"`;
  else if (e.data?.output) info = `out=${JSON.stringify(e.data.output).slice(0, 200)}`;
  else info = JSON.stringify(e.data).slice(0, 200);
  console.log(`[id=${e.id} ts=${e.ts.toFixed(2).padStart(10)}] ${e.type.padEnd(25)} ${info}`);
}
