import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cliState, setCookie, setSessionSource, ensureSession, clearCache,
  applyCommandSessionSource, restoreCommandSessionSource,
  setCurrentConversation, getCurrentConversation, recordContactList,
  resolveTarget, resolveCommandTargetName,
  captureCommandTarget, confirmCommandTarget,
} from '../dist/cli/context.js';

const env = { cookie: 'uid_tt=fake; sessionid=test-only' };
const contact = (uid, nickname) => ({
  uid, nickname, conversationId: `0:1:100:${uid}`, conversationShortId: `900${uid}`,
  lastMessage: '',
});

test('session changes do not reuse old cookies; temporary overrides restore REPL defaults', async () => {
  await setCookie('uid_tt=account-a; sessionid=fake-a');
  const first = await ensureSession();
  setCurrentConversation(contact('1', 'first'));
  await applyCommandSessionSource({ cookie: 'uid_tt=account-b; sessionid=fake-b' });
  assert.equal(getCurrentConversation(), null);
  assert.equal((await ensureSession()).session.uid, 'account-b');
  await restoreCommandSessionSource();
  assert.equal((await ensureSession()).session.uid, 'account-a');
  assert.notEqual((await ensureSession()).env.cookie, 'uid_tt=account-b; sessionid=fake-b');
  await applyCommandSessionSource({ account: 'test-not-read' });
  assert.equal(cliState.cookie, undefined, 'explicit account overrides persistent cookie');
  assert.equal(cliState.account, 'test-not-read');
  await restoreCommandSessionSource();
  assert.equal((await ensureSession()).session.uid, first.session.uid);
  await setSessionSource({});
  await clearCache();
});

test('targets reject ambiguous names and bind # indices to the last displayed list', async () => {
  await clearCache();
  const contacts = [contact('1', '同名'), contact('2', '同名')];
  await assert.rejects(resolveTarget(env, '同名', '100', contacts), /匹配多个会话/);
  assert.equal(resolveCommandTargetName(), null);
  await assert.rejects(resolveTarget(env, undefined, '100', contacts), /选择会话/);
  recordContactList(contacts);
  assert.equal((await resolveTarget(env, '#2', '100', [...contacts].reverse())).uid, '2');
  await assert.rejects(resolveTarget(env, '#3', '100', contacts), /无效会话序号/);
  setCurrentConversation(contacts[1]);
  assert.equal(resolveCommandTargetName(), contacts[1].conversationId);
  await clearCache();
  await assert.rejects(resolveTarget(env, '#1', '100', contacts), /无效会话序号/);
});

test('a same-path storageState replacement invalidates a captured implicit target', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sprr-target-session-'));
  const statePath = path.join(directory, 'offline-state.json');
  const state = (uid) => JSON.stringify({ cookies: [
    { name: 'uid_tt', value: uid, domain: '.douyin.com', path: '/' },
    { name: 'sessionid', value: `offline-${uid}`, domain: '.douyin.com', path: '/' },
  ], origins: [] });
  try {
    await fs.writeFile(statePath, state('account-a'));
    await setSessionSource({ statePath });
    assert.equal(captureCommandTarget(), null, 'missing targets stay entirely local');
    await ensureSession();
    setCurrentConversation(contact('200', 'peer'));
    const implicit = captureCommandTarget();
    const explicit = captureCommandTarget('200');
    assert.equal(confirmCommandTarget(implicit), '0:1:100:200');
    // A different size ensures the source fingerprint changes even on a coarse filesystem clock.
    await fs.writeFile(statePath, state('account-b-replacement'));
    assert.equal((await ensureSession()).session.uid, 'account-b-replacement');
    assert.equal(getCurrentConversation(), null);
    assert.throws(() => confirmCommandTarget(implicit), /登录态已变化/);
    assert.equal(confirmCommandTarget(explicit), '200');
  } finally {
    await setSessionSource({});
    await clearCache();
    await fs.unlink(statePath);
    await fs.rmdir(directory);
  }
});
