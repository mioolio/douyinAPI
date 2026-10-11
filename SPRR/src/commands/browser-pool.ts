/** REPL 内复用发送浏览器；生命周期操作按顺序执行。 */
import { BrowserSender } from './browser-send.js';
import { createSenderPool } from './sender-pool.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser-pool');
const pool = createSenderPool((statePath, headless) => {
  log.info('启动发送浏览器，后续 send/reply 将复用');
  return new BrowserSender(statePath, headless);
});

export function getBrowserSender(statePath: string, headless = true): Promise<BrowserSender> {
  return pool.get(statePath, headless);
}

export async function closeBrowserSender(): Promise<void> {
  await pool.close();
}

export function isBrowserSenderReady(): boolean {
  return pool.isReady();
}
