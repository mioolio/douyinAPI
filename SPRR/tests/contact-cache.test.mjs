import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactCache } from '../dist/cli/contact-cache.js';
import {
  listContactsResult, getHistory, getHistoryEx, getHistoryAll, detectMyUid, readImapiResponseBody, buildPrivateCid,
} from '../dist/api/operations.js';
import {
  encodeBytesField, encodeStringField, encodeVarintField,
  parseFields, findField, readMessage, readVarint,
} from '../dist/crypto/protobuf.js';

const env = { cookie: 'offline-test', identitySecurityDeviceId: '0' };
const contact = (uid = '1', extra = {}) => ({
  conversationId: `0:1:${uid}:9`, uid, secUid: `sec-${uid}`,
  nickname: '(pending)', lastMessage: '', conversationShortId: `100${uid}`,
  ...extra,
});
const branch = (contacts = [], extra = {}) => ({
  contacts, complete: true, pages: 1, rateLimited: false, ...extra,
});
const result = (options, regular = branch([contact()]), stranger = branch()) => ({
  contacts: [...(options.includeRegular ? regular.contacts : []), ...(options.includeStrangers ? stranger.contacts : [])],
  regular: options.includeRegular ? regular : null,
  stranger: options.includeStrangers ? stranger : null,
  complete: (!options.includeRegular || regular.complete) && (!options.includeStrangers || stranger.complete),
});
const names = (secUids, nickname = '昵称') => new Map(secUids.map((uid) => [uid, { nickname }]));
const createCache = (dependencies, options) => new ContactCache({
  fetchSelfUid: async () => '9', ...dependencies,
}, options);

test('identity inference requires a unique participant across distinct private conversations', () => {
  assert.equal(detectMyUid([contact('1')]), '');
  assert.equal(detectMyUid([contact('1'), contact('1')]), '');
  assert.equal(detectMyUid([contact('1'), contact('2')]), '9');
  assert.equal(detectMyUid([contact('1'), contact('2'), { ...contact('3'), conversationId: 'group:3:9' }]), '9');
  assert.equal(detectMyUid([contact('1'), { ...contact('2'), conversationId: '0:1:2:8' }]), '');
});

test('private conversation IDs cannot silently coerce unknown identity to zero', () => {
  assert.throws(() => buildPrivateCid('', '9'), /无法确认当前账号 UID/);
  assert.throws(() => buildPrivateCid('0', '9'), /无法确认当前账号 UID/);
  assert.throws(() => buildPrivateCid('9', ''), /目标用户 UID 无效/);
  assert.equal(buildPrivateCid('9', '1'), '0:1:1:9');
});

test('single conversation fetches real self UID once and corrects peer UID and secUid', async () => {
  let selfRequests = 0;
  const raw = contact('1', {
    uid: '1', secUid: 'sec-self',
    _participants: [{ uid: '1', secUid: 'sec-self' }, { uid: '9', secUid: 'sec-peer' }],
  });
  const cache = new ContactCache({
    fetchContacts: async (_env, options) => result(options, branch([raw])),
    fetchNames: async (_env, uids) => names(uids),
    fetchSelfUid: async () => { selfRequests++; return '1'; },
  });
  const first = await cache.get('a', env);
  assert.equal(first.myUid, '1');
  assert.equal(first.contacts[0].uid, '9');
  assert.equal(first.contacts[0].secUid, 'sec-peer');
  assert.equal(first.contacts[0]._participants, undefined);
  assert.equal(cache.getMyUid('a'), '1');
  await cache.get('a', env, { refreshRegular: true });
  assert.equal(selfRequests, 1);
  assert.equal(raw._participants.length, 2, 'internal source metadata is preserved for subsequent corrections');
});

test('multiple regular conversations confirm identity without another network dependency', async () => {
  const cache = new ContactCache({
    fetchContacts: async (_env, options) => result(options, branch([contact('1'), contact('2'), contact('3'), contact('4'), contact('5')])),
    fetchNames: async (_env, uids) => names(uids),
    fetchSelfUid: async () => assert.fail('five conversations already establish UID'),
  });
  assert.equal((await cache.get('a', env)).myUid, '9');
});

test('stranger-only account can resolve real UID without assuming the smaller participant', async () => {
  let selfRequests = 0;
  const cache = new ContactCache({
    fetchContacts: async (_env, options) => result(options, branch(), branch([contact('1', { uid: '9', isStranger: true })])),
    fetchNames: async (_env, uids) => names(uids),
    fetchSelfUid: async () => { selfRequests++; return '9'; },
  });
  const loaded = await cache.get('a', env);
  assert.equal(loaded.myUid, '9');
  assert.equal(loaded.contacts[0].uid, '1');
  assert.equal(selfRequests, 1);
});

test('unavailable identity remains explicit, cools down and recovers without caching a guessed UID', async () => {
  let now = 0;
  let requests = 0;
  const cache = new ContactCache({
    now: () => now,
    fetchContacts: async (_env, options) => result(options),
    fetchNames: async (_env, uids) => names(uids),
    fetchSelfUid: async () => {
      if (++requests === 1) throw new Error('profile temporary failure');
      return '9';
    },
  }, { retryMs: 20 });
  const initial = await cache.get('a', env);
  assert.equal(initial.myUid, '');
  assert.equal(initial.contacts[0].uid, '');
  assert.match(initial.identityError, /temporary failure/);
  assert.equal(cache.getMyUid('a'), '');
  now = 19;
  await cache.get('a', env);
  assert.equal(requests, 1);
  now = 20;
  assert.equal((await cache.get('a', env)).myUid, '9');
  assert.equal(requests, 2);
});

test('non-numeric cookie identifiers and profile UID outside the conversation are rejected', async () => {
  for (const uid of ['1ec0cd22ce7344fb3d3af6796b3937d4', '77']) {
    const cache = new ContactCache({
      fetchContacts: async (_env, options) => result(options),
      fetchNames: async (_env, uids) => names(uids),
      fetchSelfUid: async () => uid,
    });
    const loaded = await cache.get('a', env);
    assert.equal(loaded.myUid, '');
    assert.equal(loaded.contacts[0].uid, '');
    assert.ok(loaded.identityError);
  }
});

test('list refreshes unread state while reusing nicknames and stranger source', async () => {
  let now = 0;
  const calls = [];
  const nameCalls = [];
  let unread = 0;
  const cache = createCache({
    now: () => now,
    fetchContacts: async (_env, options) => {
      calls.push({ ...options });
      return result(options, branch([contact('1', { unreadCount: unread })]));
    },
    fetchNames: async (_env, uids) => { nameCalls.push(uids); return names(uids); },
  });
  assert.equal((await cache.get('account-a', env, { refreshRegular: true })).contacts[0].unreadCount, 0);
  now = 24_000;
  unread = 1;
  assert.equal((await cache.get('account-a', env, { refreshRegular: true })).contacts[0].unreadCount, 1);
  await cache.get('account-a', env);
  assert.deepEqual(calls, [
    { includeRegular: true, includeStrangers: true },
    { includeRegular: true, includeStrangers: false },
  ]);
  assert.equal(nameCalls.length, 1);
});

test('regular and stranger sources expire independently', async () => {
  let now = 0;
  const calls = [];
  const cache = createCache({
    now: () => now,
    fetchContacts: async (_env, options) => { calls.push({ ...options }); return result(options); },
    fetchNames: async (_env, uids) => names(uids),
  });
  await cache.get('a', env);
  now = 30_000;
  await cache.get('a', env);
  now = 60_000;
  await cache.get('a', env);
  assert.deepEqual(calls, [
    { includeRegular: true, includeStrangers: true },
    { includeRegular: true, includeStrangers: false },
    { includeRegular: true, includeStrangers: true },
  ]);
});

test('stranger-only refresh corrects peer UID using established regular conversations', async () => {
  let now = 0;
  const calls = [];
  const cache = createCache({
    now: () => now,
    fetchContacts: async (_env, options) => {
      calls.push({ ...options });
      return result(options,
        branch([contact('1'), contact('3')]),
        branch([contact('2', { uid: '9', isStranger: true })]));
    },
    fetchNames: async (_env, uids) => names(uids),
  }, { regularTtlMs: 1000, strangerTtlMs: 100 });
  await cache.get('a', env);
  now = 100;
  const refreshed = await cache.get('a', env);
  assert.deepEqual(calls[1], { includeRegular: false, includeStrangers: true });
  assert.equal(refreshed.contacts.find((item) => item.isStranger).uid, '2');
});

test('stranger 409 preserves old data and uses exponential cooldown even for forced refresh', async () => {
  let now = 0;
  const requestedStrangers = [];
  let strangerRequests = 0;
  const cache = createCache({
    now: () => now,
    fetchContacts: async (_env, options) => {
      requestedStrangers.push(options.includeStrangers);
      if (options.includeStrangers) strangerRequests++;
      const stranger = strangerRequests === 1 || strangerRequests === 4
        ? branch([contact('2', { isStranger: true })])
        : branch([], { complete: false, statusCode: 409, error: 'too many requests', rateLimited: true });
      return result(options, branch([contact()]), stranger);
    },
    fetchNames: async (_env, uids) => names(uids),
  });
  await cache.get('a', env);
  now = 60_000;
  const failed = await cache.get('a', env, { refreshRegular: true });
  assert.equal(failed.contacts.length, 2);
  assert.equal(failed.complete, false);
  assert.equal(failed.stale, true);
  assert.equal(failed.failures[0].statusCode, 409);
  now = 60_001;
  await cache.get('a', env, { refreshRegular: true, refreshStrangers: true });
  now = 120_000;
  await cache.get('a', env, { refreshRegular: true });
  now = 239_999;
  await cache.get('a', env, { refreshRegular: true, refreshStrangers: true });
  now = 240_000;
  const recovered = await cache.get('a', env, { refreshRegular: true });
  assert.deepEqual(requestedStrangers, [true, true, false, true, false, true]);
  assert.equal(recovered.complete, true);
  assert.deepEqual(recovered.failures, []);
});

test('successful empty result clears old contacts; partial failure merges usable pages', async () => {
  let phase = 0;
  const cache = createCache({
    fetchContacts: async (_env, options) => result(options,
      phase === 0 ? branch([contact()]) : phase === 1
        ? branch([contact('2')], { complete: false, error: 'second page failed' }) : branch()),
    fetchNames: async (_env, uids) => names(uids),
  });
  await cache.get('a', env);
  phase = 1;
  const partial = await cache.get('a', env, { refreshRegular: true });
  assert.equal(partial.contacts.length, 2);
  assert.equal(partial.complete, false);
  phase = 2;
  const empty = await cache.get('a', env, { refreshRegular: true });
  assert.deepEqual(empty.contacts, []);
  assert.equal(empty.complete, true);
});

test('first-load transient failure retries after delay instead of permanently caching empty', async () => {
  let now = 0;
  let requests = 0;
  const cache = createCache({
    now: () => now,
    fetchContacts: async (_env, options) => {
      requests++;
      return result(options, requests === 1
        ? branch([], { complete: false, error: 'temporary failure' }) : branch([contact()]));
    },
    fetchNames: async (_env, uids) => names(uids),
  });
  assert.equal((await cache.get('a', env)).complete, false);
  now = 29_999;
  assert.deepEqual((await cache.get('a', env)).contacts, []);
  assert.equal(requests, 1);
  now = 30_000;
  assert.equal((await cache.get('a', env)).contacts.length, 1);
  assert.equal(requests, 2);
});

test('nickname failure preserves old name and retries without freezing it', async () => {
  let now = 0;
  let nameRequests = 0;
  const cache = createCache({
    now: () => now,
    fetchContacts: async (_env, options) => result(options),
    fetchNames: async (_env, uids) => {
      nameRequests++;
      return nameRequests === 2 ? new Map() : names(uids, nameRequests === 1 ? '旧昵称' : '新昵称');
    },
  }, { nicknameTtlMs: 100, retryMs: 20 });
  assert.equal((await cache.get('a', env)).contacts[0].nickname, '旧昵称');
  now = 100;
  const failed = await cache.get('a', env);
  assert.equal(failed.contacts[0].nickname, '旧昵称');
  assert.equal(failed.stale, true);
  now = 119;
  await cache.get('a', env);
  assert.equal(nameRequests, 2);
  now = 120;
  assert.equal((await cache.get('a', env)).contacts[0].nickname, '新昵称');
  assert.equal(nameRequests, 3);
});

test('account isolation and returned copies prevent aliases from polluting cache', async () => {
  const cache = createCache({
    fetchContacts: async (_env, options) => result(options),
    fetchNames: async (requestEnv, uids) => names(uids, requestEnv.cookie),
  });
  const a = await cache.get('a', { ...env, cookie: 'offline-a' });
  a.contacts[0].nickname = 'local alias';
  a.contacts[0].uid = 'changed';
  const b = await cache.get('b', { ...env, cookie: 'offline-b' });
  assert.equal(b.contacts[0].nickname, 'offline-b');
  assert.equal((await cache.get('a', env)).contacts[0].nickname, 'offline-a');
  assert.equal((await cache.get('a', env)).contacts[0].uid, '1');
});

test('account and nickname capacity are bounded and clear removes the requested account', async () => {
  let contactRequests = 0;
  let nameRequests = 0;
  const cache = createCache({
    fetchContacts: async (_env, options) => {
      contactRequests++;
      return result(options, branch([contact('1'), contact('2')]));
    },
    fetchNames: async (_env, uids) => { nameRequests++; return names(uids); },
  }, { maxAccounts: 1, maxNicknames: 1 });
  await cache.get('a', env);
  await cache.get('a', env);
  assert.equal(nameRequests, 2, 'evicted nickname is refetched');
  await cache.get('b', env);
  await cache.get('a', env);
  assert.equal(contactRequests, 3, 'evicted account is refetched');
  cache.clear('a');
  await cache.get('a', env);
  assert.equal(contactRequests, 4);
});

test('concurrent callers share one load but receive independent contact objects', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const cache = createCache({
    fetchContacts: async (_env, options) => { requests++; await gate; return result(options); },
    fetchNames: async (_env, uids) => names(uids),
  });
  const first = cache.get('a', env);
  const second = cache.get('a', env);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  a.contacts[0].nickname = 'changed';
  assert.equal(b.contacts[0].nickname, '昵称');
});

function imResponse(body, statusCode = 0, errorDesc = 'OK') {
  return { cmd: 0, sequenceId: 0, statusCode, errorDesc, body, logId: 'offline' };
}

test('API metadata distinguishes successful empty regular source from stranger rate limit', async () => {
  const logChunks = [];
  const previousWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) { logChunks.push(String(chunk)); return true; };
  try {
    const loaded = await listContactsResult(env, {}, {
      sendImapi: async ({ path }) => path.includes('/stranger/')
        ? imResponse(Buffer.alloc(0), 409, 'too many requests')
        : imResponse(encodeBytesField(2006, encodeVarintField(2, 0))),
    });
    assert.equal(loaded.regular.complete, true);
    assert.deepEqual(loaded.regular.contacts, []);
    assert.equal(loaded.stranger.complete, false);
    assert.equal(loaded.stranger.rateLimited, true);
    assert.equal(loaded.stranger.statusCode, 409);
    assert.equal(loaded.complete, false);
    assert.match(logChunks.join(''), /cmd=1001 未完成/);
    assert.doesNotMatch(logChunks.join(''), /cmd=1001 完成/);
  } finally {
    process.stderr.write = previousWrite;
  }
});

test('API preserves an earlier regular page when a later page fails', async () => {
  let requests = 0;
  const conv = Buffer.concat([
    encodeStringField(1, '0:1:1:9'), encodeVarintField(2, 1001), encodeVarintField(3, 1),
  ]);
  const loaded = await listContactsResult(env, { includeStrangers: false }, {
    sendImapi: async () => ++requests === 1
      ? imResponse(encodeBytesField(2006, Buffer.concat([
        encodeBytesField(1, conv), encodeVarintField(2, 1), encodeVarintField(3, 1),
      ]))) : imResponse(Buffer.alloc(0), 409, 'too many requests'),
  });
  assert.equal(loaded.contacts.length, 1);
  assert.equal(loaded.regular.pages, 2);
  assert.equal(loaded.regular.complete, false);
  assert.equal(loaded.regular.rateLimited, true);
  assert.equal(loaded.stranger, null);
});

test('API reports HTTP rate limits and malformed successful responses as failures', async () => {
  const limited = await listContactsResult(env, { includeRegular: false }, {
    sendImapi: async () => { throw new Error('HTTP 429'); },
  });
  assert.equal(limited.stranger.complete, false);
  assert.equal(limited.stranger.rateLimited, true);
  assert.equal(limited.stranger.statusCode, 429);
  assert.equal(limited.stranger.pages, 1);
  const malformed = await listContactsResult(env, { includeStrangers: false }, {
    sendImapi: async () => imResponse(Buffer.alloc(0)),
  });
  assert.equal(malformed.regular.complete, false);
  assert.match(malformed.regular.error, /缺少 body/);
});

test('response validation allows true empty messages but rejects wrong wire and truncated protobuf', () => {
  for (const bodyType of [2006, 1000, 301]) {
    assert.deepEqual(readImapiResponseBody(encodeBytesField(bodyType, Buffer.alloc(0)), bodyType), []);
    assert.throws(() => readImapiResponseBody(encodeVarintField(bodyType, 0), bodyType), /类型错误/);
    const truncatedOuter = encodeBytesField(bodyType, Buffer.from([0])).subarray(0, -1);
    assert.throws(() => readImapiResponseBody(truncatedOuter, bodyType), /截断|无效/);
    const truncatedInnerLength = encodeBytesField(bodyType, Buffer.from([10, 7]));
    assert.throws(() => readImapiResponseBody(truncatedInnerLength, bodyType), /截断|无效/);
    const truncatedInnerVarint = encodeBytesField(bodyType, Buffer.from([8, 128]));
    assert.throws(() => readImapiResponseBody(truncatedInnerVarint, bodyType), /截断|无效/);
    const missingInnerVarint = encodeBytesField(bodyType, Buffer.from([8]));
    assert.throws(() => readImapiResponseBody(missingInnerVarint, bodyType), /截断|无效/);
    const truncatedLengthPrefix = encodeBytesField(bodyType, Buffer.alloc(0));
    truncatedLengthPrefix[truncatedLengthPrefix.length - 1] = 128;
    assert.throws(() => readImapiResponseBody(truncatedLengthPrefix, bodyType), /截断|无效/);
  }
});

test('API does not classify wrong-wire or truncated regular/stranger responses as successful empty', async () => {
  for (const source of ['regular', 'stranger']) {
    const bodyType = source === 'regular' ? 2006 : 1000;
    for (const body of [
      encodeVarintField(bodyType, 0),
      encodeBytesField(bodyType, Buffer.from([0])).subarray(0, -1),
    ]) {
      const loaded = await listContactsResult(env,
        { includeRegular: source === 'regular', includeStrangers: source === 'stranger' },
        { sendImapi: async () => imResponse(body) });
      assert.equal(loaded[source].complete, false);
      assert.ok(loaded[source].error);
      assert.equal(loaded.complete, false);
    }
  }
});

test('API stranger pagination takes next cursor from field 1, independently of unread total', async () => {
  const cursors = [];
  const conv = Buffer.concat([
    encodeStringField(1, '0:1:1:9'), encodeVarintField(2, 1001), encodeVarintField(3, 1),
  ]);
  const loaded = await listContactsResult(env, { includeRegular: false }, {
    sendImapi: async ({ body }) => {
      const requestBody = readMessage(findField(parseFields(body), 8));
      const strangerBody = readMessage(findField(requestBody, 1000));
      cursors.push(readVarint(findField(strangerBody, 1)));
      return imResponse(encodeBytesField(1000, Buffer.concat([
        encodeVarintField(1, 55), encodeVarintField(2, cursors.length === 1 ? 1 : 0),
        encodeVarintField(3, 2), ...(cursors.length === 1 ? [encodeBytesField(4, conv)] : []),
      ])));
    },
  });
  assert.deepEqual(cursors, [0, 55]);
  assert.equal(loaded.stranger.complete, true);
  assert.equal(loaded.stranger.contacts.length, 1);
});

function encodedImResponse(body, statusCode = 0, errorDesc = 'OK') {
  return Buffer.concat([
    encodeVarintField(1, 301), encodeVarintField(2, 1), encodeVarintField(3, statusCode),
    encodeStringField(4, errorDesc), encodeBytesField(6, body),
  ]);
}

async function withOfflineFetch(responder, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const body = await responder(...args);
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };
  try { return await fn(); } finally { globalThis.fetch = originalFetch; }
}

test('history APIs distinguish failed or malformed responses from successful empty history', async () => {
  const options = { conversationShortId: '1001', myUid: '9' };
  await withOfflineFetch(() => encodedImResponse(Buffer.alloc(0), 4, 'conversation not found'), async () => {
    await assert.rejects(getHistory(env, '0:1:1:9', options), /status=4.*conversation not found/);
    await assert.rejects(getHistoryEx(env, '0:1:1:9', options), /status=4.*conversation not found/);
  });
  await withOfflineFetch(() => encodedImResponse(Buffer.alloc(0)), async () => {
    await assert.rejects(getHistory(env, '0:1:1:9', options), /缺少 body 301/);
  });
  await withOfflineFetch(() => encodedImResponse(encodeBytesField(301, encodeVarintField(3, 0))), async () => {
    assert.deepEqual(await getHistory(env, '0:1:1:9', options), []);
  });
});

test('history pagination returns exactly the latest requested count when the last page overfills it', async () => {
  let page = 0;
  await withOfflineFetch(() => {
    page++;
    const latestIndex = page === 1 ? 100 : 50;
    const messages = Array.from({ length: 50 }, (_, offset) => {
      const index = latestIndex - offset;
      return encodeBytesField(1, Buffer.concat([
        encodeStringField(1, '0:1:1:9'), encodeVarintField(3, index),
        encodeVarintField(4, index), encodeVarintField(6, 7), encodeVarintField(7, 1),
        encodeStringField(8, JSON.stringify({ text: `message ${index}` })), encodeVarintField(10, index),
      ]));
    });
    return encodedImResponse(encodeBytesField(301, Buffer.concat([
      ...messages, encodeVarintField(2, page === 1 ? 51 : 1), encodeVarintField(3, page === 1 ? 1 : 0),
    ])));
  }, async () => {
    const messages = await getHistoryAll(env, '0:1:1:9', {
      conversationShortId: '1001', myUid: '9', maxMessages: 51, pageSize: 50,
    });
    assert.equal(page, 2);
    assert.equal(messages.length, 51);
    assert.equal(messages[0].serverMsgId, '50');
    assert.equal(messages.at(-1).serverMsgId, '100');
  });
});
