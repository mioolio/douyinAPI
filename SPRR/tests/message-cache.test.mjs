import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageCache, accountCacheKey } from '../dist/cli/message-cache.js';

const item = (id, cid = 'conversation-a', extra = {}) => ({
  msgId: id, serverMsgId: id, conversationId: cid, senderId: 'peer',
  senderLabel: '对方', isSelf: false, isFromRobot: false,
  messageType: 7, category: 'text', text: 'example', ...extra,
});

test('references are isolated by account and conversation, and returned as copies', () => {
  const cache = new MessageCache();
  cache.put('account-a', 'conversation-a', [item('123')]);
  assert.equal(cache.get('account-b', '123'), null);
  assert.equal(cache.get('account-a', '123', 'conversation-b'), null);
  const reference = cache.get('account-a', '123');
  reference.message.text = 'modified';
  assert.equal(cache.get('account-a', '123').message.text, 'example');
  cache.put('account-a', 'conversation-b', [item('123', 'conversation-b')]);
  assert.equal(cache.get('account-a', '123'), null, 'ambiguous IDs must not infer a recipient');
});

test('known recalls cannot be resurrected by older history', () => {
  const cache = new MessageCache();
  cache.put('a', 'conversation-a', [item('123')]);
  cache.markRecalled('a', 'conversation-a', '123');
  cache.put('a', 'conversation-a', [item('123')]);
  assert.equal(cache.get('a', '123'), null);
  assert.equal(cache.isRecalled('a', 'conversation-a', '123'), true);
  assert.equal(cache.isRecalled('b', 'conversation-a', '123'), false);
});

test('expiry and bounded LRU capacity limit stale references and memory', () => {
  let now = 0;
  const cache = new MessageCache({ now: () => now, ttlMs: 100, maxEntries: 2 });
  cache.put('a', 'conversation-a', [item('1'), item('2')]);
  cache.get('a', '1');
  cache.put('a', 'conversation-a', [item('3')]);
  assert.equal(cache.get('a', '2'), null);
  now = 100;
  assert.equal(cache.get('a', '1'), null);
  cache.markRecalled('a', 'conversation-a', '3');
  cache.clear();
  assert.equal(cache.isRecalled('a', 'conversation-a', '3'), false);
});

test('cache account keys do not contain credentials', () => {
  const key = accountCacheKey({ cookie: 'uid_tt=fake; sessionid=test-only' });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, accountCacheKey({ cookie: 'uid_tt=other; sessionid=test-only' }));
});
