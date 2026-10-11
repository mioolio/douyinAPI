import test from 'node:test';
import assert from 'node:assert/strict';
import { createSenderPool } from '../dist/commands/sender-pool.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('concurrent callers share a launch; failed partial launches are closed and retryable', async () => {
  const instances = [];
  const pool = createSenderPool(() => {
    const sender = {
      closed: 0,
      async launch() { if (instances.length === 1) throw new Error('SDK timeout'); },
      async close() { this.closed++; },
    };
    instances.push(sender);
    return sender;
  });
  await assert.rejects(pool.get('a'), /SDK timeout/);
  assert.equal(instances[0].closed, 1);
  assert.equal(pool.isReady(), false);
  const [a, b] = await Promise.all([pool.get('a'), pool.get('a')]);
  assert.equal(a, b);
  assert.equal(instances.length, 2);
  await pool.close();
  assert.equal(instances[1].closed, 1);
});

test('a different account waits for launch and closes it before launching its own instance', async () => {
  const gate = deferred();
  const started = deferred();
  const events = [];
  const pool = createSenderPool((path) => ({
    path,
    async launch() { events.push(`launch ${path}`); if (path === 'a') { started.resolve(); await gate.promise; } },
    async close() { events.push(`close ${path}`); },
  }));
  const a = pool.get('a');
  const b = pool.get('b');
  await started.promise;
  assert.deepEqual(events, ['launch a']);
  gate.resolve();
  assert.equal((await a).path, 'a');
  assert.equal((await b).path, 'b');
  assert.deepEqual(events, ['launch a', 'close a', 'launch b']);
  await pool.close();
});

test('get never returns an instance whose close is in progress', async () => {
  const closing = deferred();
  let launches = 0;
  const pool = createSenderPool(() => ({
    id: ++launches,
    async launch() {},
    async close() { if (this.id === 1) await closing.promise; },
  }));
  const previous = await pool.get('a');
  const close = pool.close();
  assert.equal(pool.isReady(), false);
  let returned = false;
  const next = pool.get('a').then((sender) => { returned = true; return sender; });
  await Promise.resolve();
  assert.equal(returned, false);
  closing.resolve();
  await close;
  assert.notEqual(await next, previous);
  await pool.close();
});

test('disconnected senders and headless changes are replaced', async () => {
  const senders = [];
  const pool = createSenderPool((path, headless) => {
    const sender = {
      headless, alive: true, closed: false,
      async launch() {}, async close() { this.closed = true; },
      isAlive() { return this.alive; },
    };
    senders.push(sender);
    return sender;
  });
  const first = await pool.get('a');
  first.alive = false;
  assert.equal(pool.isReady(), false);
  const second = await pool.get('a');
  assert.notEqual(second, first);
  assert.equal(first.closed, true);
  const third = await pool.get('a', false);
  assert.equal(second.closed, true);
  assert.equal(third.headless, false);
  await pool.close();
});
