import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CommandQueue } from '../dist/cli/command-queue.js';

test('queued commands execute serially and recover after a rejected action', async () => {
  const queue = new CommandQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.enqueue(async () => { events.push('a-start'); await gate; events.push('a-end'); });
  const second = queue.enqueue(async () => { events.push('b'); throw new Error('test failure'); });
  const rejected = assert.rejects(second, /test failure/);
  const third = queue.enqueue(async () => { events.push('c'); });
  await Promise.resolve();
  assert.deepEqual(events, ['a-start']);
  release();
  await Promise.all([first, rejected, third, queue.drain()]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b', 'c']);
});

test('REPL drains piped input and rejects missing recipients before account loading', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/indexv2.js', import.meta.url))], {
    input: 'help\nreply -t example -r 123\nexit\n', encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, SPRR_LOG_LEVEL: 'info' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /可用命令/);
  assert.match(result.stdout, /再见/);
  assert.match(result.stderr, /未选择会话/);
  assert.doesNotMatch(result.stderr, /storageState|POST https:|浏览器就绪|ENOENT/);
});
