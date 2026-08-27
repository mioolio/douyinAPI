/**
 * 浏览器单例池（核心性能修复）
 *
 * 问题背景：
 *   原 sendViaBrowser / sendQuoteReplyViaBrowser 每次发送都重新启动浏览器、
 *   导航到 douyin.com、等待 secsdk 5 秒、发送、关闭浏览器。每条消息耗时 5-7 秒。
 *
 *   抖音之所以快，是因为其 secsdk 常驻内存，发消息时直接调用已有 SDK 注入签名。
 *
 * 修复方案：
 *   在 REPL 生命周期内复用同一个 BrowserSender 实例。
 *   首次 send 命令启动浏览器（~5s 预热），后续 send / reply 直接复用（~0.5s）。
 *   切换账号 / reload / 退出 REPL 时关闭。
 *
 * 生命周期：
 *   - getBrowserSender(): 懒加载，首次调用启动，后续复用
 *   - closeBrowserSender(): 显式关闭（切账号 / reload / 退出）
 *   - statePath 变化时自动关闭旧的并启动新的
 */

import { BrowserSender } from './browser-send.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser-pool');

let _singleton: BrowserSender | null = null;
let _statePath: string | null = null;
let _headless: boolean | null = null;
/** 启动中的 Promise，防止并发首次启动产生多个实例 */
let _launching: Promise<BrowserSender> | null = null;

/**
 * 获取浏览器发送器单例
 *
 * @param statePath storageState 文件路径（用于检测账号切换）
 * @param headless 是否无头模式
 * @returns 可复用的 BrowserSender 实例
 */
export async function getBrowserSender(
  statePath: string,
  headless = true,
): Promise<BrowserSender> {
  // 已有实例且配置一致 → 直接复用
  if (_singleton && _statePath === statePath && _headless === headless) {
    log.debug('browser-pool: 复用已有浏览器实例');
    return _singleton;
  }

  // statePath 或 headless 变了 → 关闭旧的
  if (_singleton && (_statePath !== statePath || _headless !== headless)) {
    log.info('browser-pool: 配置变更，关闭旧浏览器实例...');
    await closeBrowserSender();
  }

  // 防止并发首次启动
  if (_launching) {
    return _launching;
  }

  _launching = (async () => {
    log.info('browser-pool: 首次启动浏览器（后续命令将复用，免去重复启动开销）...');
    const sender = new BrowserSender(statePath, headless);
    await sender.launch();
    _singleton = sender;
    _statePath = statePath;
    _headless = headless;
    _launching = null;
    log.info('browser-pool: 浏览器就绪，后续 send/reply 将直接复用');
    return sender;
  })();

  return _launching;
}

/** 关闭浏览器单例（切账号 / reload / 退出 REPL 时调用） */
export async function closeBrowserSender(): Promise<void> {
  if (_launching) {
    // 等待正在进行的启动完成后再关闭
    try {
      await _launching;
    } catch {
      // 启动失败也继续关闭
    }
  }
  if (_singleton) {
    await _singleton.close();
    _singleton = null;
    _statePath = null;
    _headless = null;
    log.info('browser-pool: 浏览器单例已关闭');
  }
}

/** 当前单例是否已就绪（用于 watch 等场景判断是否需要预热） */
export function isBrowserSenderReady(): boolean {
  return _singleton !== null;
}
