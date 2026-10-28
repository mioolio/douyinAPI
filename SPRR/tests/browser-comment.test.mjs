import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as webapi from '../dist/api/webapi.js';
import { isTicketGuardForSession, ticketGuardSessionFingerprint } from '../dist/crypto/ticket-guard.js';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/commands/browser-comment.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const opts = { awemeId: '7100000000000000001', text: '离线验证 +&😀', replyId: '0' };

function fixture(options = {}) {
  const calls = { requests: [], xhrCreated: 0, fetchCalls: 0, cookieReads: 0, closedContext: 0, closedBrowser: 0, probes: 0, readiness: 0, launched: 0 };
  const events = new Map();
  const guard = {
    clientData: 'current-client-data', reePublicKey: 'current-key', sessionDtrait: 'current-dtrait',
    sessionFingerprint: ticketGuardSessionFingerprint('sessionid=offline-session'),
  };
  const nativeUrl = new URL(`https://www.douyin.com/aweme/v1/web/aweme/detail/?${new URLSearchParams({
    aweme_id: opts.awemeId, uid: 'native-endpoint-uid', notice_id: 'native-endpoint-notice',
    device_platform: 'webapp', webid: '1234567890123456789', uifid: 'offline-native-uifid',
    browser_version: '149.0.0.0', engine_version: '149.0.0.0', screen_width: '1536',
    a_bogus: 'native-get-signature', msToken: 'native-get-token', verifyFp: 'native-get-fp', fp: 'native-get-fp',
  })}`);
  const detailResponse = {
    url: () => nativeUrl.href,
    status: () => options.detailHttpStatus ?? 200,
    ok: () => (options.detailHttpStatus ?? 200) >= 200 && (options.detailHttpStatus ?? 200) < 300,
    async json() {
      if (options.invalidDetailJson) throw new Error('offline malformed detail JSON');
      return options.detail ?? { status_code: 0, aweme_detail: { aweme_id: opts.awemeId } };
    },
  };
  const page = {
    on(event, handler) { events.set(event, handler); },
    async waitForResponse(predicate, waitOptions) {
      calls.detailWaiter = true;
      assert.equal(waitOptions.timeout, 15000);
      assert.equal(predicate(detailResponse), true);
      assert.equal(predicate({ url: () => nativeUrl.href.replace(opts.awemeId, '123') }), false);
      if (options.detailMissing) throw new Error('offline detail timeout');
      return detailResponse;
    },
    async goto(url) {
      calls.videoPage = url;
      assert.equal(calls.detailWaiter, true, 'target detail listener must be installed before navigation');
      if (options.navigationFails) throw new Error('offline navigation failed');
      if (!options.noNativeTemplate) {
        for (const request of options.nativeRequests ?? [{ url: nativeUrl.href, method: 'GET' }]) {
          events.get('request')?.({ method: () => request.method, url: () => request.url });
        }
      }
    },
    async evaluate(fn, args) {
      if (options.hang) return new Promise(() => {});
      // Execute the actual callback against local XHR events; no browser or network is used.
      class MockXMLHttpRequest {
        constructor() {
          calls.xhrCreated++;
          this.headers = {};
        }
        open(method, url, async) {
          this.method = method;
          this.url = new URL(url, 'https://www.douyin.com');
          this.async = async;
        }
        setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
        getResponseHeader(name) { return options.responseHeaders?.[String(name).toLowerCase()] ?? null; }
        send(body) {
          calls.requests.push({ url: this.url, request: {
            method: this.method, async: this.async, headers: this.headers, body,
            withCredentials: this.withCredentials, timeout: this.timeout,
          } });
          if (options.xhrEvent) {
            this[`on${options.xhrEvent}`]();
            return;
          }
          this.status = options.httpStatus ?? 200;
          this.responseText = options.body ?? '{"status_code":0,"comment":{"cid":"7100000000000000003"}}';
          this.onload();
        }
      }
      const sandbox = {
        args, URLSearchParams, XMLHttpRequest: MockXMLHttpRequest,
        navigator: { userAgent: 'Chrome/130.0.0.0', language: 'zh-CN', platform: 'Win32' },
        screen: { width: 1400, height: 900 },
        fetch: () => { calls.fetchCalls++; assert.fail('browser comments must use the SDK XHR path'); },
      };
      return vm.runInNewContext(`(${fn.toString()})(args)`, sandbox);
    },
  };
  const context = {
    async addInitScript() {}, async newPage() { return page; },
    async cookies(origin) {
      assert.equal(origin, 'https://www.douyin.com/aweme/v1/web/comment/publish');
      calls.cookieReads++;
      return [
        ...(options.noSession ? [] : [{ name: 'sessionid', value: options.sessionChanged && calls.cookieReads > 1 ? 'replacement-session' : 'offline-session' }]),
        { name: 'msToken', value: calls.cookieReads === 1 ? 'old-token' : 'refreshed-token' },
        { name: 's_v_web_id', value: 'offline-fingerprint' },
      ];
    },
    async close() { calls.closedContext++; },
  };
  const browser = {
    async newContext(arg) {
      calls.contextOptions = arg;
      if (options.contextFails) throw new Error('offline context failed');
      return context;
    },
    async close() { calls.closedBrowser++; },
  };
  const imports = {
    playwright: { chromium: { async launch(arg) { calls.launched++; calls.launchOptions = arg; return browser; } } },
    '../api/imapi.js': { DEFAULT_UA: 'offline-browser-UA' },
    '../api/webapi.js': {
      ...webapi,
      buildCommentPublishParams: (env) => ({ ...webapi.buildCommentPublishParams(env), a_bogus: 'stale-offline-signature' }),
    },
    '../utils/logger.js': { createLogger: () => ({ info() {}, warn() {} }) },
    '../utils/browser-diagnostics.js': { createBrowserDiagnostics: () => () => {} },
    '../crypto/ticket-guard.js': { isTicketGuardForSession },
    './signature-ready.js': { async waitForSignatureReady(actualPage) {
      assert.equal(actualPage, page); calls.readiness++;
      if (options.unsigned) throw new Error('automatic signing unavailable');
    } },
    './ticket-guard-auto.js': { async extractTicketGuardFromPage(actualPage, arg) {
      assert.equal(actualPage, page); assert.equal(arg.skipNavigate, true); calls.probes++;
      return options.noGuard ? null : guard;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URL,
    require: (name) => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name]; },
    setTimeout: options.hang ? (fn) => setTimeout(fn, 1) : setTimeout,
    clearTimeout,
    fetch: () => assert.fail('Node fetch must not submit browser comments'),
  });
  return { calls, guard, publish: (data = opts) => module.exports.publishCommentViaBrowser('offline-current-account.json', data) };
}

test('default publication opens the exact video page and delegates current signatures to the SDK', async () => {
  const f = fixture();
  const result = await f.publish();
  assert.equal(result.success, true);
  assert.equal(f.calls.contextOptions.storageState, 'offline-current-account.json');
  assert.equal(f.calls.videoPage, `https://www.douyin.com/video/${opts.awemeId}`);
  assert.equal(f.calls.launchOptions.headless, true);
  assert.equal(f.calls.readiness, 1);
  assert.equal(f.calls.probes, 1);
  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.xhrCreated, 1);
  assert.equal(f.calls.fetchCalls, 0);
  const { url, request } = f.calls.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.async, true);
  assert.equal(url.pathname, '/aweme/v1/web/comment/publish');
  assert.equal(url.searchParams.get('webid'), '1234567890123456789');
  assert.equal(url.searchParams.get('uifid'), 'offline-native-uifid');
  assert.equal(request.headers.uifid, url.searchParams.get('uifid'));
  assert.equal(url.searchParams.get('enter_from'), 'video_detail');
  assert.equal(url.searchParams.get('previous_page'), 'video_detail');
  assert.equal(url.searchParams.get('browser_version'), '149.0.0.0', 'native version is not overwritten with navigator.userAgent');
  assert.equal(url.searchParams.get('engine_version'), '149.0.0.0');
  assert.equal(url.searchParams.get('screen_width'), '1536', 'native screen dimensions are preserved');
  for (const key of ['uid', 'aweme_id', 'notice_id']) assert.equal(url.searchParams.has(key), false, 'endpoint-specific parameters cannot leak into publish');
  for (const key of ['a_bogus', 'msToken', 'verifyFp', 'fp']) {
    assert.equal(url.searchParams.has(key), false, `${key} must be supplied once by the live SDK`);
  }
  assert.equal(request.withCredentials, true);
  assert.equal(request.timeout, 30000);
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(request.headers['x-secsdk-csrf-token'], 'DOWNGRADE');
  assert.equal(request.headers.cookie, undefined);
  for (const key of [
    'bd-ticket-guard-client-data', 'bd-ticket-guard-ree-public-key', 'x-tt-session-dtrait',
    'bd-ticket-guard-version', 'bd-ticket-guard-web-sign-type', 'bd-ticket-guard-web-version',
  ]) {
    assert.equal(request.headers[key], undefined, 'SDK-owned headers must not be supplied twice');
  }
  assert.equal(new URLSearchParams(request.body).get('text'), opts.text);
  assert.equal(new URLSearchParams(request.body).has('reply_id'), false);
  assert.equal(f.calls.closedContext, 1);
  assert.equal(f.calls.closedBrowser, 1);
});

test('invalid options stop before launching the browser', async () => {
  const f = fixture();
  const result = await f.publish({ ...opts, text: ' ' });
  assert.equal(result.outcome, 'rejected');
  assert.equal(f.calls.launched, 0);
});

test('uifid is retained across requests for the same device and required before publishing', async () => {
  const base = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&webid=123';
  const f = fixture({ nativeRequests: [
    { method: 'GET', url: `${base}&uifid=offline-uifid` },
    { method: 'GET', url: base },
  ] });
  assert.equal((await f.publish()).success, true);
  assert.equal(f.calls.requests[0].request.headers.uifid, 'offline-uifid');
  for (const nativeRequests of [
    [{ method: 'GET', url: base }],
    [{ method: 'GET', url: `${base}&uifid=offline-uifid` }, { method: 'GET', url: base.replace('webid=123', 'webid=456') }],
  ]) {
    const missing = fixture({ nativeRequests });
    assert.equal((await missing.publish()).outcome, 'rejected');
    assert.equal(missing.calls.requests.length, 0);
  }
});

test('a login change during signature initialization stops before submitting the comment', async () => {
  const f = fixture({ sessionChanged: true });
  const result = await f.publish();
  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason, /登录会话发生变化/);
  assert.equal(f.calls.requests.length, 0);
  assert.equal(f.calls.closedContext, 1);
  assert.equal(f.calls.closedBrowser, 1);
});

test('startup, login and signature failures send no real comment and close all created resources', async () => {
  for (const options of [{ contextFails: true }, { navigationFails: true }, { noSession: true }, { unsigned: true }, { noGuard: true }]) {
    const f = fixture(options);
    const result = await f.publish();
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /评论尚未提交/);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.closedContext, options.contextFails ? 0 : 1);
    assert.equal(f.calls.closedBrowser, 1);
  }
});

test('XHR submission is attempted once for empty responses, network errors, aborts, and timeouts', async () => {
  for (const options of [{ body: '' }, { xhrEvent: 'error' }, { xhrEvent: 'abort' }, { xhrEvent: 'timeout' }]) {
    const f = fixture(options);
    const result = await f.publish();
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.calls.xhrCreated, 1);
    assert.equal(f.calls.fetchCalls, 0);
    if (options.xhrEvent === 'error') assert.match(result.reason, /网络错误/);
    if (options.xhrEvent === 'abort') assert.match(result.reason, /中止/);
    if (options.xhrEvent === 'timeout') assert.match(result.reason, /超时/);
    assert.equal(f.calls.closedContext, 1);
    assert.equal(f.calls.closedBrowser, 1);
  }
});

test('a hanging page evaluation times out and closes its browser without retrying', async () => {
  const f = fixture({ hang: true });
  const result = await f.publish();
  assert.equal(result.outcome, 'unknown');
  assert.match(result.reason, /超时/);
  assert.equal(f.calls.closedContext, 1);
  assert.equal(f.calls.closedBrowser, 1);
});

test('platform rejection reason reaches the caller', async () => {
  const f = fixture({ httpStatus: 403, body: '{"status_code":8,"status_msg":"作者已关闭评论"}' });
  const result = await f.publish();
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.httpStatus, 403);
  assert.match(result.reason, /作者已关闭评论/);
  assert.equal(f.calls.requests.length, 1);
});

test('an empty 200 with the verify decision header is reported as verification-required (captured 20261028)', async () => {
  const f = fixture({
    body: '',
    responseHeaders: { 'x-tt-verify-passport-decision': JSON.stringify({
      event_params: { verify_scene: 'comment', verify_reason: 'gateway_biz_verify_with_face' },
      verify_way_name_list: 'mobile_sms_verify,qr_code_verify',
    }) },
  });
  const result = await f.publish();
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.verify.scene, 'comment');
  assert.deepEqual(result.verify.ways, ['mobile_sms_verify', 'qr_code_verify']);
  assert.match(result.reason, /身份验证/);
  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.xhrCreated, 1);
});

test('a deleted, private, restricted, or comment-disabled video is rejected before publication', async () => {
  for (const [detail, message] of [
    [{ status_code: 0, aweme_detail: null, filter_detail: { filter_reason: 'status_deleted' } }, /权限限制或已删除/],
    [{ status_code: 0, aweme_detail: null, filter_detail: { filter_reason: 'status_private' } }, /权限受限/],
    [{ status_code: 0, aweme_detail: { aweme_id: opts.awemeId, status: { is_delete: true } } }, /已删除/],
    [{ status_code: 0, aweme_detail: { aweme_id: opts.awemeId, status: { is_prohibited: true } } }, /访问限制/],
    [{ status_code: 0, aweme_detail: { aweme_id: opts.awemeId, status: { private_status: 1 } } }, /权限受限/],
    [{ status_code: 0, aweme_detail: { aweme_id: opts.awemeId, status: { allow_comment: false } } }, /已关闭评论/],
    [{ status_code: 0, aweme_detail: { aweme_id: opts.awemeId, aweme_control: { can_comment: false } } }, /已关闭评论/],
  ]) {
    const f = fixture({ detail });
    const result = await f.publish();
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, message);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.readiness, 0);
    assert.equal(f.calls.closedContext, 1);
    assert.equal(f.calls.closedBrowser, 1);
  }
});

test('detail HTTP/status errors, missing responses, malformed JSON, and wrong video IDs never submit', async () => {
  for (const options of [
    { detailHttpStatus: 403 },
    { detail: { status_code: 12, aweme_detail: null } },
    { detailMissing: true },
    { invalidDetailJson: true },
    { detail: { status_code: 0, aweme_detail: { aweme_id: '123' } } },
  ]) {
    const f = fixture(options);
    const result = await f.publish();
    assert.equal(result.outcome, 'rejected');
    assert.ok(result.reason);
    if (options.detailHttpStatus) assert.equal(result.httpStatus, 403);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.closedContext, 1);
    assert.equal(f.calls.closedBrowser, 1);
  }
});

test('an explicitly available native video allows publication without requiring legacy permission flags', async () => {
  const f = fixture({ detail: {
    status_code: 0, aweme_detail: {
      aweme_id: opts.awemeId,
      status: { is_delete: false, is_prohibited: false, private_status: 0 },
      aweme_control: { can_comment: true },
    },
  } });
  assert.equal((await f.publish()).success, true);
  assert.equal(f.calls.requests.length, 1);
});

test('publication requires a same-origin native webapp GET template with a nonzero webid', async () => {
  const base = 'https://www.douyin.com/aweme/v1/web/feed/?device_platform=webapp&webid=123';
  for (const options of [
    { noNativeTemplate: true },
    { nativeRequests: [{ method: 'POST', url: base }] },
    { nativeRequests: [{ method: 'GET', url: base.replace('www.douyin.com', 'unrelated.test') }] },
    { nativeRequests: [{ method: 'GET', url: base.replace('device_platform=webapp', 'device_platform=other') }] },
    { nativeRequests: [{ method: 'GET', url: base.replace('webid=123', 'webid=0') }] },
    { nativeRequests: [{ method: 'GET', url: base.replace('webid=123', 'webid=') }] },
  ]) {
    const f = fixture(options);
    const result = await f.publish();
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /webid/);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.closedContext, 1);
    assert.equal(f.calls.closedBrowser, 1);
  }
});
