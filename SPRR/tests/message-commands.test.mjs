import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import ts from 'typescript';

// Execute the command module with local substitutes for every network/session dependency.
// No real account state is imported, and unexpected imports fail closed.
const source = fs.readFileSync(new URL('../src/commands/message-cmds.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const mediaCompiled = ts.transpileModule(fs.readFileSync(new URL('../src/commands/media-cmds.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const contactA = { uid: '200', nickname: '甲', conversationId: '0:1:100:200', conversationShortId: '1200' };
const contactB = { uid: '300', nickname: '乙', conversationId: '0:1:100:300', conversationShortId: '1300' };
const message = (id, extra = {}) => ({
  msgId: id, serverMsgId: id, conversationId: contactA.conversationId,
  senderId: '200', senderLabel: '对方', isSelf: false, isFromRobot: false,
  messageType: 7, category: 'text', text: 'hi', contentJson: '{"text":"hi"}', ...extra,
});

function fixture(options = {}) {
  const calls = { run: [], contacts: [], history: [], pages: [], quote: [], recall: [], once: [], fetch: [], mkdir: [], buildUrl: [], browser: [], media: [] };
  const errors = [];
  const cache = new Map();
  const recalled = new Set();
  let current = options.current ?? null;
  let generation = 0;
  let snapshot = null;
  const cacheMessages = (_env, cid, messages) => {
    for (const m of messages) {
      const key = `${cid}/${m.serverMsgId}`;
      if (m.category === 'recall') recalled.add(key);
      if (!recalled.has(key)) cache.set(key, { cid, message: { ...m } });
    }
  };
  const getCachedMessage = (_env, id, cid) => {
    const matches = [...cache.values()].filter((entry) => entry.message.serverMsgId === id &&
      (!cid || cid === entry.cid) && !recalled.has(`${entry.cid}/${id}`));
    return matches.length === 1 ? matches[0] : null;
  };
  const env = { cookie: 'offline-test-only' };
  const result = { success: true, serverMsgId: '9000' };
  const context = {
    run: async (fn) => {
      calls.run.push(true);
      if (options.sessionChanged) { generation++; current = null; cache.clear(); }
      return fn({ env, session: {} });
    },
    getContacts: async (_env, opts) => { calls.contacts.push(opts); return [{ ...contactA }, { ...contactB }]; },
    resolveTarget: async (_env, target, _myUid, contacts) => {
      const found = contacts.find((c) => [c.uid, c.nickname, c.conversationId].includes(target));
      return found && { ...found, ticket: '' };
    },
    getStatePathForBrowser: async () => { calls.browser.push('state'); return 'offline-state'; },
    loadAliases: async () => ({}),
    buildPrivateCid: (myUid, uid) => `0:1:${myUid}:${uid}`,
    detectMyUid: () => '100',
    getMyUid: () => { if (options.unknownMyUid) throw new Error('无法确定当前账号数字 UID'); return '100'; },
    getCurrentConversation: () => current,
    setCurrentConversation: (contact) => { current = contact; },
    recordContactList: (contacts) => { snapshot = contacts; },
    resolveCommandTargetName: (to) => to ?? current?.conversationId ?? null,
    captureCommandTarget: (to, ref) => {
      const explicit = to?.trim();
      const name = explicit || (ref && getCachedMessage(env, ref)?.cid) || current?.conversationId;
      return name ? { name, implicit: !explicit, sessionGeneration: generation } : null;
    },
    confirmCommandTarget: (selection) => {
      if (selection.implicit && selection.sessionGeneration !== generation) throw new Error('登录态已变化');
      return selection.name;
    },
    cacheMessages,
    getCachedMessage,
    getCachedReference: (id) => getCachedMessage(env, id),
    markMessageRecalled: (_env, cid, id) => { recalled.add(`${cid}/${id}`); },
    isMessageRecalled: (_env, cid, id) => recalled.has(`${cid}/${id}`),
  };
  const operations = {
    sendMessage: async () => result,
    sendImage: async () => result,
    sendSticker: async () => result,
    sendQuoteReply: async (...args) => { calls.quote.push(args); return result; },
    recallMessage: async (...args) => { calls.recall.push(args); return result; },
    getHistory: async (...args) => {
      calls.history.push(args);
      if (options.historyError) throw new Error('offline history failure');
      return options.history ?? [message('800')];
    },
    getHistoryAll: async (...args) => { calls.history.push(args); return options.history ?? [message('800')]; },
    getHistoryEx: async (...args) => {
      calls.pages.push(args);
      return options.pages?.[calls.pages.length - 1] ?? { messages: [], hasMore: false, nextCursor: 0n };
    },
  };
  const ui = {
    C: {}, catBox: () => {}, divider: () => '',
    output: (data, pretty) => pretty(data), formatMessageLine: () => '', formatTable: () => '',
  };
  const imports = {
    'node:path': path,
    'node:fs/promises': {
      mkdir: async (...args) => { calls.mkdir.push(args); },
      writeFile: async () => {},
      readFile: async () => { throw new Error('unexpected file read'); },
    },
    'node:crypto': {},
    '../utils/logger.js': { createLogger: () => ({ info: () => {}, warn: () => {}, error: (msg) => errors.push(msg) }) },
    '../config/paths.js': { DATA_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), 'offline-data') },
    '../cli/ui.js': ui,
    '../cli/context.js': context,
    '../api/operations.js': operations,
    '../api/webapi.js': {
      getReadOnceImage: async (...args) => { calls.once.push(args); return options.onceInfo ?? null; },
      buildImageUrl: async (...args) => { calls.buildUrl.push(args); return ['https://offline.invalid/plain']; },
      getVideoDetail: async (...args) => { calls.media.push(args); return []; },
      collectSticker: async (...args) => { calls.media.push(args); return true; },
    },
    '../api/tos.js': { uploadImage: async () => { throw new Error('unexpected upload'); } },
    '../crypto/ticket-guard.js': {},
    './ticket-guard-auto.js': {},
    './browser-comment.js': {},
    './capture-send.js': { captureSendRequests: async () => { throw new Error('unexpected capture'); } },
    './browser-send.js': {
      sendViaBrowser: async (...args) => { calls.browser.push(args); return result; },
      sendQuoteReplyViaBrowser: async (...args) => { calls.browser.push(args); calls.quote.push(args); return result; },
    },
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    require: (name) => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
    console: { log: () => {} }, Buffer,
    fetch: async (...args) => { calls.fetch.push(args); return { ok: false, status: 503 }; },
  };
  vm.runInNewContext(options.media ? mediaCompiled : compiled, sandbox);
  const execute = async (...args) => {
    const program = new Command().exitOverride();
    if (options.media) module.exports.registerMediaCommands(program);
    else module.exports.registerMessageCommands(program);
    await program.parseAsync(args, { from: 'user' });
  };
  return { calls, errors, execute, cacheMessages, env, getCurrent: () => current, getSnapshot: () => snapshot };
}

test('commands without a target/current conversation stop before contact requests or browser startup', async () => {
  for (const args of [
    ['send', '-t', 'hi'], ['send-image', '-i', 'missing.jpg'], ['send-sticker', '-s', 'missing.json'],
    ['reply', '-t', 'hi', '-r', '800'], ['history'], ['recall'],
  ]) {
    const f = fixture();
    await f.execute(...args);
    assert.equal(f.calls.contacts.length, 0, args[0]);
    assert.equal(f.calls.run.length, 0, args[0]);
    assert.equal(f.calls.browser.length, 0, args[0]);
    assert.ok(f.errors.some((error) => error.includes('未选择会话')), args[0]);
  }
});

test('implicit message targets stop before contacts or media access when run loads a changed session', async () => {
  for (const args of [
    ['send', '-t', 'hi'], ['send-image', '-i', 'missing.jpg'], ['send-sticker', '-s', 'missing.json'],
    ['reply', '-t', 'hi', '-r', '800'], ['history'], ['recall'],
  ]) {
    const f = fixture({ current: contactA, sessionChanged: true });
    await assert.rejects(f.execute(...args), /登录态已变化/);
    assert.equal(f.calls.contacts.length, 0, args[0]);
    assert.equal(f.calls.quote.length, 0, args[0]);
    assert.equal(f.calls.recall.length, 0, args[0]);
    assert.equal(f.calls.browser.length, 0, args[0]);
  }
});

test('a cached reference captured before account replacement cannot trigger reply on the new account', async () => {
  const f = fixture({ sessionChanged: true });
  f.cacheMessages(f.env, contactA.conversationId, [message('800')]);
  await assert.rejects(f.execute('reply', '-t', 'hi', '-r', '800', '--native'), /登录态已变化/);
  assert.equal(f.calls.contacts.length, 0);
  assert.equal(f.calls.pages.length, 0);
  assert.equal(f.calls.quote.length, 0);
});

test('explicit message targets remain deliberate selections after session replacement', async () => {
  const f = fixture({ current: contactB, sessionChanged: true });
  await f.execute('history', '--to', '甲');
  assert.equal(f.calls.history.length, 1);
  assert.equal(f.getCurrent().conversationId, contactA.conversationId);
});

test('media commands without an explicit/current target stop without loading authentication', async () => {
  for (const args of [['collect-sticker', '-m', '800'], ['video', '--aweme-id', '123']]) {
    const f = fixture({ media: true });
    await f.execute(...args);
    assert.equal(f.calls.run.length, 0);
    assert.equal(f.calls.contacts.length, 0);
  }
});

test('implicit media targets are rejected after session replacement before any request', async () => {
  for (const args of [['collect-sticker', '-m', '800'], ['video', '--aweme-id', '123']]) {
    const f = fixture({ media: true, current: contactA, sessionChanged: true });
    await assert.rejects(f.execute(...args), /登录态已变化/);
    assert.equal(f.calls.contacts.length, 0);
    assert.equal(f.calls.history.length, 0);
    assert.equal(f.calls.media.length, 0);
  }
});

test('explicit media targets remain valid after session replacement', async () => {
  const f = fixture({ media: true, current: contactB, sessionChanged: true });
  await f.execute('video', '--to', '甲', '--aweme-id', '123');
  assert.equal(f.calls.media.length, 1);
});

test('list refreshes the shared contact cache and records the displayed snapshot', async () => {
  const f = fixture();
  await f.execute('list');
  assert.equal(f.calls.contacts.length, 1);
  assert.equal(f.calls.contacts[0].refresh, true);
  assert.equal(f.getSnapshot()[0].uid, contactA.uid);
});

test('list --refresh-strangers forwards the explicit stranger refresh request', async () => {
  const f = fixture();
  await f.execute('list', '--refresh-strangers');
  assert.equal(f.calls.contacts[0].refresh, true);
  assert.equal(f.calls.contacts[0].refreshStrangers, true);
});

test('list may display contacts with unknown sender identity, while message operations fail closed', async () => {
  const list = fixture({ unknownMyUid: true });
  await list.execute('list');
  assert.equal(list.getSnapshot().length, 2);
  for (const args of [['history', '--to', '甲'], ['send', '--to', '甲', '-t', 'hi']]) {
    const f = fixture({ unknownMyUid: true });
    await assert.rejects(f.execute(...args), /无法确定当前账号数字 UID/);
    assert.equal(f.calls.history.length, 0);
    assert.equal(f.calls.browser.length, 0);
  }
});

test('history selects a conversation and reply reuses its complete cached message without fetching history', async () => {
  const f = fixture();
  await f.execute('history', '--to', '甲');
  assert.equal(f.getCurrent().conversationId, contactA.conversationId);
  await f.execute('reply', '-t', 'answer', '-r', '800', '--native');
  assert.equal(f.calls.history.length, 1);
  assert.equal(f.calls.pages.length, 0);
  assert.equal(f.calls.quote.length, 1);
  assert.equal(f.calls.quote[0][3].refmsgContent, '{"text":"hi"}');
  assert.equal(f.calls.quote[0][3].refmsgNickname, '甲');
});

test('a cached reference determines its conversation even without a current conversation', async () => {
  const f = fixture();
  f.cacheMessages(f.env, contactA.conversationId, [message('800')]);
  await f.execute('reply', '-t', 'answer', '-r', '800', '--native');
  assert.equal(f.calls.quote[0][1], contactA.conversationId);
  assert.equal(f.calls.pages.length, 0);
});

test('explicit reply target must match the cached reference conversation', async () => {
  const f = fixture({ current: contactB });
  f.cacheMessages(f.env, contactA.conversationId, [message('800')]);
  await f.execute('reply', '--to', '乙', '-t', 'answer', '-r', '800', '--native');
  assert.equal(f.calls.quote.length, 0);
  assert.equal(f.calls.pages.length, 0);
  assert.equal(f.calls.browser.length, 0);
  assert.ok(f.errors.some((error) => error.includes('不一致')));
});

test('reply searches older pages when a reference is not in the latest page', async () => {
  const f = fixture({ current: contactA, pages: [
    { messages: [message('900')], hasMore: true, nextCursor: 100n },
    { messages: [message('800')], hasMore: false, nextCursor: 50n },
  ] });
  await f.execute('reply', '-t', 'answer', '-r', '800', '--native');
  assert.equal(f.calls.pages.length, 2);
  assert.equal(f.calls.pages[0][2].direction, 3);
  assert.equal(f.calls.pages[1][2].direction, 1);
  assert.equal(f.calls.pages[1][2].cursor, 100n);
  assert.equal(f.calls.quote.length, 1);
});

test('reply stops a repeated cursor and does not send an absent reference', async () => {
  const f = fixture({ current: contactA, pages: [
    { messages: [message('900')], hasMore: true, nextCursor: 100n },
    { messages: [message('901')], hasMore: true, nextCursor: 100n },
  ] });
  await f.execute('reply', '-t', 'answer', '-r', '800', '--native');
  assert.equal(f.calls.pages.length, 2);
  assert.equal(f.calls.quote.length, 0);
});

test('reply limits an unsuccessful search to five pages', async () => {
  const f = fixture({ current: contactA, pages: Array.from({ length: 8 }, (_, i) => ({
    messages: [message(String(900 + i))], hasMore: true, nextCursor: BigInt(100 - i),
  })) });
  await f.execute('reply', '-t', 'answer', '-r', '800', '--native');
  assert.equal(f.calls.pages.length, 5);
  assert.equal(f.calls.quote.length, 0);
});

test('invalid history limits stop before contact requests', async () => {
  for (const limit of ['0', '-2', '30garbage', 'Infinity', '9007199254740992']) {
    const f = fixture();
    await f.execute('history', '--to', '甲', '--limit', limit);
    assert.equal(f.calls.contacts.length, 0);
    assert.ok(f.errors.some((error) => error.includes('正整数')));
  }
});

test('failed history preserves the previously selected conversation', async () => {
  const f = fixture({ current: contactB, historyError: true });
  await assert.rejects(f.execute('history', '--to', '甲'), /offline history failure/);
  assert.equal(f.getCurrent().conversationId, contactB.conversationId);
});

const media = [
  message('801', { category: 'image', imageSkey: '00', contentJson: '{"oid":"plain"}' }),
  message('802', { category: 'image', isEncryptedImage: true }),
];

test('history defaults to metadata without consuming one-time images or downloading files', async () => {
  const f = fixture({ history: media });
  await f.execute('history', '--to', '甲');
  assert.equal(f.calls.once.length, 0);
  assert.equal(f.calls.buildUrl.length, 0);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.mkdir.length, 0);
});

test('--download-images downloads normal images and never consumes one-time images', async () => {
  const f = fixture({ history: media.map((m) => ({ ...m })) });
  await f.execute('history', '--to', '甲', '--download-images');
  assert.equal(f.calls.once.length, 0);
  assert.equal(f.calls.buildUrl.length, 1);
  assert.equal(f.calls.fetch.length, 1);
});

test('--download-images also handles ordinary images without an encryption key', async () => {
  const f = fixture({ history: [message('801', { category: 'image', stickerUrl: 'https://offline.invalid/plain' })] });
  await f.execute('history', '--to', '甲', '--download-images');
  assert.equal(f.calls.once.length, 0);
  assert.equal(f.calls.buildUrl.length, 0);
  assert.equal(f.calls.fetch.length, 1);
});

test('--read-once explicitly accesses one-time images without fetching normal media', async () => {
  const f = fixture({ history: media.map((m) => ({ ...m })), onceInfo: { largeUrl: 'https://offline.invalid/once', skey: '00', oid: 'once' } });
  await f.execute('history', '--to', '甲', '--read-once');
  assert.equal(f.calls.once.length, 1);
  assert.equal(f.calls.buildUrl.length, 0);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.fetch[0][0], 'https://offline.invalid/once');
});

test('recall chooses the newest own message and prevents subsequent cached quoting', async () => {
  const f = fixture({ current: contactA, history: [
    message('700', { isSelf: true, senderId: '100' }), message('800'),
    message('900', { isSelf: true, senderId: '100' }),
  ] });
  await f.execute('recall');
  assert.equal(f.calls.recall[0][2], '900');
  await f.execute('reply', '--to', '甲', '-t', 'answer', '-r', '900', '--native');
  assert.equal(f.calls.quote.length, 0);
  assert.equal(f.calls.pages.length, 0);
  assert.ok(f.errors.some((error) => error.includes('已撤回')));
});
