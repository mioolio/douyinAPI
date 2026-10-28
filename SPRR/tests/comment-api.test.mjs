import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommentPublishBody, parseCommentPublishResponse, publishComment, validateCommentOptions,
} from '../dist/api/webapi.js';

const options = { awemeId: '7666440815748969905', text: '中文 +&=\n😀' };
const guard = { clientData: 'offline-client', reePublicKey: 'offline-public-key', sessionDtrait: 'offline-dtrait' };
const env = { cookie: 'sessionid=offline-test-only; msToken=offline-token' };

test('top-level comment forms normalize omitted, empty and zero reply IDs', () => {
  for (const replyId of [undefined, '', '0', ' 0 ']) {
    const form = new URLSearchParams(buildCommentPublishBody({ ...options, replyId }));
    assert.equal(form.get('one_level_comment_rank'), '-1');
    assert.equal(form.has('reply_id'), false);
    assert.equal(form.get('text'), options.text);
    assert.equal(form.get('aweme_id'), options.awemeId);
  }
});

test('replies retain full string IDs and mention metadata', () => {
  const textExtra = [{ user_id: '100', sec_uid: 'sec-offline', type: 0, start: 0, end: 2 }];
  const form = new URLSearchParams(buildCommentPublishBody({
    ...options, text: '@1 很好看', replyId: ' 7666440815748969906 ', textExtra,
  }));
  assert.equal(form.get('one_level_comment_rank'), '1');
  assert.equal(form.get('reply_id'), '7666440815748969906');
  assert.deepEqual(JSON.parse(form.get('text_extra')), textExtra);
});

test('invalid video IDs, empty text, invalid reply IDs and invalid mentions are rejected', () => {
  for (const opts of [
    { ...options, awemeId: '0' }, { ...options, awemeId: 'video-url' },
    { ...options, text: '  \n ' }, { ...options, replyId: 'NaN' },
    { ...options, textExtra: [{ user_id: '100', sec_uid: 'sec', start: 0, end: 0 }] },
  ]) assert.ok(validateCommentOptions(opts));
});

test('only a successful response with a real comment ID is confirmed', () => {
  const result = parseCommentPublishResponse(200, '{"status_code":0,"comment":{"cid":"7666440815748969907"}}');
  assert.equal(result.success, true);
  assert.equal(result.commentId, '7666440815748969907');
  for (const body of [
    '{"status_code":0,"comment":{"cid":"0"}}', '{"status_code":0}', 'null', '[]',
    '{"comment":{"cid":"123"}}', '{"status_code":0,"comment":{"cid":7666440815748969907}}',
  ]) {
    const failure = parseCommentPublishResponse(200, body);
    assert.equal(failure.success, false, body);
    assert.equal(failure.outcome, 'unknown', body);
  }
});

test('platform rejection retains status code, HTTP status and the actual reason', () => {
  const result = parseCommentPublishResponse(403, '{"status_code":8,"status_msg":"该视频不允许评论"}');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.statusCode, 8);
  assert.equal(result.httpStatus, 403);
  assert.match(result.reason, /该视频不允许评论/);
});

test('empty, non-JSON and HTTP error responses remain uncertain', () => {
  for (const [status, body] of [[200, ''], [200, '  '], [502, '<html>bad gateway</html>'], [500, '{"status_code":0,"comment":{"cid":"123"}}']]) {
    const result = parseCommentPublishResponse(status, body);
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.httpStatus, status);
    assert.match(result.reason, /无法确认/);
  }
});

const verifyHeader = JSON.stringify({
  event_params: { verify_scene: 'comment', verify_reason: 'gateway_biz_verify_with_face' },
  verify_way_name_list: 'mobile_sms_verify,qr_code_verify',
});

test('empty 200 with the verify decision header is rejected as verification-required (captured 20261028)', () => {
  const result = parseCommentPublishResponse(200, '', verifyHeader);
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.verify.scene, 'comment');
  assert.equal(result.verify.reason, 'gateway_biz_verify_with_face');
  assert.deepEqual(result.verify.ways, ['mobile_sms_verify', 'qr_code_verify']);
  assert.match(result.reason, /身份验证/);
  assert.equal(parseCommentPublishResponse(200, '', 'not-json').verify.reason, 'unparseable');
  assert.equal(parseCommentPublishResponse(200, '', '  ').outcome, 'unknown', 'no header keeps the uncertain outcome');
});

test('manual-header API forwards the verify decision header channel', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', {
    status: 200, headers: { 'x-tt-verify-passport-decision': verifyHeader },
  });
  try {
    const result = await publishComment(env, options, guard);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.verify.scene, 'comment');
    assert.match(result.reason, /身份验证/);
  } finally { globalThis.fetch = originalFetch; }
});

test('manual-header API sends the normalized form once and keeps the platform response', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, request) => {
    requests.push({ url: new URL(url), request });
    return new Response('{"status_code":8,"status_msg":"评论权限受限"}', { status: 200 });
  };
  try {
    const result = await publishComment(env, { ...options, replyId: '0' }, guard);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, '/aweme/v1/web/comment/publish');
    assert.equal(requests[0].request.headers.cookie, env.cookie);
    assert.equal(requests[0].request.headers['bd-ticket-guard-client-data'], guard.clientData);
    assert.equal(new URLSearchParams(requests[0].request.body).get('one_level_comment_rank'), '-1');
    assert.equal(result.statusCode, 8);
    assert.match(result.reason, /评论权限受限/);
  } finally { globalThis.fetch = originalFetch; }
});

test('validation and incomplete manual headers stop before any network request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('invalid input must not send a request');
  try {
    assert.equal((await publishComment(env, { ...options, text: ' ' }, guard)).outcome, 'rejected');
    const result = await publishComment(env, options, {});
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /签名头/);
  } finally { globalThis.fetch = originalFetch; }
});

test('empty and network-failed submissions are never retried', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const fail of [false, true]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (fail) throw new Error('offline connection lost');
        return new Response('');
      };
      const result = await publishComment(env, options, guard);
      assert.equal(calls, 1);
      assert.equal(result.success, false);
      assert.equal(result.outcome, 'unknown');
    }
  } finally { globalThis.fetch = originalFetch; }
});
