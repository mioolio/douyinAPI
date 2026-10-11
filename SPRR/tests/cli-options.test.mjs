import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProgram, configureReplOptions, setReplOutputDefaults } from '../dist/indexv2.js';
import { cliState, getDefaultSessionSource, setSessionSource } from '../dist/cli/context.js';

const fakeCookie = 'uid_tt=test-only; sessionid=fake';
const entry = fileURLToPath(new URL('../dist/indexv2.js', import.meta.url));

test('standalone output options persist, while inline options only override one command', async () => {
  setReplOutputDefaults({ verbose: false, json: false });
  assert.equal(await configureReplOptions(['--verbose', '--json']), true);
  assert.equal(createProgram().opts().verbose, true);
  assert.equal(createProgram().opts().json, true);
  const command = createProgram();
  await command.parseAsync(['--no-verbose', '--no-json', '--cookie', fakeCookie, 'whoami'], { from: 'user' });
  assert.equal(command.opts().verbose, false);
  assert.equal(command.opts().json, false);
  assert.equal(cliState.verbose, true);
  assert.equal(cliState.json, true);
  assert.equal(await configureReplOptions(['--no-verbose', '--no-json']), true);
  assert.equal(createProgram().opts().verbose, false);
  assert.equal(createProgram().opts().json, false);
  assert.equal(await configureReplOptions(['reply', '-r', '1', '-t', 'x']), false);
  await setSessionSource({});
});

test('standalone source options set the REPL default with explicit precedence', async () => {
  await setSessionSource({});
  assert.equal(await configureReplOptions(['--account', 'fake-account']), true);
  assert.deepEqual(getDefaultSessionSource(), { account: 'fake-account' });
  assert.equal(await configureReplOptions(['--account', 'fake-account', '--state', 'fake-file']), true);
  assert.deepEqual(getDefaultSessionSource(), { statePath: 'fake-file' });
  assert.equal(await configureReplOptions(['--state', 'fake-file', '--cookie', fakeCookie]), true);
  assert.deepEqual(getDefaultSessionSource(), { cookie: fakeCookie });
  await setSessionSource({});
});

test('startup global options reach the REPL and a startup subcommand runs once', () => {
  const env = { ...process.env, SPRR_LOG_LEVEL: 'info' };
  const repl = spawnSync(process.execPath, [entry, '--cookie', fakeCookie, '--json'], {
    input: 'whoami\nexit\n', encoding: 'utf8', timeout: 10_000, env,
  });
  assert.equal(repl.status, 0, repl.stderr);
  assert.match(repl.stdout, /"uid": "test-only"/);
  assert.match(repl.stdout, /再见/);
  assert.doesNotMatch(repl.stderr, /ENOENT|POST https:/);
  const once = spawnSync(process.execPath, [entry, '--cookie', fakeCookie, '--json', 'whoami'], {
    input: '', encoding: 'utf8', timeout: 10_000, env,
  });
  assert.equal(once.status, 0, once.stderr);
  assert.deepEqual(JSON.parse(once.stdout), { current: '(直接 Cookie)', uid: 'test-only', hasSessionid: true });
  assert.doesNotMatch(once.stdout, /REPL 模式|◆ sprr/);
});

test('standalone REPL toggles affect later commands and help exits successfully', () => {
  const result = spawnSync(process.execPath, [entry, '--cookie', fakeCookie], {
    input: '--json\nwhoami\n--no-json\nwhoami\nexit\n', encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, SPRR_LOG_LEVEL: 'info' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/"uid": "test-only"/g) || []).length, 1);
  assert.match(result.stderr, /当前账号/);
  const help = spawnSync(process.execPath, [entry, '--help'], { input: '', encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: sprr/);
  assert.doesNotMatch(help.stderr, /启动失败/);
  const version = spawnSync(process.execPath, [entry, '--version'], { input: '', encoding: 'utf8', timeout: 10_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.0.1');
  assert.doesNotMatch(version.stderr, /启动失败/);
});
