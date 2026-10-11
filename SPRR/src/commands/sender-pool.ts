export interface SenderLifecycle {
  launch(): Promise<void>;
  close(): Promise<void>;
  isAlive?(): boolean;
}

/** 串行处理启动、配置变更和关闭；失败不会污染后续队列。 */
export function createSenderPool<T extends SenderLifecycle>(
  factory: (statePath: string, headless: boolean) => T,
) {
  let current: { sender: T; statePath: string; headless: boolean } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let pendingCloses = 0;

  const serialized = <R>(operation: () => Promise<R>): Promise<R> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const closeCurrent = async () => {
    const previous = current;
    current = null;
    if (previous) await previous.sender.close();
  };

  return {
    get(statePath: string, headless = true): Promise<T> {
      return serialized(async () => {
        if (current && current.statePath === statePath && current.headless === headless
          && (current.sender.isAlive?.() ?? true)) {
          return current.sender;
        }
        await closeCurrent();
        const sender = factory(statePath, headless);
        try {
          await sender.launch();
          current = { sender, statePath, headless };
          return sender;
        } catch (error) {
          await sender.close().catch(() => undefined);
          throw error;
        }
      });
    },
    close(): Promise<void> {
      pendingCloses++;
      return serialized(closeCurrent).finally(() => { pendingCloses--; });
    },
    isReady(): boolean {
      return pendingCloses === 0 && current !== null && (current.sender.isAlive?.() ?? true);
    },
  };
}
