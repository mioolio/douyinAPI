import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Keep all browser, filesystem, and API activity inside explicit offline substitutes.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/commands/login.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function fixture(options = {}) {
  const calls = { access: [], reads: [], launch: [], contexts: [], saved: [], selected: [], navigation: [], cookieReads: 0, storageStateCalls: 0, prematureExports: 0, probes: 0, disposed: 0, closed: 0 };
  let now = 0;
  let loginCookieObserved = false;
  class MockDate extends Date { static now() { return now; } }
  const oldState = {
    cookies: [{ name: 'sessionid', value: 'offline-old', domain: '.douyin.com' }],
    origins: [{ origin: 'https://www.douyin.com', localStorage: [{ name: 'offline-key', value: 'offline-old' }] }],
  };
  const freshState = {
    cookies: [{ name: options.cookieName ?? 'sessionid', value: options.sameCookie ? 'offline-old' : 'offline-fresh', domain: options.cookieDomain ?? '.douyin.com' }],
    origins: [{ origin: 'https://www.douyin.com', localStorage: [{ name: 'offline-key', value: 'offline-fresh' }] }],
  };
  const page = {
    async goto(url) { calls.navigation.push(url); if (options.navigationFailure) throw new Error('offline navigation cancelled'); },
    url: () => 'https://www.douyin.com/',
    async waitForTimeout(ms) {
      if (options.cancelDuringWait) throw new Error('offline scan window closed');
      now += ms;
    },
  };
  const context = {
    async addInitScript() {},
    async newPage() { return page; },
    async cookies() {
      calls.cookieReads++;
      if (options.timeout || options.cancelDuringWait || calls.cookieReads <= (options.waitRounds ?? 0)) return [];
      loginCookieObserved = freshState.cookies.some((cookie) =>
        ['sessionid', 'sessionid_ss'].includes(cookie.name) && cookie.value &&
        (cookie.domain === 'douyin.com' || cookie.domain.endsWith('.douyin.com')));
      return freshState.cookies;
    },
    async storageState() {
      calls.storageStateCalls++;
      if (!loginCookieObserved) calls.prematureExports++;
      assert.ok(loginCookieObserved, 'waiting for a scan must read cookies only, never export localStorage through temporary pages');
      return freshState;
    },
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const imports = {
    playwright: {
      chromium: { async launch(options) {
        calls.launch.push(options);
        return {
          async newContext(options) { calls.contexts.push(options); return context; },
          async close() { calls.closed++; },
        };
      } },
      request: { async newContext() {
        calls.probes++;
        return { storageState: async () => oldState, dispose: async () => { calls.disposed++; } };
      } },
    },
    'node:fs/promises': {
      access: async (file) => { calls.access.push(file); },
      readFile: async (file) => { calls.reads.push(file); return JSON.stringify(oldState); },
    },
    '../auth/accounts.js': {
      validateAccountName: (name) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('账号名非法'); },
      accountFile: (name) => `offline-accounts/${name}.json`,
      saveAccountStorageState: async (...args) => calls.saved.push(args),
      setCurrentAccount: async (name) => calls.selected.push(name),
    },
    '../utils/logger.js': { createLogger: () => logger },
    '../api/imapi.js': {}, '../crypto/protobuf.js': {}, '../api/operations.js': {},
    './session-validation.js': { probeSession: async () => options.verdict ?? { status: 'invalid', reason: 'offline expired session' } },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Date: MockDate, URL,
    require: (name) => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
  });
  return { login: module.exports.loginAccount, calls, oldState, freshState };
}

test('--oc starts a clean context and restores Chromium popup blocking even for an existing account', async () => {
  // A cookie matching the previous saved value is still new in the clean context.
  const f = fixture({ sameCookie: true });
  await f.login('offline', { oc: true, timeout: 500 });
  assert.equal(f.calls.reads.length, 0, 'forced login never reads or imports old cookies/localStorage');
  assert.equal(f.calls.probes, 0);
  assert.equal(f.calls.contexts.length, 1);
  assert.equal(f.calls.contexts[0].storageState, undefined);
  assert.deepEqual([...f.calls.launch[0].ignoreDefaultArgs], ['--disable-popup-blocking']);
  assert.equal(f.calls.launch[0].args.includes('--disable-popup-blocking'), false);
  assert.deepEqual(f.calls.saved, [['offline', f.freshState]]);
  assert.deepEqual(f.calls.selected, ['offline']);
  assert.deepEqual(f.calls.navigation, ['https://www.douyin.com/'], 'successful scan does not navigate to a video to extract signatures');
  assert.equal(f.calls.cookieReads, 1);
  assert.equal(f.calls.storageStateCalls, 1);
  assert.equal(f.calls.closed, 1);
});

test('cancelled navigation keeps the existing account and closes the login browser', async () => {
  const f = fixture({ navigationFailure: true });
  await assert.rejects(f.login('offline', { oc: true, timeout: 500 }), /offline navigation cancelled/);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.selected.length, 0);
  assert.equal(f.calls.storageStateCalls, 0);
  assert.equal(f.calls.closed, 1);
});

test('scan timeout keeps the account file and current account unchanged', async () => {
  const f = fixture({ timeout: true });
  await assert.rejects(f.login('offline', { oc: true, timeout: 500 }), /登录超时/);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.selected.length, 0);
  assert.ok(f.calls.cookieReads > 1, 'the timeout exercises multiple cookie polls');
  assert.equal(f.calls.storageStateCalls, 0);
  assert.equal(f.calls.prematureExports, 0);
  assert.equal(f.calls.closed, 1);
});

test('a definitely invalid saved session falls back to a clean scan context before saving the fresh state', async () => {
  const f = fixture();
  await f.login('offline', { timeout: 500 });
  assert.equal(f.calls.reads.length, 1);
  assert.equal(f.calls.probes, 1);
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.contexts[0].storageState, undefined);
  assert.deepEqual(f.calls.saved, [['offline', f.freshState]]);
  assert.equal(f.calls.navigation.length, 1);
  assert.equal(f.calls.storageStateCalls, 1);
  assert.equal(f.calls.closed, 1);
});

test('an unavailable session check preserves the account without opening a scan window', async () => {
  const f = fixture({ verdict: { status: 'unavailable', reason: 'offline network failure' } });
  await assert.rejects(f.login('offline'), /暂时无法验证登录态/);
  assert.equal(f.calls.launch.length, 0);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.selected.length, 0);
  assert.equal(f.calls.disposed, 1);
});

test('exported login entrypoint rejects invalid account names before reading files or launching Chromium', async () => {
  const f = fixture();
  await assert.rejects(f.login('../invalid', { oc: true }), /账号名非法/);
  assert.equal(f.calls.access.length, 0);
  assert.equal(f.calls.reads.length, 0);
  assert.equal(f.calls.launch.length, 0);
  assert.equal(f.calls.saved.length, 0);
});

test('sessionid_ss can complete a scan, while another domain cannot supply a login Cookie', async () => {
  const secure = fixture({ cookieName: 'sessionid_ss' });
  await secure.login('offline', { oc: true, timeout: 500 });
  assert.deepEqual(secure.calls.saved, [['offline', secure.freshState]]);
  const foreign = fixture({ cookieDomain: 'douyin.com.unrelated.test' });
  await assert.rejects(foreign.login('offline', { oc: true, timeout: 500 }), /登录超时/);
  assert.equal(foreign.calls.saved.length, 0);
  assert.equal(foreign.calls.storageStateCalls, 0);
});

test('multiple scan-wait rounds use only cookies, followed by a single state export after success', async () => {
  const f = fixture({ waitRounds: 3 });
  await f.login('offline', { oc: true, timeout: 2000 });
  assert.equal(f.calls.cookieReads, 4);
  assert.equal(f.calls.storageStateCalls, 1);
  assert.equal(f.calls.prematureExports, 0);
  assert.deepEqual(f.calls.saved, [['offline', f.freshState]]);
  assert.equal(f.calls.closed, 1);
});

test('closing the scan window during a wait never exports state or replaces the account', async () => {
  const f = fixture({ cancelDuringWait: true });
  await assert.rejects(f.login('offline', { oc: true, timeout: 1000 }), /offline scan window closed/);
  assert.equal(f.calls.cookieReads, 1);
  assert.equal(f.calls.storageStateCalls, 0);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.selected.length, 0);
  assert.equal(f.calls.closed, 1);
});
