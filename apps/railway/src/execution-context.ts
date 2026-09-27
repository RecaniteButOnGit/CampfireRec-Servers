export class NodeExecutionContext {
  private pending = new Set<Promise<unknown>>()
  waitUntil(task: Promise<unknown>): void {
    const tracked = Promise.resolve(task).catch(error => {
      console.error('waitUntil task failed:', error)
    }).finally(() => { this.pending.delete(tracked) })
    this.pending.add(tracked)
  }
  passThroughOnException(): void {}
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]) }
}
