const fs = require('fs');
const s = fs.readFileSync('d:/Desktop/DYCC/SPRR/data/capture/js/c58fe66133bc_1625.21b88a34.js', 'utf8');

const keys = [
  'GET_MESSAGE_BY_INIT',
  'GET_MESSAGES_CHECKINFO_IN_CONVERSATION',
  'GET_MESSAGE_INFO_BY_SERVER_ID',
  'GET_MESSAGES_BY_USER',
  'GET_MESSAGES_BY_USER_INIT_V',
  'GET_MESSAGES_BY_CONVERSATION',
  'GET_CONVERSATION_LIST',
  'GET_CONVERSATION',
  'GET_STRANGER_CONVERSATION_LIST',
  'GET_STRANGER_MESSAGES_IN_CONVERSATION',
  'GET_CONVERSATION_INFO_LIST_V2',
  'SEND_MESSAGE',
  'SEND_MESSAGE_P2P',
  'RECALL_MESSAGE',
  'DELETE_MESSAGE',
  'MARK_READ',
  'GET_READ_INDEX',
  'GET_MIN_INDEX',
  'GET_TICKET',
  'GET_STRANGER_INFO',
];

console.log('=== IMCMD definitions ===');
keys.forEach(k => {
  const re = new RegExp('"' + k + '"\\]=([0-9]+)', 'g');
  const m = re.exec(s);
  if (m) console.log(k + ' = ' + m[1]);
  else console.log(k + ' = (not found)');
});

console.log('\n=== All MESSAGE/CONVERSATION/SEND/USER cmds ===');
const re2 = /"([A-Z_][A-Z_0-9]{4,})"\]=(\d{2,4})/g;
const found = new Map();
let m2;
while ((m2 = re2.exec(s)) !== null) {
  const name = m2[1];
  const val = m2[2];
  if (/(MESSAGE|CONVERSATION|STRANGER|SEND|USER|TICKET|READ|INDEX|MARK|RECALL|DELETE|CHECK)/.test(name)) {
    if (!found.has(name) || found.get(name) !== val) {
      found.set(name, val);
    }
  }
}
const sorted = [...found.entries()].sort((a, b) => Number(a[1]) - Number(b[1]));
sorted.forEach(([n, v]) => console.log(v + '\t' + n));

console.log('\n=== API path mapping ===');
const pathRe = /"v[12]\/[a-z_]+\/[a-z_]+(\/[a-z_]+)?"/g;
const paths = new Set();
let m3;
while ((m3 = pathRe.exec(s)) !== null) {
  paths.add(m3[0]);
}
[...paths].sort().forEach(p => console.log(p));
