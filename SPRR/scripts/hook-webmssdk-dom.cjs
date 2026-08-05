/*
 * Hook webmssdk 的 DOM API 访问，捕获 a_bogus 生成过程中实际读取的设备信息
 *
 * 思路：
 * 1. 在 webmssdk 加载前 hook navigator / screen / window 上的属性访问
 * 2. 触发 webmssdk 生成 a_bogus
 * 3. 输出所有被读取过的设备相关字段
 *
 * 用法: node scripts/hook-webmssdk-dom.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const WEBMS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'data', 'capture', 'webmssdk.es5.js'),
  'utf-8',
);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 收集所有 DOM 访问
const accessLog = [];
const log = (key, value) => {
  // 去重
  if (!accessLog.find((x) => x.key === key)) {
    accessLog.push({ key, value: String(value).slice(0, 100) });
  }
};

// 用 Proxy 包装所有 DOM 对象，记录所有属性访问
function makeProxy(target, name, path = '') {
  return new Proxy(target, {
    get(t, p) {
      if (typeof p === 'string') {
        const v = t[p];
        if (typeof v === 'function') {
          log(`${name}${path ? '.' + path : ''}.${p}`, '[function]');
          return (...args) => v.apply(t, args);
        }
        // 记录访问
        const fullPath = `${name}${path ? '.' + path : ''}.${p}`;
        log(fullPath, v);
        // 递归代理
        if (typeof v === 'object' && v !== null && !['HTMLCollection', 'NodeList'].includes(v.constructor?.name)) {
          return makeProxy(v, name, path ? path + '.' + p : p);
        }
        return v;
      }
      return Reflect.get(t, p);
    },
  });
}

const fakeScreen = {
  width: 1400,
  height: 900,
  availWidth: 1400,
  availHeight: 900,
  availTop: 0,
  availLeft: 0,
  colorDepth: 24,
  pixelDepth: 24,
  orientation: { type: 'landscape-primary', angle: 0 },
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
  webdriver: false,
  connection: { downlink: 10, effectiveType: '4g', rtt: 150, saveData: false },
};

const fakeDocument = {
  referrer: 'https://www.douyin.com/',
  cookie: '',
  hidden: false,
  visibilityState: 'visible',
  documentElement: { clientWidth: 1400, clientHeight: 900, lang: 'zh-CN' },
  body: { clientWidth: 1400, clientHeight: 900 },
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

const fakeWindow = {
  navigator: fakeNavigator,
  document: fakeDocument,
  screen: fakeScreen,
  innerWidth: 1400,
  innerHeight: 900,
  outerWidth: 1416,
  outerHeight: 988,
  devicePixelRatio: 1,
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
  fetch: () => Promise.resolve({ ok: true, status: 200 }),
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  addEventListener() {},
  removeEventListener() {},
  performance: { now: () => Date.now() },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  history: { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  origin: 'https://www.douyin.com',
  isSecureContext: true,
  self: null,
  top: null,
  parent: null,
  frames: null,
  closed: false,
};
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.frames = fakeWindow;
fakeWindow.window = fakeWindow;
fakeWindow.globalThis = fakeWindow;
fakeWindow.location = fakeDocument.location;

// 用 Proxy 包装关键对象
const proxiedWindow = {
  ...fakeWindow,
  navigator: makeProxy(fakeNavigator, 'navigator'),
  screen: makeProxy(fakeScreen, 'screen'),
  document: makeProxy(fakeDocument, 'document'),
  location: makeProxy(fakeDocument.location, 'location'),
};
proxiedWindow.self = proxiedWindow;
proxiedWindow.top = proxiedWindow;
proxiedWindow.parent = proxiedWindow;
proxiedWindow.frames = proxiedWindow;
proxiedWindow.window = proxiedWindow;
proxiedWindow.globalThis = proxiedWindow;

const sandbox = {
  ...proxiedWindow,
  global: proxiedWindow,
  globalThis: proxiedWindow,
  window: proxiedWindow,
  self: proxiedWindow,
  Reflect,
  Proxy,
  Promise,
  Date,
  Math,
  JSON,
  Array,
  Object,
  Function,
  Number,
  String,
  Boolean,
  RegExp,
  Error,
  Symbol,
  Map,
  Set,
  WeakMap,
  WeakSet,
  ArrayBuffer,
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  DataView,
  TextEncoder,
  TextDecoder,
  console,
  Request: class Request { constructor() {} },
  Response: class Response { constructor() {} },
  Headers: class Headers { constructor() {} },
  URL: URL,
  URLSearchParams: URLSearchParams,
  crypto: { subtle: {}, getRandomValues: (a) => a },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  queueMicrotask: (fn) => Promise.resolve().then(fn),
  AbortController: class AbortController {},
  BroadcastChannel: class BroadcastChannel {},
  structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  global: undefined,
};

vm.createContext(sandbox);

console.log('加载 webmssdk ...');
try {
  vm.runInContext(WEBMS_SRC, sandbox, { filename: 'webmssdk.es5.js', timeout: 10000 });
  console.log('✓ 加载成功\n');
} catch (e) {
  console.error('✗ 加载失败:', e.message);
}

// 检查 byted_acrawler
const ba = sandbox.byted_acrawler;
if (ba && typeof ba.frontierSign === 'function') {
  console.log('=== 触发 frontierSign ===');
  try {
    const result = ba.frontierSign(
      '/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383',
    );
    console.log('frontierSign 结果:', JSON.stringify(result).slice(0, 200));
  } catch (e) {
    console.log('frontierSign 异常:', e.message);
  }
}

// 输出所有访问的 DOM 属性
console.log(`\n=== 共捕获 ${accessLog.length} 个 DOM 属性访问 ===\n`);
const byCategory = {
  navigator: [],
  screen: [],
  window: [],
  document: [],
  location: [],
  other: [],
};
for (const a of accessLog) {
  if (a.key.startsWith('navigator')) byCategory.navigator.push(a);
  else if (a.key.startsWith('screen')) byCategory.screen.push(a);
  else if (a.key.startsWith('window')) byCategory.window.push(a);
  else if (a.key.startsWith('document')) byCategory.document.push(a);
  else if (a.key.startsWith('location')) byCategory.location.push(a);
  else byCategory.other.push(a);
}

for (const [cat, items] of Object.entries(byCategory)) {
  if (items.length === 0) continue;
  console.log(`\n--- ${cat} (${items.length}) ---`);
  for (const a of items.slice(0, 50)) {
    console.log(`  ${a.key} = ${a.value}`);
  }
}
