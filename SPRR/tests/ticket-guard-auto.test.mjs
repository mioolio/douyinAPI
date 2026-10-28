import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/commands/ticket-guard-auto.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

// Every fetch is handled locally by the mock route. No real browser, account or network is used.
function fixture(options = {}) {
  const state = { probes: 0, fulfilled: 0, fallback: 0, removed: 0, browserClosed: 0, contextClosed: 0 };
  const activeTimers = new Set();
  const fakeCookie = 'sessionid=offline-auth; msToken=offline-rotating-token';
  let matcher;
  let handler;
  const page = {
    async route(match, handle) { matcher = match; handler = handle; },
    async unroute(match, handle) {
      assert.equal(match, matcher); assert.equal(handle, handler);
      state.removed++;
    },
    async goto() { if (options.failAt === 'goto') throw new Error('offline navigation failure'); },
    async evaluate(fn, args) {
      if (options.hangEvaluate) return new Promise(() => {});
      return fn(args);
    },
  };
  const requestRoute = (method = 'POST', body = 'aweme_id=0') => ({
    request: () => ({
      method: () => method, postData: () => body,
      allHeaders: async () => state.probes < (options.readyAfter ?? 1) ? {} : {
        'bd-ticket-guard-client-data': 'offline-client',
        'bd-ticket-guard-ree-public-key': 'offline-key',
        'x-tt-session-dtrait': 'offline-session', cookie: fakeCookie,
      },
    }),
    async fulfill(response) {
      state.fulfilled++;
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).comment, undefined, 'probe response must not impersonate a published comment');
    },
    async fallback() { state.fallback++; },
    async abort() {},
  });
  const context = {
    async addInitScript() { if (options.failAt === 'init') throw new Error('offline init failure'); },
    async newPage() { if (options.failAt === 'page') throw new Error('offline page failure'); return page; },
    async cookies(url) { assert.equal(url, 'https://www.douyin.com/aweme/v1/web/comment/publish'); return [{ name: 'sessionid', value: 'offline-auth' }]; },
    async close() { state.contextClosed++; },
  };
  const browser = {
    async newContext() { if (options.failAt === 'context') throw new Error('offline context failure'); return context; },
    async close() { state.browserClosed++; },
  };
  const imports = {
    'node:crypto': crypto,
    '../utils/logger.js': { createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    '../crypto/ticket-guard.js': { ticketGuardSessionFingerprint: (cookie) => cookie ? `hash:${cookie}` : '' },
    playwright: { chromium: { launch: async () => browser } },
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, URL, URLSearchParams, AbortController,
    require: (name) => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
    setTimeout(callback, ms) {
      const timer = setTimeout(() => { activeTimers.delete(timer); callback(); }, ms);
      activeTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) { activeTimers.delete(timer); clearTimeout(timer); },
    fetch: async (path, init) => {
      state.probes++;
      const url = new URL(path, 'https://www.douyin.com');
      assert.equal(matcher(url), true);
      assert.equal(matcher(new URL('https://www.douyin.com/aweme/v1/web/comment/publish')), false);
      assert.equal(init.method, 'POST');
      assert.equal(new URLSearchParams(init.body).get('aweme_id'), '0');
      await handler(requestRoute(init.method, init.body));
      return {};
    },
  };
  vm.runInNewContext(compiled, sandbox);
  return { ...module.exports, page, state, activeTimers, fakeCookie, handler: () => handler, requestRoute };
}

test('ready ticket guard is captured without startup sleep, and its route and timers are removed', async () => {
  const f = fixture();
  const result = await f.extractTicketGuardFromPage(f.page, { skipNavigate: true, timeoutMs: 1000 });
  await Promise.resolve();
  assert.equal(result.clientData, 'offline-client');
  assert.equal(result.sessionFingerprint, `hash:${f.fakeCookie}`);
  assert.equal(f.state.probes, 1);
  assert.equal(f.state.fulfilled, 1);
  assert.equal(f.state.removed, 1);
  assert.equal(f.activeTimers.size, 0);
});

test('missing ticket guard headers trigger further local probes until the SDK is ready', async () => {
  const f = fixture({ readyAfter: 3 });
  assert.ok(await f.extractTicketGuardFromPage(f.page, { skipNavigate: true, timeoutMs: 2000 }));
  assert.equal(f.state.probes, 3);
  assert.equal(f.state.fulfilled, 3);
  assert.equal(f.state.removed, 1);
  assert.equal(f.activeTimers.size, 0);
});

test('a hanging evaluate is bounded by the total deadline and still removes the route', async () => {
  const f = fixture({ hangEvaluate: true });
  const start = Date.now();
  assert.equal(await f.extractTicketGuardFromPage(f.page, { skipNavigate: true, timeoutMs: 25 }), null);
  assert.ok(Date.now() - start < 1000);
  assert.equal(f.state.removed, 1);
  assert.equal(f.activeTimers.size, 0);
});

test('an SDK that never adds headers times out and clears its pending retry timer', async () => {
  const f = fixture({ readyAfter: Infinity });
  assert.equal(await f.extractTicketGuardFromPage(f.page, { skipNavigate: true, timeoutMs: 300 }), null);
  assert.ok(f.state.probes >= 2);
  assert.equal(f.state.fulfilled, f.state.probes);
  assert.equal(f.state.removed, 1);
  assert.equal(f.activeTimers.size, 0);
});

test('navigation failure removes the probe route and timeout', async () => {
  const f = fixture({ failAt: 'goto' });
  assert.equal(await f.extractTicketGuardFromPage(f.page, { timeoutMs: 1000 }), null);
  assert.equal(f.state.removed, 1);
  assert.equal(f.activeTimers.size, 0);
});

test('probe matcher requires exact origin, endpoint and unique marker', () => {
  const f = fixture();
  assert.equal(f.isTicketGuardProbe(new URL('https://www.douyin.com/aweme/v1/web/comment/publish?__sprr_ticket_guard_probe=marker'), 'marker'), true);
  assert.equal(f.isTicketGuardProbe(new URL('https://other.invalid/aweme/v1/web/comment/publish?__sprr_ticket_guard_probe=marker'), 'marker'), false);
  assert.equal(f.isTicketGuardProbe(new URL('https://www.douyin.com/aweme/v1/web/comment/publish-extra?__sprr_ticket_guard_probe=marker'), 'marker'), false);
  assert.equal(f.isTicketGuardProbe(new URL('https://www.douyin.com/aweme/v1/web/comment/publish?__sprr_ticket_guard_probe=another'), 'marker'), false);
});

test('even with a matching marker, real video comments and non-POST requests are untouched', async () => {
  const f = fixture({ hangEvaluate: true });
  const pending = f.extractTicketGuardFromPage(f.page, { skipNavigate: true, timeoutMs: 50 });
  await Promise.resolve();
  await f.handler()(f.requestRoute('POST', 'aweme_id=12345'));
  await f.handler()(f.requestRoute('GET', 'aweme_id=0'));
  assert.equal(f.state.fallback, 2);
  assert.equal(f.state.fulfilled, 0);
  await pending;
});

test('browser resources are recovered after failure at every initialization stage', async () => {
  for (const failAt of ['context', 'init', 'page', 'goto']) {
    const f = fixture({ failAt });
    assert.equal(await f.autoExtractTicketGuard('offline-state', { timeoutMs: 1000 }), null);
    assert.equal(f.state.browserClosed, 1, failAt);
    assert.equal(f.state.contextClosed, failAt === 'context' ? 0 : 1, failAt);
    assert.equal(f.activeTimers.size, 0, failAt);
  }
});

test('automatic extraction binds the returned configuration and optional callback to current browser cookies', async () => {
  const f = fixture();
  let updatedCookie;
  const result = await f.autoExtractTicketGuard('offline-state', {
    timeoutMs: 1000, onCookieUpdated: (cookie) => { updatedCookie = cookie; },
  });
  assert.equal(updatedCookie, 'sessionid=offline-auth');
  assert.equal(result.sessionFingerprint, `hash:${updatedCookie}`);
  assert.equal(f.state.browserClosed, 1);
  assert.equal(f.state.contextClosed, 1);
  assert.equal(f.activeTimers.size, 0);
});
