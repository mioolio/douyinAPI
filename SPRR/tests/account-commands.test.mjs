import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Command } from 'commander';
import ts from 'typescript';

// Read only source code; every account, session and filesystem dependency is replaced.
const source = fs.readFileSync(new URL('../src/commands/account-cmds.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const accountFile = (name) => path.resolve('offline-account-tests', `${name}.json`);

function fixture({ source = {}, current = 'C', deleteFails = false } = {}) {
  let defaultSource = { ...source };
  let currentAccount = current;
  const calls = { deleted: [], sources: [], cacheClears: 0, currentReads: 0, errors: [] };
  const unexpected = async () => assert.fail('unexpected filesystem/session operation');
  const imports = {
    'node:path': path,
    'node:fs/promises': { readFile: unexpected, writeFile: unexpected, mkdir: unexpected, unlink: unexpected },
    '../utils/logger.js': { createLogger: () => ({ info() {}, warn() {}, error: (...args) => calls.errors.push(args) }) },
    '../cli/ui.js': { C: {}, catBox() {} },
    '../cli/context.js': {
      cliState: { verbose: false, json: false, ...source },
      getDefaultSessionSource: () => ({ ...defaultSource }),
      clearCache: async () => { calls.cacheClears++; },
      setSessionSource: async (nextSource) => {
        defaultSource = { ...nextSource };
        calls.sources.push({ ...nextSource });
      },
      setCookie: unexpected, ensureSession: unexpected, loadAliases: unexpected, saveAliases: unexpected,
    },
    '../auth/accounts.js': {
      accountFile,
      getCurrentAccount: async () => { calls.currentReads++; return currentAccount; },
      deleteAccount: async (name) => {
        if (deleteFails) throw new Error('offline mock deletion failure');
        calls.deleted.push(name);
        if (currentAccount === name) currentAccount = null;
      },
      listAccounts: unexpected, setCurrentAccount: unexpected, validateAccountName() {},
    },
    '../auth/session.js': { sessionFromCookieString: unexpected },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
    console: { log() {} },
  });
  const execute = async (name, force = true) => {
    const program = new Command().exitOverride();
    module.exports.registerAccountCommands(program);
    await program.parseAsync(['logout', name, ...(force ? ['-f'] : [])], { from: 'user' });
  };
  return { calls, execute, getSource: () => ({ ...defaultSource }), getCurrent: () => currentAccount };
}

test('deleting unrelated saved B preserves persistent Cookie A and its active cache', async () => {
  const source = { cookie: 'uid_tt=fake-A; sessionid=offline-A' };
  const f = fixture({ source, current: 'C' });
  await f.execute('B');
  assert.deepEqual(f.calls.deleted, ['B']);
  assert.deepEqual(f.getSource(), source);
  assert.deepEqual(f.calls.sources, []);
  assert.equal(f.calls.cacheClears, 0);
  assert.equal(f.calls.currentReads, 0);
  assert.equal(f.getCurrent(), 'C');
});

test('deleting unrelated B preserves disk current C without clearing its cache', async () => {
  const f = fixture({ current: 'C' });
  await f.execute('B');
  assert.deepEqual(f.calls.deleted, ['B']);
  assert.deepEqual(f.calls.sources, []);
  assert.equal(f.calls.cacheClears, 0);
  assert.equal(f.getCurrent(), 'C');
});

test('deleting disk current C resets its source and awaits cache cleanup', async () => {
  const f = fixture({ current: 'C' });
  await f.execute('C');
  assert.deepEqual(f.calls.deleted, ['C']);
  assert.deepEqual(f.calls.sources, [{}]);
  assert.equal(f.calls.cacheClears, 1);
  assert.equal(f.getCurrent(), null);
});

test('deleting explicitly selected persistent account B clears that source even if disk current is C', async () => {
  const f = fixture({ source: { account: 'B' }, current: 'C' });
  await f.execute('B');
  assert.deepEqual(f.calls.deleted, ['B']);
  assert.deepEqual(f.calls.sources, [{}]);
  assert.deepEqual(f.getSource(), {});
  assert.equal(f.calls.cacheClears, 1);
  assert.equal(f.getCurrent(), 'C');
});

test('deleting an account backing the explicit default state file clears that source', async () => {
  const f = fixture({ source: { statePath: path.join('offline-account-tests', 'B.json') }, current: 'C' });
  await f.execute('B');
  assert.deepEqual(f.calls.sources, [{}]);
  assert.equal(f.calls.cacheClears, 1);
  assert.equal(f.getCurrent(), 'C');
});

test('deleting unrelated B preserves an explicit state file and its active cache', async () => {
  const source = { statePath: accountFile('A') };
  const f = fixture({ source, current: 'C' });
  await f.execute('B');
  assert.deepEqual(f.getSource(), source);
  assert.deepEqual(f.calls.sources, []);
  assert.equal(f.calls.cacheClears, 0);
});

test('missing force and failed deletion leave both source and cache unchanged', async () => {
  const source = { cookie: 'uid_tt=fake-A; sessionid=offline-A' };
  const unconfirmed = fixture({ source });
  await unconfirmed.execute('B', false);
  assert.deepEqual(unconfirmed.calls.deleted, []);
  assert.deepEqual(unconfirmed.calls.sources, []);
  assert.equal(unconfirmed.calls.cacheClears, 0);
  const failed = fixture({ source: { account: 'B' }, deleteFails: true });
  await failed.execute('B');
  assert.deepEqual(failed.getSource(), { account: 'B' });
  assert.deepEqual(failed.calls.sources, []);
  assert.equal(failed.calls.cacheClears, 0);
  assert.ok(failed.calls.errors.some((args) => args[0] === '删除账号失败'));
});
