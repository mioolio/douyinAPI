/** 只取消当前监控，不向 Playwright 或其他进程信号监听器广播。 */
export class WatchControl {
  active = false;
  stopRequested = false;
  private handlers = new Set<() => void>();

  start(): void {
    this.active = true;
    this.stopRequested = false;
    this.handlers.clear();
  }

  requestStop(): boolean {
    if (!this.active) return false;
    if (this.stopRequested) return true;
    this.stopRequested = true;
    for (const handler of this.handlers) handler();
    return true;
  }

  registerStop(handler: () => void): () => void {
    this.handlers.add(handler);
    if (this.stopRequested) handler();
    return () => { this.handlers.delete(handler); };
  }

  finish(): void {
    this.active = false;
    this.stopRequested = false;
    this.handlers.clear();
  }
}

export const watchControl = new WatchControl();

export function stopWatchOrClose(close: () => void, control = watchControl): void {
  if (!control.requestStop()) close();
}

/** WS 监控与轮询一样占用当前命令，清理完成后才允许切换账号。 */
export async function waitForWatchStop(cleanup: () => void | Promise<void>): Promise<void> {
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const unregister = watchControl.registerStop(resolveStop);
  const onSigInt = () => { watchControl.requestStop(); resolveStop(); };
  process.on('SIGINT', onSigInt);
  try {
    await stopped;
  } finally {
    unregister();
    process.removeListener('SIGINT', onSigInt);
    await cleanup();
  }
}
