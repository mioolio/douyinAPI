/**
 * 浏览器调试 a_bogus：
 *  - 使用 addInitScript 注入 hook（在所有页面脚本前）
 *  - 拦截 XHR.open (原始 URL) + XHR.send (最终 URL)
 *  - 使用 page.on('request') 捕获最终 URL（含 a_bogus）
 *  - 触发真实 API 调用，捕获所有 URL
 */
const { chromium } = require('playwright');
const fs = require('fs');
const log = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
};

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

(async () => {
  const statePath = 'D:\\Desktop\\DYCC\\SPRR\\data\\accounts\\default.json';

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });

    window.__origOpens = [];
    window.__finalUrls = [];
    window.__navigatorAccessed = {};
    window.__windowAccessed = {};
    window.__screenAccessed = {};

    // 1. Hook XMLHttpRequest.open (捕获原始 URL)
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__origUrl = url;
      this.__origMethod = method;
      if (url && (url.indexOf('aweme') !== -1 || url.indexOf('/im/') !== -1)) {
        window.__origOpens.push({ method: method, url: url.substring(0, 500), ts: Date.now() });
      }
      return origOpen.apply(this, arguments);
    };

    // 2. Hook XMLHttpRequest.send (捕获最终 URL，因为 send 之前 bdms 已注入 a_bogus)
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
      try {
        var url = this.__origUrl || '';
        if (url && (url.indexOf('aweme') !== -1 || url.indexOf('/im/') !== -1)) {
          window.__finalUrls.push({ method: this.__origMethod, url: url.substring(0, 600), body: body ? String(body).substring(0, 200) : '', ts: Date.now() });
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };

    // 3. Hook fetch
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url && (url.indexOf('aweme') !== -1 || url.indexOf('/im/') !== -1)) {
        window.__finalUrls.push({ method: 'fetch', url: url.substring(0, 600), body: init && init.body ? String(init.body).substring(0, 200) : '', ts: Date.now() });
      }
      return origFetch.apply(this, arguments);
    };

    // 4. Hook navigator 字段访问
    var navDesc = Object.getOwnPropertyDescriptor(window, 'navigator');
    if (navDesc && navDesc.get) {
      var origNavGet = navDesc.get;
      Object.defineProperty(window, 'navigator', {
        get: function() {
          var nav = origNavGet.call(this);
          return new Proxy(nav, {
            get: function(target, prop) {
              if (typeof prop === 'string') {
                var v = target[prop];
                if (['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'cookieEnabled', 'webdriver', 'plugins', 'mimeTypes', 'vendor', 'appVersion', 'productSub', 'maxTouchPoints'].indexOf(prop) !== -1) {
                  if (!window.__navigatorAccessed[prop]) {
                    window.__navigatorAccessed[prop] = v === undefined ? null : (typeof v === 'string' ? v.substring(0, 200) : Array.isArray(v) ? '[' + v.length + ' items]' : String(v).substring(0, 200));
                  }
                }
              }
              return target[prop];
            }
          });
        },
        configurable: true
      });
    }

    // 5. Hook screen 字段
    var screenDesc = Object.getOwnPropertyDescriptor(window, 'screen');
    if (screenDesc && screenDesc.get) {
      var origScreenGet = screenDesc.get;
      Object.defineProperty(window, 'screen', {
        get: function() {
          var s = origScreenGet.call(this);
          return new Proxy(s, {
            get: function(target, prop) {
              if (typeof prop === 'string') {
                var v = target[prop];
                if (['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'orientation', 'availTop', 'availLeft'].indexOf(prop) !== -1) {
                  if (!window.__screenAccessed[prop]) {
                    window.__screenAccessed[prop] = v;
                  }
                }
              }
              return target[prop];
            }
          });
        },
        configurable: true
      });
    }

    // 6. Hook window 字段
    var WINDOW_FIELDS = ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'screenX', 'screenY', 'screenLeft', 'screenTop', 'pageXOffset', 'pageYOffset'];
    for (var i = 0; i < WINDOW_FIELDS.length; i++) {
      (function(field) {
        try {
          var desc = Object.getOwnPropertyDescriptor(window, field);
          if (desc && desc.get) {
            var origGet = desc.get;
            Object.defineProperty(window, field, {
              get: function() {
                var v = origGet.call(this);
                if (!window.__windowAccessed[field]) {
                  window.__windowAccessed[field] = v;
                }
                return v;
              },
              configurable: true
            });
          }
        } catch (e) {}
      })(WINDOW_FIELDS[i]);
    }

    console.log('[HOOK] Complete hook installed at', Date.now());
  `);

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.indexOf('HOOK') === 0) log.info(`[browser] ${text}`);
  });
  page.on('pageerror', (err) => {
    log.error(`[page-error] ${err.message}`);
  });

  // 用 page.on('request') 捕获最终 URL
  const finalRequests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.indexOf('a_bogus=') !== -1 || url.indexOf('aweme') !== -1) {
      finalRequests.push({
        url: url.substring(0, 600),
        method: req.method(),
        postData: req.postData()?.substring(0, 200) || '',
        ts: Date.now(),
      });
    }
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(10000);

  // 触发真实 API
  log.info('触发 notice API...');
  await page.evaluate(async () => {
    try {
      const r = await fetch('/aweme/v1/web/im/notice/?notice_group=960', { method: 'GET', credentials: 'include' });
      console.log('[NOTICE]', r.status);
    } catch (e) {
      console.log('[ERR]', e.message);
    }
  });
  await page.waitForTimeout(5000);

  // 抓取所有数据
  const data = await page.evaluate(() => {
    return {
      origOpens: window.__origOpens || [],
      finalUrls: window.__finalUrls || [],
      navigatorAccessed: window.__navigatorAccessed || {},
      windowAccessed: window.__windowAccessed || {},
      screenAccessed: window.__screenAccessed || {},
    };
  });

  log.info(`\n=== origOpens: ${data.origOpens.length} 条 ===`);
  for (const e of data.origOpens.slice(0, 20)) {
    const hasBogus = e.url.indexOf('a_bogus') !== -1 ? '[含a_bogus]' : '';
    log.info(`  ${e.method} ${hasBogus} ${e.url.substring(0, 300)}`);
  }

  log.info(`\n=== finalUrls (send时): ${data.finalUrls.length} 条 ===`);
  for (const e of data.finalUrls.slice(0, 30)) {
    const hasBogus = e.url.indexOf('a_bogus') !== -1 ? '[含a_bogus]' : '';
    log.info(`  ${e.method} ${hasBogus} ${e.url.substring(0, 400)}`);
  }

  log.info(`\n=== page.on('request') 最终URL: ${finalRequests.length} 条 ===`);
  for (const r of finalRequests.slice(0, 30)) {
    const hasBogus = r.url.indexOf('a_bogus') !== -1 ? '[含a_bogus]' : '';
    log.info(`  ${r.method} ${hasBogus} ${r.url.substring(0, 400)}`);
  }

  log.info(`\n=== navigator 字段访问 ===`);
  for (const k of Object.keys(data.navigatorAccessed)) {
    log.info(`  ${k} = ${data.navigatorAccessed[k]}`);
  }

  log.info(`\n=== window 字段访问 ===`);
  for (const k of Object.keys(data.windowAccessed)) {
    log.info(`  ${k} = ${data.windowAccessed[k]}`);
  }

  log.info(`\n=== screen 字段访问 ===`);
  for (const k of Object.keys(data.screenAccessed)) {
    log.info(`  ${k} = ${data.screenAccessed[k]}`);
  }

  fs.writeFileSync('data/probe-xhr-hook.json', JSON.stringify({ origOpens: data.origOpens, finalUrls: data.finalUrls, finalRequests, navigatorAccessed: data.navigatorAccessed, windowAccessed: data.windowAccessed, screenAccessed: data.screenAccessed }, null, 2));
  log.info(`\n数据已保存到 data/probe-xhr-hook.json`);

  await browser.close();
})();
