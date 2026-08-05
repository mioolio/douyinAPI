/* 在 Node.js vm 中加载 webmssdk.es5.js 并探测其 API */
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'data', 'capture', 'webmssdk.es5.js');
const src = fs.readFileSync(file, 'utf-8');

// 补环境
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const fakeDocument = {
  referrer: 'https://www.douyin.com/',
  cookie: '',
  all: {},
  addEventListener() {},
  removeEventListener() {},
  createEvent() {
    return { initEvent() {} };
  },
  createElement(tag) {
    if (tag === 'script') return { text: '', src: '', type: '', async: false, onload: null, onerror: null, appendChild() {} };
    return { style: {}, appendChild() {}, setAttribute() {}, getAttribute() { return null; } };
  },
  createElementNS() {
    return { href: '' };
  },
  getElementById() {
    return null;
  },
  getElementsByTagName() {
    return [];
  },
  getElementsByClassName() {
    return [];
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  documentElement: { clientWidth: 1400, clientHeight: 900, lang: 'zh-CN' },
  body: { appendChild() {}, removeChild() {} },
  head: { appendChild() {}, removeChild() {} },
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
  width: 1400,
  height: 900,
  availWidth: 1400,
  availHeight: 900,
  colorDepth: 24,
  pixelDepth: 24,
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

const fakeWindow = {
  navigator: fakeNavigator,
  document: fakeDocument,
  screen: fakeScreen,
  location: fakeLocation,
  innerWidth: 1400,
  innerHeight: 900,
  outerWidth: 1400,
  outerHeight: 900,
  devicePixelRatio: 1,
  XMLHttpRequest: function XMLHttpRequest() {
    this.readyState = 0;
    this.bdmsInvokeList = [];
    this.open = function () {};
    this.send = function () {};
    this.setRequestHeader = function () {};
    this.getAllResponseHeaders = function () {
      return '';
    };
    this.getResponseHeader = function () {
      return null;
    };
    this.abort = function () {};
    this.addEventListener = function () {};
    this.removeEventListener = function () {};
  },
  fetch: function fetch() {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
  },
  Reflect: Reflect,
  Proxy: Proxy,
  Promise: Promise,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Array: Array,
  Object: Object,
  Function: Function,
  Number: Number,
  String: String,
  Boolean: Boolean,
  RegExp: RegExp,
  Error: Error,
  Symbol: Symbol,
  Map: Map,
  Set: Set,
  WeakMap: WeakMap,
  WeakSet: WeakSet,
  ArrayBuffer: ArrayBuffer,
  Uint8Array: Uint8Array,
  Int8Array: Int8Array,
  Uint16Array: Uint16Array,
  Int16Array: Int16Array,
  Uint32Array: Uint32Array,
  Int32Array: Int32Array,
  Float32Array: Float32Array,
  Float64Array: Float64Array,
  DataView: DataView,
  TextEncoder: TextEncoder,
  TextDecoder: TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout: (fn, t) => setTimeout(fn, t),
  setInterval: (fn, t) => setInterval(fn, t),
  clearTimeout: (id) => clearTimeout(id),
  clearInterval: (id) => clearInterval(id),
  addEventListener: function () {},
  removeEventListener: function () {},
  postMessage: function () {},
  requestAnimationFrame: function (fn) {
    return setTimeout(fn, 16);
  },
  cancelAnimationFrame: function (id) {
    clearTimeout(id);
  },
  performance: { now: () => Date.now() },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
  sessionStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
  history: {
    pushState: () => {},
    replaceState: () => {},
    back: () => {},
    forward: () => {},
    go: () => {},
  },
  origin: 'https://www.douyin.com',
  isSecureContext: true,
  closed: false,
  self: null,
  top: null,
  parent: null,
  frames: null,
};
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.frames = fakeWindow;
fakeWindow.window = fakeWindow;
fakeWindow.globalThis = fakeWindow;

const sandbox = { ...fakeWindow, global: fakeWindow, globalThis: fakeWindow, window: fakeWindow, self: fakeWindow };

vm.createContext(sandbox);

console.log('执行 webmssdk.es5.js ...');
try {
  vm.runInContext(src, sandbox, { filename: 'webmssdk.es5.js', timeout: 5000 });
  console.log('执行成功');
} catch (e) {
  console.error('执行失败:', e.message);
  console.error(e.stack);
}

// 列出 sandbox 上所有非内置属性
console.log('\n=== sandbox 上 webmssdk 暴露的属性 ===');
const builtin = new Set([
  'navigator', 'document', 'screen', 'location', 'innerWidth', 'innerHeight',
  'outerWidth', 'outerHeight', 'devicePixelRatio', 'XMLHttpRequest', 'fetch',
  'Reflect', 'Proxy', 'Promise', 'Date', 'Math', 'JSON', 'Array', 'Object',
  'Function', 'Number', 'String', 'Boolean', 'RegExp', 'Error', 'Symbol', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'Uint8Array', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'DataView', 'TextEncoder', 'TextDecoder', 'btoa', 'atob',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'addEventListener',
  'removeEventListener', 'postMessage', 'requestAnimationFrame', 'cancelAnimationFrame',
  'performance', 'localStorage', 'sessionStorage', 'history', 'origin',
  'isSecureContext', 'closed', 'self', 'top', 'parent', 'frames', 'window',
  'globalThis', 'global',
]);
const exposed = Object.keys(sandbox).filter((k) => !builtin.has(k));
for (const k of exposed.sort()) {
  const v = sandbox[k];
  const type = typeof v;
  if (type === 'object' && v !== null) {
    console.log(`  ${k}: object { keys: ${Object.keys(v).slice(0, 20).join(', ')} }`);
  } else if (type === 'function') {
    console.log(`  ${k}: function`);
  } else {
    console.log(`  ${k}: ${type} = ${String(v).slice(0, 80)}`);
  }
}

// 重点检查 byted_acrawler
console.log('\n=== byted_acrawler 内容 ===');
const ba = sandbox.byted_acrawler || sandbox.window?.byted_acrawler;
if (ba) {
  console.log(`类型: ${typeof ba}`);
  console.log(`keys: ${Object.keys(ba).join(', ')}`);
  for (const k of Object.keys(ba)) {
    console.log(`  ${k}: ${typeof ba[k]}`);
  }
  // 尝试调用 frontierSign
  if (typeof ba.frontierSign === 'function') {
    try {
      const sig = ba.frontierSign('test');
      console.log(`frontierSign('test') = ${JSON.stringify(sig)}`);
    } catch (e) {
      console.error(`frontierSign 调用失败: ${e.message}`);
    }
  }
} else {
  console.log('未找到 byted_acrawler');
  console.log('所有以 _ 开头的属性:', Object.keys(sandbox).filter((k) => k.startsWith('_')).join(', '));
}
