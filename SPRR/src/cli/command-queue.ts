/** Serialize REPL actions so two lines cannot mutate the active account concurrently. */
export class CommandQueue {
  private pending: Promise<void> = Promise.resolve();

  enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  drain(): Promise<void> { return this.pending; }
}
