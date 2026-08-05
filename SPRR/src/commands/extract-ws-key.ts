/**
 * 通过 Playwright 从浏览器中提取 / 监听 Frontier WebSocket
 *
 * 原理：
 *   access_key 由 webmssdk.es5.js 的 frontierSign 函数在浏览器中本地生成（VM 字节码保护）。
 *   无法在纯 Node.js 中复现，且 access_key 与浏览器会话绑定 —— 浏览器关闭后失效。
 *
 *   因此最可靠的实时监控方案：保持浏览器打开，直接监听浏览器自身建立的 WS 连接，
 *   通过 addInitScript 在页面加载前 hook WebSocket 构造函数，
 *   拦截 onmessage 事件，将二进制帧以 base64 传回 Node.js。
 */

import { createLogger } from '../utils/logger.js';
import { parseFrontierFrame, type FrontierFrame } from '../api/frontier.js';

const log = createLogger('extract-ws-key');

/** 提取结果（仅提取 access_key，不保持浏览器打开） */
export interface ExtractedWsKey {
  /** access_key（32 位十六进制） */
  accessKey: string;
  /** device_id（用户 UID） */
  deviceId: string;
  /** 完整 WS URL */
  wsUrl: string;
}

/**
 * 浏览器监听选项
 */
export interface WatchFrontierOptions {
  /** 收到帧时的回调 */
  onFrame: (frame: FrontierFrame) => void;
  /** WS 连接成功回调 */
  onOpen?: (wsUrl: string) => void;
  /** WS 关闭回调 */
  onClose?: () => void;
  /** 浏览器控制台日志回调（便于调试） */
  onConsole?: (msg: string) => void;
  /** 超时毫秒数（等待 WS 连接，默认 30 秒） */
  timeoutMs?: number;
  /** 是否使用无头模式（默认 true） */
  headless?: boolean;
}

/**
 * 保持浏览器打开，监听浏览器自身建立的 Frontier WebSocket 连接
 *
 * 实现：
 *   1. 用 page.addInitScript 在页面所有脚本之前注入 hook，替换 WebSocket 构造函数
 *   2. 用 page.exposeFunction 注册 Node.js 侧回调
 *   3. 浏览器 IM SDK 创建 WebSocket 时，hook 会在 onmessage 中读取 ArrayBuffer，
 *      转 base64 传回 Node.js
 *   4. Node.js 解码 base64 后用 parseFrontierFrame 解析 protobuf 帧
 *
 * @param storageStatePath storageState 文件路径
 * @returns close() 函数用于关闭浏览器
 */
export async function watchFrontierViaBrowser(
  storageStatePath: string,
  options: WatchFrontierOptions,
): Promise<{ close: () => Promise<void> }> {
  const { chromium } = await import('playwright');
  const { onFrame, onOpen, onClose, onConsole, timeoutMs = 30_000, headless = true } = options;

  log.info(`watchFrontierViaBrowser: 启动浏览器（storageState: ${storageStatePath}, headless: ${headless}）`);

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: storageStatePath,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  let wsClosed = false;

  // 注册 Node.js 侧回调（浏览器通过 window.__onFrontierFrame 调用）
  await page.exposeFunction('__onFrontierFrame', (base64: string) => {
    try {
      const buf = Buffer.from(base64, 'base64');
      const frame = parseFrontierFrame(buf);
      onFrame(frame);
    } catch (e) {
      log.warn(`watchFrontierViaBrowser: 帧解析失败 (${base64.length} 字符 base64)`, e);
    }
  });

  await page.exposeFunction('__onFrontierWsOpen', (wsUrl: string) => {
    log.info(`watchFrontierViaBrowser: Frontier WS 已连接 ${wsUrl.replace(/access_key=[^&]+/, 'access_key=<redacted>')}`);
    onOpen?.(wsUrl);
  });

  await page.exposeFunction('__onFrontierWsClose', () => {
    if (wsClosed) return;
    wsClosed = true;
    log.info('watchFrontierViaBrowser: Frontier WS 关闭');
    onClose?.();
  });

  await page.exposeFunction('__onFrontierLog', (msg: string) => {
    log.debug(`[browser] ${msg}`);
    onConsole?.(msg);
  });

  // 在页面所有脚本之前注入 WebSocket hook
  // 必须在 webmssdk.es5.js 加载前替换 window.WebSocket
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;

    (window as any).__frontierHooked = false;

    // 替换 WebSocket 构造函数
    const HookedWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

      // 仅 hook frontier WS
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('frontier-im.douyin.com')) {
        (window as any).__frontierHooked = true;
        // 设置 binaryType 为 arraybuffer 以便读取二进制
        ws.binaryType = 'arraybuffer';

        (window as any).__onFrontierLog?.(`[hook] 拦截到 frontier WS: ${urlStr.replace(/access_key=[^&]+/, 'access_key=<redacted>')}`);

        ws.addEventListener('open', () => {
          (window as any).__onFrontierWsOpen?.(urlStr);
        });

        ws.addEventListener('message', (event: MessageEvent) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              // 二进制帧：转 base64 传给 Node.js
              const bytes = new Uint8Array(event.data);
              let binary = '';
              // 分块处理避免 callstack 溢出
              const chunk = 0x8000;
              for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
              }
              const base64 = btoa(binary);
              (window as any).__onFrontierFrame?.(base64);
            } else if (typeof event.data === 'string') {
              // 文本帧：也可能有内容
              const bytes = new TextEncoder().encode(event.data);
              let binary = '';
              const chunk = 0x8000;
              for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
              }
              const base64 = btoa(binary);
              (window as any).__onFrontierFrame?.(base64);
            }
          } catch (e) {
            (window as any).__onFrontierLog?.(`[hook] message 处理错误: ${e}`);
          }
        });

        ws.addEventListener('close', () => {
          (window as any).__onFrontierWsClose?.();
        });
      }

      return ws;
    } as unknown as typeof WebSocket;

    // 保持原型链和静态属性（静态常量是只读，需 as any 赋值）
    HookedWebSocket.prototype = OriginalWebSocket.prototype;
    (HookedWebSocket as unknown as { CONNECTING: number }).CONNECTING = OriginalWebSocket.CONNECTING;
    (HookedWebSocket as unknown as { OPEN: number }).OPEN = OriginalWebSocket.OPEN;
    (HookedWebSocket as unknown as { CLOSING: number }).CLOSING = OriginalWebSocket.CLOSING;
    (HookedWebSocket as unknown as { CLOSED: number }).CLOSED = OriginalWebSocket.CLOSED;

    (window as any).WebSocket = HookedWebSocket;

    (window as any).__onFrontierLog?.('[hook] WebSocket 构造函数已替换');
  });

  // 导航到聊天页面（触发 IM SDK 初始化和 WS 连接）
  log.info('watchFrontierViaBrowser: 导航到 /chat ...');
  await page.goto('https://www.douyin.com/chat?isPopup=1', {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });

  // 等待 WS 连接建立
  const connected = await page
    .waitForFunction(() => (window as any).__frontierHooked === true, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!connected) {
    log.warn('watchFrontierViaBrowser: 等待 frontier WS 连接超时（可能页面未正确加载）');
  }

  return {
    close: async () => {
      try {
        await browser.close();
      } catch {
        // 忽略关闭错误
      }
    },
  };
}

/**
 * 仅提取 access_key（不保持浏览器打开，提取后关闭浏览器）
 *
 * 注意：access_key 与浏览器会话绑定，浏览器关闭后可能失效。
 * 如果需要持续监听，应使用 watchFrontierViaBrowser。
 *
 * @param storageStatePath storageState 文件路径
 * @param timeoutMs 超时毫秒数（默认 30 秒）
 * @returns 提取结果
 */
export async function extractWsAccessKey(
  storageStatePath: string,
  timeoutMs = 30_000,
): Promise<ExtractedWsKey> {
  const { chromium } = await import('playwright');

  log.info(`extractWsAccessKey: 启动浏览器（storageState: ${storageStatePath}）`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: storageStatePath,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`提取 access_key 超时（${timeoutMs}ms）`)),
        timeoutMs,
      );
    });

    const wsUrlPromise = new Promise<string>((resolve) => {
      page.on('websocket', (ws) => {
        const url = ws.url();
        log.info(`extractWsAccessKey: 检测到 WS 连接: ${url}`);
        if (url.includes('frontier-im.douyin.com') && url.includes('access_key=')) {
          log.info('extractWsAccessKey: 找到 Frontier WS 连接');
          resolve(url);
        }
      });
    });

    log.info('extractWsAccessKey: 导航到 /chat ...');
    await page.goto('https://www.douyin.com/chat?isPopup=1', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    const wsUrl = await Promise.race([wsUrlPromise, timeoutPromise]);

    const urlObj = new URL(wsUrl);
    const accessKey = urlObj.searchParams.get('access_key') || '';
    const deviceId = urlObj.searchParams.get('device_id') || '';

    if (!accessKey) {
      throw new Error('WS URL 中未找到 access_key 参数');
    }

    log.info(`extractWsAccessKey: 成功提取 access_key=${accessKey.slice(0, 8)}... device_id=${deviceId}`);

    return {
      accessKey,
      deviceId,
      wsUrl,
    };
  } finally {
    await browser.close();
  }
}
