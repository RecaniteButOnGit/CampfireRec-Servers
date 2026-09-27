export class NodeExecutionContext {
  private pending = new Set<Promise<unknown>>()
  private failures: unknown[] = []
  waitUntil(task: Promise<unknown>): void {
    const tracked = Promise.resolve(task).catch(error => {
      console.error('waitUntil task failed:', error)
      this.failures.push(error)
    }).finally(() => { this.pending.delete(tracked) })
    this.pending.add(tracked)
  }
  passThroughOnException(): void {}
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending])
    if (this.failures.length) throw new AggregateError(this.failures, 'waitUntil tasks failed')
  }
}
