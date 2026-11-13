export class MainWindowCreationGate<T> {
  private pending: Promise<T> | null = null;

  constructor(private readonly isDestroyed: (value: T) => boolean) {}

  async getOrCreate(current: T | null, create: () => Promise<T>): Promise<T> {
    if (current && !this.isDestroyed(current)) return current;
    if (this.pending) return this.pending;

    const pending = Promise.resolve().then(create);
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
}
