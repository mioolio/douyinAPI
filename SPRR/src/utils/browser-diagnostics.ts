import { redactLogText, type Logger } from './logger.js';

/** 页面自己的警告属于诊断；每种消息在当前页面生命周期只输出一次。 */
export function createBrowserDiagnostics(log: Logger): (type: string, message: string) => void {
  const seen = new Set<string>();
  return (type, message) => {
    const safeMessage = redactLogText(message);
    const key = `${type}:${safeMessage}`;
    if (seen.has(key)) return;
    if (seen.size >= 256) seen.delete(seen.values().next().value!);
    seen.add(key);
    log.debug(`[browser:${type}] ${safeMessage}`);
  };
}
