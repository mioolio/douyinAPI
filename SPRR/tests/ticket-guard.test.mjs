import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Load only the source under test. Filesystem access is in-memory; no account
// files, browser sessions, or network implementations are reachable here.
const source = fs.readFileSync(new URL('../src/crypto/ticket-guard.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const NOW = Date.UTC(2026, 9, 26, 4);
const baseConfig = () => ({
  clientData: 'offline-client-data',
  reePublicKey: 'offline-public-key',
  sessionDtrait: 'offline-session-trait',
  capturedAt: NOW,
  capturedFrom: 'offline-test',
});

function fixture(files = {}) {
  const dataDir = path.resolve('offline-ticket-guard-data');
  const storage = new Map(Object.entries(files));
  const writes = [];
  const imports = {
    'node:crypto': { createHash },
    'node:path': path,
    'node:fs/promises': {
      async mkdir() {},
      async readFile(file) {
        if (!storage.has(file)) throw Object.assign(new Error('offline missing file'), { code: 'ENOENT' });
        return storage.get(file);
      },
      async readdir(dir) {
        return [...storage.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file));
      },
      async writeFile(file, text) { storage.set(file, text); writes.push({ file, text }); },
    },
    '../config/paths.js': { DATA_DIR: dataDir },
    '../utils/logger.js': { createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
  };
  class OfflineDate extends Date { static now() { return NOW; } }
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Date: OfflineDate,
    require(name) { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
  });
  return { api: module.exports, writes, storage, dataDir };
}

test('session binding survives cookie order, whitespace and SDK token rotation', () => {
  const { api } = fixture();
  const first = 'sessionid=offline-login; uid_tt=42; msToken=old; bd_ticket_guard_client_data_v2=old';
  const rotated = 'bd_ticket_guard_client_data_v2=new; msToken=new; uid_tt = 42 ; sessionid = offline-login';
  const fingerprint = api.ticketGuardSessionFingerprint(first);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(api.ticketGuardSessionFingerprint(rotated), fingerprint);
  assert.equal(api.isTicketGuardForSession({ ...baseConfig(), sessionFingerprint: fingerprint }, rotated), true);
  assert.equal(fingerprint.includes('offline-login'), false);
});

test('a new login or another account cannot use saved signing headers', () => {
  const { api } = fixture();
  const cookie = 'sessionid=offline-a; sessionid_ss=offline-b; sid_tt=offline-c; uid_tt=42';
  const config = { ...baseConfig(), sessionFingerprint: api.ticketGuardSessionFingerprint(cookie) };
  for (const changed of [
    cookie.replace('sessionid=offline-a', 'sessionid=another-login'),
    cookie.replace('sessionid_ss=offline-b', 'sessionid_ss=another-login'),
    cookie.replace('sid_tt=offline-c', 'sid_tt=another-session'),
    cookie.replace('uid_tt=42', 'uid_tt=43'),
  ]) assert.equal(api.isTicketGuardForSession(config, changed), false, changed);
});

test('legacy and empty bindings fail closed; fallback cookies are canonical', () => {
  const { api } = fixture();
  assert.equal(api.isTicketGuardForSession(baseConfig(), 'sessionid=offline-login'), false);
  assert.equal(api.ticketGuardSessionFingerprint(' ; broken ; =invalid ;'), '');
  assert.equal(api.isTicketGuardForSession({ ...baseConfig(), sessionFingerprint: '' }, ''), false);
  assert.equal(api.ticketGuardSessionFingerprint('beta=2; alpha=1'), api.ticketGuardSessionFingerprint(' alpha=1 ; beta=2'));
  assert.notEqual(api.ticketGuardSessionFingerprint('beta=2; alpha=1'), api.ticketGuardSessionFingerprint('beta=3; alpha=1'));
});

test('invalid, missing, future and old capture times are expired', () => {
  const { api } = fixture();
  for (const capturedAt of [undefined, null, '', '1780000000000', NaN, Infinity, -Infinity, 0, -1, NOW + 1]) {
    assert.equal(api.isTicketGuardExpired({ ...baseConfig(), capturedAt }), true, String(capturedAt));
  }
  assert.equal(api.isTicketGuardExpired({ ...baseConfig(), capturedAt: NOW - 24 * 60 * 60 * 1000 - 1 }), true);
  assert.equal(api.isTicketGuardExpired({ ...baseConfig(), capturedAt: NOW - 1000 }), false);
  assert.equal(api.isTicketGuardExpired(baseConfig()), false);
});

test('manual save binds to the supplied session without persisting raw cookies', async () => {
  const { api, writes } = fixture();
  const cookie = 'sessionid=offline-private-cookie; uid_tt=42; msToken=offline-private-token';
  const original = { ...baseConfig(), sessionFingerprint: 'old-binding' };
  await api.saveTicketGuard(original, cookie);
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0].text);
  assert.equal(api.isTicketGuardForSession(saved, cookie), true);
  assert.equal(original.sessionFingerprint, 'old-binding', 'saving should not mutate the caller config');
  assert.equal(writes[0].text.includes('offline-private-cookie'), false);
  assert.equal(writes[0].text.includes('offline-private-token'), false);
  await api.saveTicketGuard(saved);
  assert.equal(JSON.parse(writes[1].text).sessionFingerprint, saved.sessionFingerprint);
});

test('capture import binds signing headers to the captured request cookie', async () => {
  const captureDir = path.resolve('offline-capture');
  const filename = '0001_POST__aweme_v1_web_comment_publish_offline.json';
  const cookie = 'sessionid=offline-captured-login; uid_tt=42';
  const record = {
    ts: new Date(NOW).toISOString(),
    request: { headers: {
      'bd-ticket-guard-client-data': 'offline-client-data',
      'bd-ticket-guard-ree-public-key': 'offline-public-key',
      'x-tt-session-dtrait': 'offline-session-trait', cookie,
    } },
  };
  const { api } = fixture({ [path.join(captureDir, filename)]: JSON.stringify(record) });
  const captured = await api.extractTicketGuardFromCapture(captureDir);
  assert.ok(captured);
  assert.equal(api.isTicketGuardForSession(captured, cookie), true);
  assert.equal(api.isTicketGuardForSession(captured, 'sessionid=another-login; uid_tt=42'), false);
  assert.equal(captured.capturedAt, NOW);
  assert.equal(JSON.stringify(captured).includes('offline-captured-login'), false);
});

test('capture import without request cookies remains unbound', async () => {
  const captureDir = path.resolve('offline-capture');
  const filename = '0002_POST__aweme_v1_web_comment_publish_offline.json';
  const { api } = fixture({ [path.join(captureDir, filename)]: JSON.stringify({
    ts: new Date(NOW).toISOString(),
    request: { headers: {
      'bd-ticket-guard-client-data': 'offline-client-data',
      'bd-ticket-guard-ree-public-key': 'offline-public-key',
      'x-tt-session-dtrait': 'offline-session-trait',
    } },
  }) });
  const captured = await api.extractTicketGuardFromCapture(captureDir);
  assert.ok(captured);
  assert.equal(api.isTicketGuardForSession(captured, 'sessionid=offline-current-login'), false);
});
