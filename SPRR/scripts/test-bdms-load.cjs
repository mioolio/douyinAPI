/* 在 Node.js vm 中加载 bdms.js，补环境，并探测 a_bogus 生成入口 */
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
let src = fs.readFileSync(file, 'utf-8');

// 关键改造：在 D 函数中加 hook，把所有 (e[0], n) 注册到全局 registry
// 原: function D(t,r){var e=z[t];Y.has(t)&&V.delete(Y.get(t));var n=function(){return X(e,this,arguments,r)};return Y.set(t,n),V.set(n,[e,r]),n}
// 改造后: 把 e[0]（bytecode 数组）+ n（生成函数）+ 调用计数 全部记录
const D_OLD = 'function D(t,r){var e=z[t];Y.has(t)&&V.delete(Y.get(t));var n=function(){return X(e,this,arguments,r)};return Y.set(t,n),V.set(n,[e,r]),n}';
const D_NEW = `function D(t,r){
  var e=z[t];
  Y.has(t)&&V.delete(Y.get(t));
  var n=function(){return X(e,this,arguments,r)};
  // hook: 记录所有 D 调用
  if(typeof globalThis.__bdmsRegistry==='undefined')globalThis.__bdmsRegistry=[];
  globalThis.__bdmsRegistry.push({t:t, e0:Array.isArray(e)?Array.from(e[0]):null, e_len:Array.isArray(e)?e.length:0, n:n, callCount:0});
  // 包装 n，统计调用次数并捕获返回值
  var origN=n;
  n=function(){
    var ret=origN.apply(this,arguments);
    try{
      var entry=globalThis.__bdmsRegistry[globalThis.__bdmsRegistry.length-1];
      entry.callCount++;
      entry.lastArgs=Array.from(arguments).map(a=>typeof a);
      entry.lastRet=ret;
      entry.lastRetType=typeof ret;
      entry.lastRetLen=typeof ret==='string'?ret.length:null;
      entry.lastRetPreview=typeof ret==='string'?ret.slice(0,80):null;
    }catch(_){}
    return ret;
  };
  return Y.set(t,n),V.set(n,[e,r]),n
}`;

if (src.indexOf(D_OLD) < 0) {
  console.error('未能找到原始 D 函数，请检查 bdms.js');
  process.exit(1);
}
src = src.replace(D_OLD, D_NEW);
console.log('D 函数已 patch（注册 hook）');

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
    if (tag === 'input' || tag === 'textarea') return Object.assign(_fakeElement(), { value: '', type: tag === 'input' ? 'text' : 'textarea', name: '', placeholder: '', tagName: tag.toUpperCase(), nodeName: tag.toUpperCase() });
    if (tag === 'form') return Object.assign(_fakeElement(), { submit() {}, action: '', method: 'GET', elements: [], tagName: 'FORM', nodeName: 'FORM' });
    return Object.assign(_fakeElement(), { tagName: (tag || 'DIV').toUpperCase(), nodeName: (tag || 'DIV').toUpperCase() });
  },
  createElementNS(ns, tag) {
    return Object.assign(_fakeElement(), { namespaceURI: ns, tagName: tag, nodeName: tag });
  },
  createTextNode(text) { return { nodeType: 3, nodeName: '#text', textContent: String(text), nodeValue: String(text), parentNode: null }; },
  createComment(text) { return { nodeType: 8, nodeName: '#comment', textContent: String(text), nodeValue: String(text) }; },
  createDocumentFragment() { return Object.assign(_fakeElement(), { nodeType: 11, nodeName: '#document-fragment' }); },
  createRange() { return { setStart() {}, setEnd() {}, selectNode() {}, selectNodeContents() {}, collapse() {}, cloneRange() { return this; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }, createContextualFragment(html) { return _fakeElement(); } }; },
  getSelection() { return { rangeCount: 0, toString() { return ''; }, addRange() {}, removeAllRanges() {} }; },
  getElementById() { return null; },
  getElementsByTagName() { return []; },
  getElementsByClassName() { return []; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  documentElement: Object.assign(_fakeElement(), { clientWidth: 1400, clientHeight: 900, lang: 'zh-CN', tagName: 'HTML', nodeName: 'HTML' }),
  body: Object.assign(_fakeElement(), { clientWidth: 1400, clientHeight: 900, tagName: 'BODY', nodeName: 'BODY' }),
  head: Object.assign(_fakeElement(), { tagName: 'HEAD', nodeName: 'HEAD' }),
  title: '',
  readyState: 'complete',
  visibilityState: 'visible',
  hidden: false,
  hasFocus() { return true; },
  activeElement: null,
  location: {
    href: 'https://www.douyin.com/',
    origin: 'https://www.douyin.com',
    protocol: 'https:',
    host: 'www.douyin.com',
    hostname: 'www.douyin.com',
    pathname: '/',
    search: '',
    hash: '',
  },
};

const fakeNavigator = {
  userAgent: UA,
  platform: 'Win32',
  language: 'zh-CN',
  languages: ['zh-CN', 'zh'],
  onLine: true,
  hardwareConcurrency: 12,
  deviceMemory: 16,
  maxTouchPoints: 0,
  vendor: 'Google Inc.',
  appVersion: UA.replace('Mozilla/', ''),
  cookieEnabled: true,
  plugins: { length: 0 },
  mimeTypes: { length: 0 },
  storage: { estimate: () => Promise.resolve({ quota: 0, usage: 0 }) },
  permissions: { query: () => Promise.resolve({ state: 'granted' }) },
  connection: { downlink: 10, effectiveType: '4g', rtt: 150, saveData: false },
  webdriver: false,
};

const fakeScreen = {
  width: 1400, height: 900, availWidth: 1400, availHeight: 900,
  colorDepth: 24, pixelDepth: 24,
};

const fakeLocation = {
  href: 'https://www.douyin.com/',
  origin: 'https://www.douyin.com',
  protocol: 'https:',
  host: 'www.douyin.com',
  hostname: 'www.douyin.com',
  pathname: '/',
  search: '',
  hash: '',
};

// 关键：XMLHttpRequest 必须支持 bdmsInvokeList，因为 a_bogus 生成依赖它
// 参考：https://zhuanlan.zhihu.com/p/2040149080698003937
class FakeXHR {
  constructor() {
    this.readyState = 0;
    this.bdmsInvokeList = [];
    this._method = '';
    this._url = '';
    this._headers = {};
    this.responseText = '';
    this.status = 0;
    this.response = null;
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
  }
  open(method, url) {
    this._method = method;
    this._url = url;
    this.readyState = 1;
    // 关键：bdms.js 会把 open 调用推入 bdmsInvokeList
    this.bdmsInvokeList.push({ args: [method, url, true], func: () => {} });
  }
  setRequestHeader(k, v) {
    this._headers[k] = v;
    this.bdmsInvokeList.push({ args: [k, v] });
  }
  send(body) {
    this._body = body;
    this.readyState = 4;
    this.status = 200;
    // 触发 onreadystatechange
    if (typeof this.onreadystatechange === 'function') {
      try { this.onreadystatechange(); } catch (_) {}
    }
    if (typeof this.onload === 'function') {
      try { this.onload(); } catch (_) {}
    }
  }
  getAllResponseHeaders() { return ''; }
  getResponseHeader() { return null; }
  abort() {}
  addEventListener() {}
  removeEventListener() {}
}

const fakeWindow = {
  navigator: fakeNavigator,
  document: fakeDocument,
  screen: fakeScreen,
  location: fakeLocation,
  innerWidth: 1400, innerHeight: 900,
  outerWidth: 1400, outerHeight: 900,
  devicePixelRatio: 1,
  XMLHttpRequest: FakeXHR,
  fetch: function fetch() {
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
  },
  Reflect, Proxy, Promise, Date, Math, JSON,
  Array, Object, Function, Number, String, Boolean, RegExp, Error, Symbol,
  Map, Set, WeakMap, WeakSet,
  ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, DataView, TextEncoder, TextDecoder,
  URLSearchParams, URL, BigInt,
  // DOM 兜底
  DOMParser: class { parseFromString() { return { documentElement: {}, querySelector() { return null; } }; } },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  Element: function () {},
  DocumentFragment: function () {},
  CustomEvent: function () {},
  Event: function () {},
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
  origin: 'https://www.douyin.com',
  isSecureContext: true,
  closed: false,
};
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.frames = fakeWindow;
fakeWindow.window = fakeWindow;
fakeWindow.globalThis = fakeWindow;

const sandbox = { ...fakeWindow, global: fakeWindow, globalThis: fakeWindow, window: fakeWindow, self: fakeWindow };
vm.createContext(sandbox);

console.log('\n执行 bdms.js ...');
try {
  vm.runInContext(src, sandbox, { filename: 'bdms.js', timeout: 10000 });
  console.log('执行成功');
} catch (e) {
  console.error('执行失败:', e.message);
  console.error(e.stack);
  process.exit(1);
}

// 列出 bdms 暴露的 API
console.log('\n=== window.bdms 内容 ===');
console.log('sandbox.bdms:', typeof sandbox.bdms);
console.log('sandbox.window.bdms:', typeof sandbox.window?.bdms);
console.log('sandbox.window keys:', Object.keys(sandbox.window || {}).filter(k => !['navigator','document','screen','location','self','top','parent','frames','window','globalThis','global'].includes(k)).join(', '));
const bdms = sandbox.bdms || sandbox.window?.bdms;
if (bdms) {
  console.log(`类型: ${typeof bdms}`);
  console.log(`keys: ${Object.keys(bdms).join(', ')}`);
  for (const k of Object.keys(bdms)) {
    const v = bdms[k];
    console.log(`  ${k}: ${typeof v}${typeof v === 'object' && v ? ' (keys: ' + Object.keys(v).join(',') + ')' : ''}`);
  }
} else {
  console.log('未找到 window.bdms');
  // 列出 sandbox 上所有非内置属性
  const builtin = new Set(['navigator','document','screen','location','innerWidth','innerHeight','outerWidth','outerHeight','devicePixelRatio','XMLHttpRequest','fetch','Reflect','Proxy','Promise','Date','Math','JSON','Array','Object','Function','Number','String','Boolean','RegExp','Error','Symbol','Map','Set','WeakMap','WeakSet','ArrayBuffer','Uint8Array','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array','Float64Array','DataView','TextEncoder','TextDecoder','URLSearchParams','URL','BigInt','DOMParser','Node','Element','DocumentFragment','CustomEvent','Event','MessageChannel','MutationObserver','ResizeObserver','IntersectionObserver','WebAssembly','Worker','crypto','btoa','atob','setTimeout','setInterval','clearTimeout','clearInterval','addEventListener','removeEventListener','postMessage','requestAnimationFrame','cancelAnimationFrame','performance','localStorage','sessionStorage','history','origin','isSecureContext','closed','self','top','parent','frames','window','globalThis','global']);
  const exposed = Object.keys(sandbox).filter((k) => !builtin.has(k));
  console.log('sandbox 上非内置属性:', exposed.sort().join(', '));
}

// 列出 D 注册的所有函数
console.log('\n=== D 注册的所有函数 ===');
const reg = sandbox.__bdmsRegistry || sandbox.window?.__bdmsRegistry || [];
console.log(`registry 位置: sandbox=${Array.isArray(sandbox.__bdmsRegistry)}, sandbox.window=${Array.isArray(sandbox.window?.__bdmsRegistry)}`);
console.log(`总数: ${reg.length}`);
for (let i = 0; i < reg.length; i++) {
  const r = reg[i];
  const e0 = r.e0 ? JSON.stringify(r.e0).slice(0, 100) : 'null';
  console.log(`  [${i}] t=${r.t}, e.length=${r.e_len}, e[0]=${e0}`);
}

// 如果没有 D 调用，触发 XHR 来调用 bdms 的 hook
if (reg.length === 0) {
  console.log('\n=== D 未被触发，尝试通过 XHR/fetch 触发 bdms hook ===');
  try {
    console.log('调用 bdms.init()...');
    if (typeof sandbox.window.bdms.init === 'function') {
      const initRet = sandbox.window.bdms.init();
      console.log(`init 返回: ${typeof initRet}`);
    }
  } catch (e) {
    console.error('init 失败:', e.message);
  }
  try {
    console.log('调用 bdms.getReferer()...');
    if (typeof sandbox.window.bdms.getReferer === 'function') {
      const refRet = sandbox.window.bdms.getReferer();
      console.log(`getReferer 返回: ${typeof refRet} = ${String(refRet).slice(0, 100)}`);
    }
  } catch (e) {
    console.error('getReferer 失败:', e.message);
  }
  // 尝试通过 XHR.open 触发 hook
  try {
    console.log('尝试 new XMLHttpRequest() + open + send...');
    const xhr = new sandbox.window.XMLHttpRequest();
    xhr.open('POST', 'https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&msToken=test', true);
    xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
    xhr.send('test=1');
    console.log('XHR 调用完成');
  } catch (e) {
    console.error('XHR 触发失败:', e.message);
  }
  // 重新检查 registry
  const reg2 = sandbox.__bdmsRegistry || sandbox.window?.__bdmsRegistry || [];
  console.log(`触发后 registry 数量: ${reg2.length}`);
  for (let i = 0; i < reg2.length; i++) {
    const r = reg2[i];
    const e0 = r.e0 ? JSON.stringify(r.e0).slice(0, 100) : 'null';
    console.log(`  [${i}] t=${r.t}, e.length=${r.e_len}, e[0]=${e0}`);
  }
  // 检查 window 上是否新增了属性
  console.log('sandbox.window 新属性:', Object.keys(sandbox.window).filter(k => !['navigator','document','screen','location','self','top','parent','frames','window','globalThis','global','innerWidth','innerHeight','outerWidth','outerHeight','devicePixelRatio','XMLHttpRequest','fetch','Reflect','Proxy','Promise','Date','Math','JSON','Array','Object','Function','Number','String','Boolean','RegExp','Error','Symbol','Map','Set','WeakMap','WeakSet','ArrayBuffer','Uint8Array','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array','Float64Array','DataView','TextEncoder','TextDecoder','URLSearchParams','URL','BigInt','DOMParser','Node','Element','DocumentFragment','CustomEvent','Event','MessageChannel','MutationObserver','ResizeObserver','IntersectionObserver','WebAssembly','Worker','crypto','btoa','atob','setTimeout','setInterval','clearTimeout','clearInterval','addEventListener','removeEventListener','postMessage','requestAnimationFrame','cancelAnimationFrame','performance','localStorage','sessionStorage','history','origin','isSecureContext','closed'].includes(k)).join(', '));
}

// 尝试调用每个 n 函数，看哪个生成 192 字节字符串
console.log('\n=== 尝试调用 n 函数找 a_bogus 生成入口 ===');
const testUrl = 'https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&pc_libra_divert=Windows&support_h265=1&support_dash=0&cpu_core_num=12&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1400&screen_height=900&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&device_memory=16&platform=PC&downlink=10&effective_type=4g&round_trip_time=0&msToken=test';

for (let i = 0; i < reg.length; i++) {
  const r = reg[i];
  try {
    // 模拟文章中的调用方式：构造一个 XMLHttpRequest 对象
    const xhr = new FakeXHR();
    xhr.open('POST', testUrl, true);
    xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
    // 调用 n 函数
    const ret = r.n.apply(xhr, [{ 0: null }]);
    if (typeof ret === 'string' && ret.length > 50) {
      console.log(`  [${i}] ✓ 找到长字符串！len=${ret.length}, preview=${ret.slice(0, 100)}`);
      console.log(`      e[0]=${JSON.stringify(r.e0)}`);
    } else if (typeof ret === 'string') {
      console.log(`  [${i}] string len=${ret.length}: ${ret.slice(0, 50)}`);
    }
  } catch (e) {
    // 静默忽略
  }
}
