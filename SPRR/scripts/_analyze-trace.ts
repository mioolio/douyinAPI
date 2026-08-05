import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/trace-abogus.json', 'utf-8'));
const events = data.events;

console.log(`Total events: ${events.length}`);

// Group by type
const byType: Record<string, number> = {};
for (const e of events) {
  byType[e.type] = (byType[e.type] || 0) + 1;
}
console.log('\nEvents by type:');
for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}

// Show first event of each type
console.log('\n=== First event of each type ===');
const seen = new Set<string>();
for (const e of events) {
  if (!seen.has(e.type)) {
    seen.add(e.type);
    console.log(`\n--- ${e.type} (id=${e.id}, ts=${e.ts}) ---`);
    console.log(JSON.stringify(e.data, null, 2).slice(0, 500));
  }
}

// Show unique event types in chronological order of first appearance
console.log('\n=== Unique types in order of first appearance ===');
for (const e of events.slice(0, 50)) {
  console.log(`  id=${e.id} ts=${e.ts.toFixed(2)} type=${e.type}`);
}
