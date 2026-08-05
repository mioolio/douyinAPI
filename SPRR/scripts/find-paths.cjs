const fs = require('fs');
const c = fs.readFileSync('data/capture/js/c58fe66133bc_1625.21b88a34.js', 'utf-8');

// Find MessageBody and Participant definitions
const keys = ['MessageBody=function', 'Participant=function', 'ConversationCoreInfo=function'];

for (const key of keys) {
  console.log(`\n===== ${key} =====`);
  let idx = c.indexOf(key);
  if (idx < 0) {
    console.log('NOT FOUND');
    continue;
  }
  const end = Math.min(c.length, idx + 3000);
  console.log(c.slice(idx, end));
  console.log('---end---');
}
