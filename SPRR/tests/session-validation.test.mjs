import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionResponse, probeSession } from '../dist/commands/session-validation.js';
import { verifySessionidValid } from '../dist/commands/login.js';
import { encodeVarintField, encodeBytesField } from '../dist/crypto/protobuf.js';

const validResponse = Buffer.concat([
  encodeVarintField(1, 2006), encodeVarintField(3, 0),
  encodeBytesField(6, encodeBytesField(2006, Buffer.alloc(0))),
]);

test('only definite auth errors are invalid; throttling and unknown errors stay inconclusive', () => {
  assert.equal(classifySessionResponse({ statusCode: 0, errorDesc: 'OK' }).status, 'valid');
  assert.equal(classifySessionResponse({ statusCode: 7, errorDesc: 'unexepcted session length' }).status, 'invalid');
  for (const [statusCode, errorDesc] of [[409, 'too many requests'], [500, 'StatusCodeRemoteOrNetError'], [403, 'permission denied'], [12, 'unknown']]) {
    assert.equal(classifySessionResponse({ statusCode, errorDesc }).status, 'unavailable');
  }
});

test('temporary failures retry and recover without treating the session as expired', async () => {
  let requests = 0;
  let delays = 0;
  const result = await probeSession(async () => {
    if (++requests < 3) throw new Error('connection reset');
    return { statusCode: 0, errorDesc: 'OK' };
  }, { pause: async () => { delays++; } });
  assert.equal(result.status, 'valid');
  assert.equal(requests, 3);
  assert.equal(delays, 2);
});

test('persistent network failures remain unavailable; rate limits do not cause rapid retries', async () => {
  const result = await probeSession(async () => { throw new Error('network unavailable'); }, { pause: async () => {} });
  assert.equal(result.status, 'unavailable');
  let requests = 0;
  const throttled = await probeSession(async () => {
    requests++;
    return { statusCode: 409, errorDesc: 'too many requests' };
  }, { pause: async () => assert.fail('must not hammer throttled endpoint') });
  assert.equal(throttled.status, 'unavailable');
  assert.equal(requests, 1);
});

test('lightweight verification uses its cookie jar, preserves localStorage and disposes resources', async () => {
  const original = { cookies: [{ name: 'sessionid', value: 'old' }], origins: [{ origin: 'https://www.douyin.com', localStorage: [{ name: 'key', value: 'value' }] }] };
  let cookie = 'old';
  let disposed = false;
  const result = await verifySessionidValid('unused-mock-state', original, async (options) => {
    assert.equal(options.storageState, 'unused-mock-state');
    return {
      async storageState() { return { cookies: [{ name: 'sessionid', value: cookie }], origins: [] }; },
      async post(url, options) {
        assert.equal(url, 'https://imapi.douyin.com/v1/conversation/list');
        assert.equal(Buffer.isBuffer(options.data), true);
        cookie = 'rotated';
        return { ok: () => true, body: async () => validResponse };
      },
      async dispose() { disposed = true; },
    };
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.freshState.cookies[0].value, 'rotated');
  assert.deepEqual(result.freshState.origins, original.origins);
  assert.equal(disposed, true);
});

test('missing, wrong-wire and truncated body 2006 do not verify a session or replace its state', async () => {
  const header = Buffer.concat([encodeVarintField(1, 2006), encodeVarintField(3, 0)]);
  const truncated = encodeBytesField(2006, Buffer.from([8, 0])).subarray(0, -1);
  const incompleteVarint = encodeBytesField(2006, Buffer.from([8, 0x80]));
  for (const payload of [header, Buffer.concat([header, encodeBytesField(6, encodeVarintField(2006, 0))]), Buffer.concat([header, encodeBytesField(6, truncated)]), Buffer.concat([header, encodeBytesField(6, incompleteVarint)])]) {
    let disposed = false;
    let requests = 0;
    const result = await verifySessionidValid('unused-mock-state', { cookies: [] }, async () => ({
      storageState: async () => ({ cookies: [], origins: [] }),
      async post() { requests++; return { ok: () => true, body: async () => payload }; },
      async dispose() { disposed = true; },
    }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.freshState, undefined);
    assert.equal(disposed, true);
    assert.equal(requests, 1);
  }
});
