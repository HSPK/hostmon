export type FrameCallback = (nowSeconds: number) => void;

export class FrameScheduler {
  private readonly callbacks = new Set<FrameCallback>();
  private frame = 0;
  private running = false;

  add(callback: FrameCallback): () => void {
    this.callbacks.add(callback);
    this.start();
    return () => this.callbacks.delete(callback);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private readonly tick = (): void => {
    if (!this.running) return;
    if (!document.hidden) {
      const now = Date.now() / 1000;
      for (const callback of this.callbacks) callback(now);
    }
    this.frame = requestAnimationFrame(this.tick);
  };
}
