import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSignatureReady, isSignatureProbe, hasRequestSignature } from '../dist/commands/signature-ready.js';
import { BrowserSender } from '../dist/commands/browser-send.js';
import { chromium } from 'playwright';

function mockPage(signAfter = Infinity, evaluateError = null) {
  const state = { probes: 0, fulfilled: 0, removed: false };
  const page = {
    async route(matcher, handler) { state.matcher = matcher; state.handler = handler; },
    async unroute(matcher, handler) {
      assert.equal(matcher, state.matcher); assert.equal(handler, state.handler);
      state.removed = true;
    },
    async evaluate(fn, { marker }) {
      if (evaluateError) throw evaluateError;
      state.probes++;
      const url = new URL('https://www.douyin.com/passport/safe/get_identity_security_token/');
      url.searchParams.set('biz_trace_id', marker);
      if (state.probes >= signAfter) url.searchParams.set('a_bogus', 'mock-signature');
      assert.equal(state.matcher(url), true);
      const realTokenUrl = new URL(url);
      realTokenUrl.searchParams.set('biz_trace_id', 'normal-query');
      assert.equal(state.matcher(realTokenUrl), false);
      assert.equal(state.matcher(new URL('https://imapi.douyin.com/v1/message/send')), false);
      await state.handler({
        request: () => ({ url: () => url.href }),
        async fulfill({ status }) { assert.equal(status, 200); state.fulfilled++; },
      });
    },
  };
  return { page, state };
}

test('ready signature returns immediately without a fixed startup sleep', async () => {
  const { page, state } = mockPage(1);
  await waitForSignatureReady(page, { pause: async () => assert.fail('ready SDK should not sleep') });
  assert.equal(state.probes, 1);
  assert.equal(state.fulfilled, 1);
  assert.equal(state.removed, true);
});

test('probe waits for SDK signing, not merely for fetch; ordinary requests stay untouched', async () => {
  const { page, state } = mockPage(3);
  let now = 0;
  await waitForSignatureReady(page, { timeoutMs: 100, pollMs: 5, now: () => now, pause: async (ms) => { now += ms; } });
  assert.equal(state.probes, 3);
  assert.equal(now, 10);
  assert.equal(state.removed, true);
});

test('an unsigned SDK times out clearly and removes the temporary route', async () => {
  const { page, state } = mockPage();
  let now = 0;
  await assert.rejects(waitForSignatureReady(page, {
    timeoutMs: 10, pollMs: 5, now: () => now, pause: async (ms) => { now += ms; },
  }), /10ms.*a_bogus/);
  assert.equal(state.probes, 2);
  assert.equal(state.removed, true);
});

test('route is removed even if the page closes during evaluation', async () => {
  const { page, state } = mockPage(Infinity, new Error('page closed'));
  await assert.rejects(waitForSignatureReady(page), /page closed/);
  assert.equal(state.removed, true);
});

test('probe matching is bound to the exact origin, path and unique marker', () => {
  assert.equal(isSignatureProbe(new URL('https://www.douyin.com/passport/safe/get_identity_security_token/?biz_trace_id=probe'), 'probe'), true);
  assert.equal(isSignatureProbe(new URL('https://other.test/passport/safe/get_identity_security_token/?biz_trace_id=probe'), 'probe'), false);
  assert.equal(hasRequestSignature('https://www.douyin.com/?a_bogus='), false);
});

test('a navigation failure closes the partly created sender resources', async () => {
  const originalLaunch = chromium.launch;
  let contextClosed = 0;
  let browserClosed = 0;
  chromium.launch = async () => ({
    async newContext() {
      return {
        async addInitScript() {},
        async newPage() { return { on() {}, async goto() { throw new Error('navigation failed'); } }; },
        async close() { contextClosed++; },
      };
    },
    async close() { browserClosed++; },
  });
  try {
    const sender = new BrowserSender('unused-mock-state');
    await assert.rejects(sender.launch(), /navigation failed/);
    assert.equal(contextClosed, 1);
    assert.equal(browserClosed, 1);
    assert.equal(sender.isAlive(), false);
  } finally {
    chromium.launch = originalLaunch;
  }
});
