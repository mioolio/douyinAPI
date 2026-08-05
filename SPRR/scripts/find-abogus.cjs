/* 专注捕获 a_bogus 生成：
 * 1. bdms.js hook 了 XHR.open/send/setRequestHeader
 * 2. 参考 https://zhuanlan.zhihu.com/p/2040149080698003937，
 *    a_bogus 是某个 n 函数的返回值（长度约 192 的字符串）
 * 3. 策略：patch XHR hook 函数，捕获返回值；同时尝试文章中的 bdmsInvokeList 调用方式
 */
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
let src = fs.readFileSync(file, 'utf-8');

// 补环境（精简版，与 test-bdms-hooks.cjs 一致）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

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
    this.bdmsInvokeList = [];
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

const fakeWindow = {
  navigator: fakeNavigator, document: fakeDocument, screen: fakeScreen, location: fakeLocation,
  innerWidth: 1400, innerHeight: 900, outerWidth: 1400, outerHeight: 900, devicePixelRatio: 1,
  XMLHttpRequest: RealXHR,
  fetch: function fetch() {
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
  },
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
  crypto: { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }, random: () => Math.random },
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

console.log('执行 bdms.js ...');
try {
  vm.runInContext(src, sandbox, { filename: 'bdms.js', timeout: 30000 });
  console.log('执行成功');
} catch (e) {
  console.error('执行失败:', e.message);
  process.exit(1);
}

// bdms 已 hook XHR.open/send/setRequestHeader
// 策略：调用 XHR 时，hook 会执行；我们需要捕获 a_bogus 的返回值
// 参考：https://zhuanlan.zhihu.com/p/2040149080698003937
// 文章说 a_bogus 是在 Cn → n → X → d 调用链中生成的
// 文章的 getSign 函数：u = [0, 1, 14, params, "", UA]; return sign_z._u(r[0], u, r[1], r[2], this)
// 但 sign_z 是另一个变体；bdms.js 的方式是 hook XHR

const testUrl = 'https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&pc_libra_divert=Windows&support_h265=1&support_dash=0&cpu_core_num=12&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1400&screen_height=900&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&device_memory=16&platform=PC&downlink=10&effective_type=4g&round_trip_time=0&msToken=test';

console.log('\n=== 测试 1: 调用 XHR.open 并检查返回值 ===');
try {
  const xhr = new sandbox.window.XMLHttpRequest();
  const ret = xhr.open('POST', testUrl, true);
  console.log('open 返回值类型:', typeof ret);
  console.log('open 返回值:', ret === undefined ? 'undefined' : (typeof ret === 'string' ? ret.slice(0, 200) : String(ret).slice(0, 200)));
  console.log('xhr._url:', String(xhr._url).slice(0, 200));
  console.log('xhr._url 包含 a_bogus:', String(xhr._url).includes('a_bogus'));
  console.log('xhr 所有属性:', Object.keys(xhr).filter(k => !k.startsWith('_') && !['readyState','responseText','status','response','onreadystatechange','onload','onerror','withCredentials','timeout','bdmsInvokeList'].includes(k)).join(', '));

  // 检查是否有新属性被添加
  console.log('\n调用 setRequestHeader...');
  const ret2 = xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
  console.log('setRequestHeader 返回值:', typeof ret2, ret2 === undefined ? 'undefined' : String(ret2).slice(0, 100));

  console.log('\n调用 send...');
  const ret3 = xhr.send('test=1');
  console.log('send 返回值:', typeof ret3, ret3 === undefined ? 'undefined' : String(ret3).slice(0, 100));

  // 再次检查 URL
  console.log('\nsend 后 xhr._url:', String(xhr._url).slice(0, 200));
  console.log('send 后 xhr._url 包含 a_bogus:', String(xhr._url).includes('a_bogus'));
  console.log('send 后 xhr._headers:', JSON.stringify(xhr._headers));
} catch (e) {
  console.error('测试 1 失败:', e.message);
  console.error(e.stack);
}

console.log('\n=== 测试 2: 检查 window 上的新属性 ===');
const builtin = new Set(['navigator','document','screen','location','innerWidth','innerHeight','outerWidth','outerHeight','devicePixelRatio','XMLHttpRequest','fetch','Reflect','Proxy','Promise','Date','Math','JSON','Array','Object','Function','Number','String','Boolean','RegExp','Error','Symbol','Map','Set','WeakMap','WeakSet','ArrayBuffer','Uint8Array','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array','Float64Array','DataView','TextEncoder','TextDecoder','URLSearchParams','URL','BigInt','DOMParser','Node','Element','DocumentFragment','CustomEvent','Event','MessageChannel','MutationObserver','ResizeObserver','IntersectionObserver','WebAssembly','Worker','crypto','btoa','atob','setTimeout','setInterval','clearTimeout','clearInterval','addEventListener','removeEventListener','postMessage','requestAnimationFrame','cancelAnimationFrame','performance','localStorage','sessionStorage','history','origin','isSecureContext','closed','self','top','parent','frames','window','globalThis','global','bdms','_sdkGlueVersionMap']);
const exposed = Object.keys(sandbox.window).filter((k) => !builtin.has(k));
console.log('非内置属性:', exposed);
for (const k of exposed) {
  const v = sandbox.window[k];
  console.log(`  ${k}: ${typeof v}${typeof v === 'function' ? ' ' + v.toString().slice(0, 200) : typeof v === 'string' ? ' = ' + v.slice(0, 100) : ''}`);
}

console.log('\n=== 测试 3: 检查 bdms.init 的参数 ===');
// init 失败: Cannot read properties of undefined (reading 'aid')
// 可能需要传入 config 对象
try {
  // 尝试传入空对象
  if (typeof sandbox.window.bdms.init === 'function') {
    const configs = [
      {},
      { aid: 6383 },
      { aid: 6383, dfp: false },
      { aid: '6383' },
    ];
    for (const cfg of configs) {
      try {
        console.log(`尝试 init(${JSON.stringify(cfg)})...`);
        const r = sandbox.window.bdms.init(cfg);
        console.log(`  返回: ${typeof r} ${typeof r === 'string' ? r.slice(0, 100) : String(r).slice(0, 100)}`);
      } catch (e) {
        console.log(`  失败: ${e.message}`);
      }
    }
  }
} catch (e) {
  console.error('测试 3 失败:', e.message);
}

console.log('\n=== 测试 4: patch XHR hook 捕获返回值 ===');
// 直接包装 XHR.open 的 hook 函数，捕获所有调用的返回值
const origOpen = sandbox.window.XMLHttpRequest.prototype.open;
const origSend = sandbox.window.XMLHttpRequest.prototype.send;
const origSetHeader = sandbox.window.XMLHttpRequest.prototype.setRequestHeader;

const capturedReturns = [];
function wrapHook(name, orig) {
  return function() {
    const ret = orig.apply(this, arguments);
    if (typeof ret === 'string' && ret.length > 20) {
      capturedReturns.push({ method: name, length: ret.length, preview: ret.slice(0, 200), full: ret });
    }
    // 同时检查 this 上的属性变化
    const url = this._url || this.url;
    if (url && String(url).includes('a_bogus')) {
      capturedReturns.push({ method: name + '(url)', length: String(url).length, preview: String(url).slice(0, 300), full: String(url) });
    }
    return ret;
  };
}

sandbox.window.XMLHttpRequest.prototype.open = wrapHook('open', origOpen);
sandbox.window.XMLHttpRequest.prototype.send = wrapHook('send', origSend);
sandbox.window.XMLHttpRequest.prototype.setRequestHeader = wrapHook('setRequestHeader', origSetHeader);

try {
  const xhr = new sandbox.window.XMLHttpRequest();
  xhr.open('POST', testUrl, true);
  xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
  xhr.send('test=1');
  console.log('捕获到长字符串数量:', capturedReturns.length);
  for (const c of capturedReturns) {
    console.log(`  [${c.method}] len=${c.length}: ${c.preview}`);
  }
} catch (e) {
  console.error('测试 4 失败:', e.message);
}

// 测试 5: 参考文章的 bdmsInvokeList 方式
console.log('\n=== 测试 5: bdmsInvokeList 调用方式 ===');
// 文章中的调用方式：构造一个带 bdmsInvokeList 的 XHR 对象
try {
  // 重置 hook（使用原始 hook）
  sandbox.window.XMLHttpRequest.prototype.open = origOpen;
  sandbox.window.XMLHttpRequest.prototype.send = origSend;
  sandbox.window.XMLHttpRequest.prototype.setRequestHeader = origSetHeader;

  // 创建 XHR 并手动设置 bdmsInvokeList
  const xhr = new sandbox.window.XMLHttpRequest();
  xhr.bdmsInvokeList = [
    { args: ['POST', testUrl, true], func: function() {} },
    { args: ['Accept', 'application/json, text/plain, */*'] },
  ];
  // 直接调用 hook（绕过 open，触发 hook 的内部逻辑）
  // hook 函数是 function(){return X(e,this,arguments,r)}
  // 我们需要调用它，让它处理 bdmsInvokeList
  const hookFn = origOpen;
  console.log('调用 hook(open) with this=xhr...');
  const ret = hookFn.call(xhr, 'POST', testUrl, true);
  console.log('返回类型:', typeof ret);
  if (typeof ret === 'string') {
    console.log('返回值长度:', ret.length);
    console.log('返回值:', ret.slice(0, 200));
    if (ret.length > 100) {
      console.log('✓ 可能是 a_bogus！');
    }
  } else {
    console.log('返回值:', String(ret).slice(0, 200));
  }
} catch (e) {
  console.error('测试 5 失败:', e.message);
  console.error(e.stack);
}

setTimeout(() => {
  console.log('\n=== 完成 ===');
}, 1000);
