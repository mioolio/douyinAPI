import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Command } from 'commander';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const mediaSource = compile(fs.readFileSync(new URL('../src/commands/media-cmds.ts', import.meta.url), 'utf8'));
// Disable only the standalone entrypoint; the real V1 registration and session-selection helpers run.
const v1Source = compile(fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  .replace(/program\.parseAsync\(process\.argv\)\.catch\([\s\S]*$/, 'exports.getProgram = () => program;'));

function fixture(version, options = {}) {
  const calls = { browser: [], api: [], state: [], writes: [], boxes: [], logs: [], errors: [], warnings: [], resolve: [] };
  const fakeProcess = { env: {}, exitCode: undefined };
  const cookie = 'uid_tt=offline-user; sessionid=offline-session';
  const env = { cookie };
  const result = options.result ?? { success: true, commentId: '1234567890123456789' };
  const logger = { info: () => {}, debug: () => {}, error: (value) => calls.errors.push(value), warn: (value) => calls.warnings.push(value) };
  const log = { createLogger: () => logger };
  const webapi = { publishComment: async (...args) => { calls.api.push(args); return result; } };
  const browser = { publishCommentViaBrowser: async (...args) => {
    calls.browser.push(args);
    if (options.throwPublish) throw new Error('offline transport interrupted');
    return result;
  } };
  const ui = { C: { gray: '', reset: '' }, catBox: (value) => calls.boxes.push(value) };
  const context = {
    run: async (fn) => fn({ env, session: { cookie } }),
    cliState: { json: Boolean(options.json) },
    getStatePathForBrowser: async () => { calls.state.push(true); return 'offline-selected-state'; },
  };
  const mediaImports = {
    '../utils/logger.js': log,
    '../cli/ui.js': ui,
    '../cli/context.js': context,
    '../api/webapi.js': webapi,
    '../api/operations.js': {},
    './browser-comment.js': browser,
  };
  const evaluate = (source, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, exports: module.exports,
      require: (name) => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
      console: { log: (value) => calls.logs.push(value) }, process: fakeProcess,
    });
    return module.exports;
  };
  const media = evaluate(mediaSource, mediaImports);
  let program;
  if (version === 'v2') {
    program = new Command().exitOverride();
    media.registerMediaCommands(program);
  } else {
    const imports = {
      commander: { Command }, 'node:path': path, 'node:crypto': {},
      'node:fs/promises': {
        mkdir: async () => {},
        writeFile: async (...args) => calls.writes.push(args),
      },
      './utils/logger.js': log, './config/paths.js': { DATA_DIR: 'offline-data' },
      './auth/session.js': {
        sessionFromCookieString: (value) => ({ cookie: value }),
        loadFromStorageState: async (statePath) => { calls.state.push(statePath); return { cookie }; },
      },
      './auth/accounts.js': {
        resolveStorageState: async (...args) => { calls.resolve.push(args); return { path: 'offline-selected-state' }; },
      },
      './api/operations.js': { envFromSession: (session) => ({ cookie: session.cookie }) },
      './api/webapi.js': webapi, './crypto/ticket-guard.js': {}, './api/tos.js': {}, './api/frontier.js': {},
      './commands/extract-ws-key.js': {}, './commands/ticket-guard-auto.js': {},
      './commands/media-cmds.js': media,
    };
    program = evaluate(v1Source, imports).getProgram().exitOverride();
  }
  const execute = (...args) => program.parseAsync(version === 'v1' && options.json ? ['--json', ...args] : args, { from: 'user' });
  return { calls, fakeProcess, execute, cookie, commands: program.commands.map((command) => command.name()) };
}

for (const version of ['v1', 'v2']) {
  test(`${version}: default comments use the selected browser session once and return JSON`, async () => {
    const f = fixture(version, { json: true });
    await f.execute('comment', '--aweme-id', '123', '--text', '测试正文', '--reply-id', '0');
    assert.equal(f.calls.browser.length, 1);
    assert.equal(f.calls.browser[0][0], 'offline-selected-state');
    assert.equal(f.calls.browser[0][1].replyId, '0');
    assert.equal(f.calls.api.length, 0);
    assert.deepEqual(JSON.parse(f.calls.logs[0]), { success: true, commentId: '1234567890123456789' });
    assert.deepEqual(f.calls.boxes, []);
  });

  test(`${version}: partial signatures, invalid IDs/text, and invalid mentions stop before transport`, async () => {
    for (const args of [
      ['--aweme-id', 'x', '--text', 'hi'],
      ['--aweme-id', '123', '--text', '   '],
      ['--aweme-id', '123', '--text', 'hi', '--reply-id', 'x'],
      ['--aweme-id', '123', '--text', 'hi', '--ticket-guard-client-data', 'partial'],
      ['--aweme-id', '123', '--text', 'hi', '--at-uid', '1'],
      ['--aweme-id', '123', '--text', '@1 hi', '--at-uid', '1,2', '--at-sec-uid', 'sec1'],
      ['--aweme-id', '123', '--text', '@10 hi', '--at-uid', '1', '--at-sec-uid', 'sec1'],
      ['--aweme-id', '123', '--text', 'hi', '--at-uid', '1', '--at-sec-uid', 'sec1'],
    ]) {
      const f = fixture(version, { json: true });
      await f.execute('comment', ...args);
      assert.equal(f.calls.browser.length, 0, JSON.stringify(args));
      assert.equal(f.calls.api.length, 0, JSON.stringify(args));
      assert.equal(f.calls.writes.length, 0, JSON.stringify(args));
      assert.equal(f.fakeProcess.exitCode, 1);
      assert.equal(JSON.parse(f.calls.logs[0]).outcome, 'rejected');
      assert.ok(JSON.parse(f.calls.logs[0]).reason);
    }
  });

  test(`${version}: complete manual headers use only the API and preserve mention offsets`, async () => {
    const f = fixture(version);
    await f.execute('comment', '--aweme-id', '123', '--text', '你好 @1 和 @2',
      '--at-uid', '11,22', '--at-sec-uid', 'sec11,sec22',
      '--ticket-guard-client-data', 'client', '--ticket-guard-ree-public-key', 'key', '--tt-session-dtrait', 'dtrait');
    assert.equal(f.calls.browser.length, 0);
    assert.equal(f.calls.api.length, 1);
    assert.equal(f.calls.api[0][0].cookie, f.cookie);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.api[0][1].textExtra)), [
      { user_id: '11', sec_uid: 'sec11', type: 0, start: 3, end: 5 },
      { user_id: '22', sec_uid: 'sec22', type: 0, start: 8, end: 10 },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.api[0][2])), { clientData: 'client', reePublicKey: 'key', sessionDtrait: 'dtrait' });
  });

  test(`${version}: rejected and unknown results retain reasons/status without retrying`, async () => {
    for (const outcome of ['rejected', 'unknown']) {
      const result = { success: false, reason: 'offline refusal', statusCode: 1234, httpStatus: 200, outcome };
      const f = fixture(version, { json: true, result });
      await f.execute('comment', '--aweme-id', '123', '--text', 'hi');
      assert.equal(f.calls.browser.length, 1);
      assert.deepEqual(JSON.parse(f.calls.logs[0]), result);
      assert.ok(f.calls.errors.some((message) => message.includes(result.reason)));
      assert.equal(f.calls.warnings.some((message) => message.includes('避免重复发布')), outcome === 'unknown');
      assert.equal(f.fakeProcess.exitCode, 1);
    }
  });
}

test('V1 direct cookie comments create a matching browser state instead of selecting the default account', async () => {
  const f = fixture('v1');
  assert.ok(f.commands.includes('ticket-guard'), 'other V1 commands remain registered');
  await f.execute('--cookie', f.cookie, 'comment', '--aweme-id', '123', '--text', 'hi');
  assert.equal(f.calls.resolve.length, 0);
  assert.equal(f.calls.writes.length, 1);
  const state = JSON.parse(f.calls.writes[0][1]);
  assert.deepEqual(state.cookies.map(({ name, value }) => [name, value]), [
    ['uid_tt', 'offline-user'], ['sessionid', 'offline-session'],
  ]);
  assert.equal(f.calls.browser[0][0], f.calls.writes[0][0]);
});

test('transport exceptions produce an unknown result with no automatic second attempt', async () => {
  const f = fixture('v2', { json: true, throwPublish: true });
  await f.execute('comment', '--aweme-id', '123', '--text', 'hi');
  assert.equal(f.calls.browser.length, 1);
  assert.equal(JSON.parse(f.calls.logs[0]).outcome, 'unknown');
  assert.match(JSON.parse(f.calls.logs[0]).reason, /offline transport interrupted/);
  assert.ok(f.calls.warnings.some((message) => message.includes('避免重复发布')));
});
