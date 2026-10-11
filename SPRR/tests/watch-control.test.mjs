import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchControl, watchControl, stopWatchOrClose, waitForWatchStop } from '../dist/cli/watch-control.js';
import { CommandQueue } from '../dist/cli/command-queue.js';
import { createProgram } from '../dist/indexv2.js';

test('Ctrl+C stops the active watch without closing readline or invoking unrelated process handlers', () => {
  const control = new WatchControl();
  let closed = 0;
  let stopped = 0;
  let unrelated = 0;
  const otherListener = () => { unrelated++; };
  process.on('SIGINT', otherListener);
  try {
    control.start();
    control.registerStop(() => { stopped++; });
    stopWatchOrClose(() => { closed++; }, control);
    assert.equal(stopped, 1);
    assert.equal(closed, 0);
    assert.equal(unrelated, 0);
    control.finish();
    stopWatchOrClose(() => { closed++; }, control);
    assert.equal(closed, 1);
  } finally {
    process.removeListener('SIGINT', otherListener);
  }
});

test('EOF requests a watch stop before draining the serialized command queue', async () => {
  const queue = new CommandQueue();
  const control = new WatchControl();
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const events = [];
  const command = queue.enqueue(async () => {
    control.start();
    const unregister = control.registerStop(stop);
    started();
    await stopped;
    events.push('cleanup');
    unregister();
    control.finish();
  });
  await active;
  control.requestStop(); // readline close/EOF handler
  await queue.drain();
  await command;
  assert.deepEqual(events, ['cleanup']);
});

test('an EOF received before queued watch starts is remembered and cancels initialization', async () => {
  const program = createProgram(() => watchControl.requestStop());
  let initialized = false;
  const command = program.commands.find((command) => command.name() === 'watch');
  command.action(async () => { if (!watchControl.stopRequested) initialized = true; });
  try {
    await program.parseAsync(['watch'], { from: 'user' });
    assert.equal(initialized, false);
    assert.equal(watchControl.active, false);
  } finally {
    watchControl.finish();
  }
});

test('Ctrl+C can stop a mocked watch and the next REPL command still executes', async () => {
  const queue = new CommandQueue();
  const program = createProgram();
  let ready;
  const active = new Promise((resolve) => { ready = resolve; });
  const events = [];
  program.commands.find((command) => command.name() === 'watch').action(async () => {
    ready();
    await waitForWatchStop(() => { events.push('watch-cleaned'); });
  });
  program.command('after-test').action(() => { events.push('next-command'); });
  const watching = queue.enqueue(() => program.parseAsync(['watch'], { from: 'user' }).then(() => undefined));
  await active;
  stopWatchOrClose(() => assert.fail('Ctrl+C must keep readline usable'));
  const next = queue.enqueue(() => program.parseAsync(['after-test'], { from: 'user' }).then(() => undefined));
  await Promise.all([watching, next]);
  assert.deepEqual(events, ['watch-cleaned', 'next-command']);
  assert.equal(watchControl.active, false);
});

test('WS lifecycle waits for cleanup and removes only its own SIGINT listener', async () => {
  const baseline = process.listenerCount('SIGINT');
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const events = [];
  watchControl.start();
  let complete = false;
  const watching = waitForWatchStop(async () => {
    events.push('connection closed');
    await cleanupGate; // outstanding replies remain bound to this account
    events.push('AI sender detached');
  }).then(() => { complete = true; });
  assert.equal(process.listenerCount('SIGINT'), baseline + 1);
  watchControl.requestStop();
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(process.listenerCount('SIGINT'), baseline);
  releaseCleanup();
  await watching;
  watchControl.finish();
  assert.deepEqual(events, ['connection closed', 'AI sender detached']);
});
