/* 在 Node.js vm 中加载 bdms.js，检测它 hook 了哪些 API，并提取 hook 函数源码 */
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
let src = fs.readFileSync(file, 'utf-8');

// 不再 patch D（避免内存爆炸），改用 hook XMLHttpRequest.prototype 和 window.fetch
// 策略：在 bdms.js 加载前后，对比 XMLHttpRequest.prototype.open 和 window.fetch 是否被替换

// 补环境
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const _fakeElement = () => ({
  style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
  appendChild() {}, removeChild() {}, insertBefore() {}, replaceChild() {},
  setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; },
  removeAttribute() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return true; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  innerHTML: '', outerHTML: '', textContent: '', innerText: '',
  children: [], childNodes: [], parentNode: null, parentElement: null,
  firstChild: null, lastChild: null, nextSibling: null, previousSibling: null,
  nodeType: 1, nodeName: 'DIV', tagName: 'DIV',
  cloneNode() { return _fakeElement(); }, contains() { return false; },
  click() {}, focus() {}, blur() {},
});

const fakeDocument = {
  referrer: 'https://www.douyin.com/',
  cookie: '',
  all: {},
  addEventListener() {}, removeEventListener() {},
  createEvent() { return { initEvent() {} }; },
  createElement(tag) {
    if (tag === 'script') return Object.assign(_fakeElement(), { text: '', src: '', type: '', async: false, onload: null, onerror: null, tagName: 'SCRIPT', nodeName: 'SCRIPT' });
    if (tag === 'iframe') return Object.assign(_fakeElement(), { src: '', contentWindow: null, contentDocument: null, tagName: 'IFRAME', nodeName: 'IFRAME' });
    if (tag === 'a') return Object.assign(_fakeElement(), { href: '', host: '', hostname: '', pathname: '', protocol: '', search: '', hash: '', origin: '', tagName: 'A', nodeName: 'A' });
    if (tag === 'canvas') return Object.assign(_fakeElement(), { getContext() { return { fillRect() {}, clearRect() {}, getImageData() { return { data: [] }; }, measureText() { return { width: 0 }; }, arc() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {} }; }, toDataURL() { return 'data:,'; }, width: 0, height: 0, tagName: 'CANVAS', nodeName: 'CANVAS' });
    return Object.assign(_fakeElement(), { tagName: (tag || 'DIV').toUpperCase(), nodeName: (tag || 'DIV').toUpperCase() });
  },
  createElementNS(ns, tag) { return Object.assign(_fakeElement(), { namespaceURI: ns, tagName: tag, nodeName: tag }); },
  createTextNode(text) { return { nodeType: 3, nodeName: '#text', textContent: String(text), nodeValue: String(text), parentNode: null }; },
  createComment(text) { return { nodeType: 8, nodeName: '#comment', textContent: String(text), nodeValue: String(text) }; },
  createDocumentFragment() { return Object.assign(_fakeElement(), { nodeType: 11, nodeName: '#document-fragment' }); },
  createRange() { return { setStart() {}, setEnd() {}, selectNode() {}, selectNodeContents() {}, collapse() {}, cloneRange() { return this; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }, createContextualFragment(html) { return _fakeElement(); } }; },
  getSelection() { return { rangeCount: 0, toString() { return ''; }, addRange() {}, removeAllRanges() {} }; },
  getElementById() { return null; }, getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  documentElement: Object.assign(_fakeElement(), { clientWidth: 1400, clientHeight: 900, lang: 'zh-CN', tagName: 'HTML', nodeName: 'HTML' }),
  body: Object.assign(_fakeElement(), { clientWidth: 1400, clientHeight: 900, tagName: 'BODY', nodeName: 'BODY' }),
  head: Object.assign(_fakeElement(), { tagName: 'HEAD', nodeName: 'HEAD' }),
  title: '', readyState: 'complete', visibilityState: 'visible', hidden: false,
  hasFocus() { return true; }, activeElement: null,
  location: { href: 'https://www.douyin.com/', origin: 'https://www.douyin.com', protocol: 'https:', host: 'www.douyin.com', hostname: 'www.douyin.com', pathname: '/', search: '', hash: '' },
};

const fakeNavigator = {
  userAgent: UA, platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh'],
  onLine: true, hardwareConcurrency: 12, deviceMemory: 16, maxTouchPoints: 0,
  vendor: 'Google Inc.', appVersion: UA.replace('Mozilla/', ''), cookieEnabled: true,
  plugins: { length: 0 }, mimeTypes: { length: 0 },
  storage: { estimate: () => Promise.resolve({ quota: 0, usage: 0 }) },
  permissions: { query: () => Promise.resolve({ state: 'granted' }) },
  connection: { downlink: 10, effectiveType: '4g', rtt: 150, saveData: false },
  webdriver: false,
};

const fakeScreen = { width: 1400, height: 900, availWidth: 1400, availHeight: 900, colorDepth: 24, pixelDepth: 24 };
const fakeLocation = { href: 'https://www.douyin.com/', origin: 'https://www.douyin.com', protocol: 'https:', host: 'www.douyin.com', hostname: 'www.douyin.com', pathname: '/', search: '', hash: '' };

// 使用一个真实的可被 hook 的 XMLHttpRequest 实现
class RealXHR {
  constructor() {
    this.readyState = 0;
    this._method = '';
    this._url = '';
    this._headers = {};
    this.responseText = '';
    this.status = 0;
    this.response = null;
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.withCredentials = false;
    this.timeout = 0;
  }
  open(method, url) { this._method = method; this._url = url; this.readyState = 1; }
  setRequestHeader(k, v) { this._headers[k] = v; }
  send(body) {
    this._body = body;
    this.readyState = 4;
    this.status = 200;
    if (typeof this.onreadystatechange === 'function') { try { this.onreadystatechange(); } catch (_) {} }
    if (typeof this.onload === 'function') { try { this.onload(); } catch (_) {} }
  }
  abort() {}
  getAllResponseHeaders() { return ''; }
  getResponseHeader() { return null; }
  addEventListener() {}
  removeEventListener() {}
  overrideMimeType() {}
}

// 准备一个 fetch 实现，可以被替换
let _origFetch = function fetch(url, opts) {
  console.log('[hooked fetch] url=', typeof url === 'string' ? url.slice(0, 100) : url);
  return Promise.resolve({
    ok: true, status: 200, url: typeof url === 'string' ? url : '',
    headers: { get: () => null },
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
  });
};

const fakeWindow = {
  navigator: fakeNavigator, document: fakeDocument, screen: fakeScreen, location: fakeLocation,
  innerWidth: 1400, innerHeight: 900, outerWidth: 1400, outerHeight: 900, devicePixelRatio: 1,
  XMLHttpRequest: RealXHR,
  fetch: _origFetch,
  Reflect, Proxy, Promise, Date, Math, JSON,
  Array, Object, Function, Number, String, Boolean, RegExp, Error, Symbol,
  Map, Set, WeakMap, WeakSet,
  ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, DataView, TextEncoder, TextDecoder,
  URLSearchParams, URL, BigInt,
  DOMParser: class { parseFromString() { return { documentElement: {}, querySelector() { return null; } }; } },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, Element: function () {},
  DocumentFragment: function () {}, CustomEvent: function () {}, Event: function () {},
  MessageChannel: class { constructor() { this.port1 = { postMessage() {}, onmessage: null }; this.port2 = { postMessage() {}, onmessage: null }; } },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  WebAssembly: { instantiate() { return Promise.resolve({}); }, compile() { return Promise.resolve({}); } },
  Worker: class { postMessage() {} terminate() {} set onmessage(v) {} },
  crypto: { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }, random: () => Math.random() },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout: (fn, t) => setTimeout(fn, t),
  setInterval: (fn, t) => setInterval(fn, t),
  clearTimeout: (id) => clearTimeout(id),
  clearInterval: (id) => clearInterval(id),
  addEventListener() {}, removeEventListener() {}, postMessage() {},
  requestAnimationFrame: function (fn) { return setTimeout(fn, 16); },
  cancelAnimationFrame: function (id) { clearTimeout(id); },
  performance: { now: () => Date.now() },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  history: { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
  origin: 'https://www.douyin.com', isSecureContext: true, closed: false,
};
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.frames = fakeWindow;
fakeWindow.window = fakeWindow;
fakeWindow.globalThis = fakeWindow;

const sandbox = { ...fakeWindow, global: fakeWindow, globalThis: fakeWindow, window: fakeWindow, self: fakeWindow };
vm.createContext(sandbox);

// 加载前：保存原始 hook 函数的 toString
const beforeFetchStr = sandbox.fetch.toString();
const beforeXhrOpenStr = sandbox.XMLHttpRequest.prototype.open.toString();
const beforeXhrSendStr = sandbox.XMLHttpRequest.prototype.send.toString();
const beforeXhrSetHeaderStr = sandbox.XMLHttpRequest.prototype.setRequestHeader.toString();

console.log('=== 加载前 hook 状态 ===');
console.log('fetch:', beforeFetchStr.slice(0, 200));
console.log('XHR.open:', beforeXhrOpenStr.slice(0, 200));
console.log('XHR.send:', beforeXhrSendStr.slice(0, 200));
console.log('XHR.setRequestHeader:', beforeXhrSetHeaderStr.slice(0, 200));

console.log('\n执行 bdms.js ...');
try {
  vm.runInContext(src, sandbox, { filename: 'bdms.js', timeout: 30000 });
  console.log('执行成功');
} catch (e) {
  console.error('执行失败:', e.message);
  console.error(e.stack);
  process.exit(1);
}

// 加载后：对比 hook 是否被替换
const afterFetchStr = sandbox.fetch.toString();
const afterXhrOpenStr = sandbox.XMLHttpRequest.prototype.open.toString();
const afterXhrSendStr = sandbox.XMLHttpRequest.prototype.send.toString();
const afterXhrSetHeaderStr = sandbox.XMLHttpRequest.prototype.setRequestHeader.toString();

console.log('\n=== 加载后 hook 状态 ===');
console.log('fetch 被替换:', beforeFetchStr !== afterFetchStr);
console.log('fetch:', afterFetchStr.slice(0, 300));
console.log('XHR.open 被替换:', beforeXhrOpenStr !== afterXhrOpenStr);
console.log('XHR.open:', afterXhrOpenStr.slice(0, 300));
console.log('XHR.send 被替换:', beforeXhrSendStr !== afterXhrSendStr);
console.log('XHR.send:', afterXhrSendStr.slice(0, 300));
console.log('XHR.setRequestHeader 被替换:', beforeXhrSetHeaderStr !== afterXhrSetHeaderStr);
console.log('XHR.setRequestHeader:', afterXhrSetHeaderStr.slice(0, 300));

// 列出 window.bdms 暴露
console.log('\n=== window.bdms ===');
const bdms = sandbox.window.bdms;
if (bdms) {
  console.log('keys:', Object.keys(bdms));
  for (const k of Object.keys(bdms)) {
    const v = bdms[k];
    console.log(`  ${k}: ${typeof v}${typeof v === 'function' ? ' source=' + v.toString().slice(0, 300) : ''}`);
  }
}

// 列出 _sdkGlueVersionMap
console.log('\n=== _sdkGlueVersionMap ===');
const glue = sandbox.window._sdkGlueVersionMap;
console.log('glue:', glue, 'type:', typeof glue);
if (glue && typeof glue === 'object') {
  for (const k of Object.keys(glue)) {
    console.log(`  ${k}: ${typeof glue[k]} = ${String(glue[k]).slice(0, 100)}`);
  }
}

// 列出所有以 _ 开头的全局
console.log('\n=== window 上以 _ 开头的全局 ===');
const underscored = Object.keys(sandbox.window).filter(k => k.startsWith('_') || k.startsWith('byted') || k.startsWith('bd'));
console.log(underscored.join(', '));

// 尝试通过 XHR 触发签名
console.log('\n=== 尝试通过 XHR 触发签名 ===');
const testUrl = 'https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&pc_libra_divert=Windows&support_h265=1&support_dash=0&cpu_core_num=12&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1400&screen_height=900&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&device_memory=16&platform=PC&downlink=10&effective_type=4g&round_trip_time=0&msToken=test';
try {
  console.log('原 URL:', testUrl.slice(0, 80) + '...');
  const xhr = new sandbox.window.XMLHttpRequest();
  xhr.open('POST', testUrl, true);
  xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
  console.log('调用 open 后 _url:', xhr._url ? String(xhr._url).slice(0, 200) : '无');
  console.log('URL 中是否有 a_bogus:', xhr._url && String(xhr._url).includes('a_bogus'));
  xhr.send('test=1');
  console.log('调用 send 完成');
} catch (e) {
  console.error('XHR 触发失败:', e.message);
  console.error(e.stack);
}

// 尝试通过 fetch 触发签名
console.log('\n=== 尝试通过 fetch 触发签名 ===');
try {
  const ret = sandbox.window.fetch(testUrl, { method: 'GET' });
  console.log('fetch 返回:', typeof ret);
  if (ret && typeof ret.then === 'function') {
    ret.then(r => console.log('fetch resolved:', r && r.status)).catch(e => console.error('fetch reject:', e.message));
  }
} catch (e) {
  console.error('fetch 触发失败:', e.message);
}

// 等待异步完成
setTimeout(() => {
  console.log('\n=== 检查 window.bdms 上的 init / sign 函数 ===');
  if (sandbox.window.bdms) {
    for (const k of Object.keys(sandbox.window.bdms)) {
      console.log(`${k}:`, typeof sandbox.window.bdms[k]);
    }
    // 尝试调用 init
    try {
      if (typeof sandbox.window.bdms.init === 'function') {
        console.log('调用 init...');
        const r = sandbox.window.bdms.init();
        console.log('init 返回:', typeof r, String(r).slice(0, 100));
      }
    } catch (e) {
      console.error('init 失败:', e.message);
    }
  }
}, 2000);
