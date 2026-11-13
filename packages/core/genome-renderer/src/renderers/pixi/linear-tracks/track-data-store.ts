export class TrackDataStore {
  private data = new Map<string, unknown>();

  set(trackId: string, value: unknown): void {
    this.data.set(trackId, value);
  }

  get<TData = unknown>(trackId: string): TData | null {
    const value = this.data.get(trackId);
    return value === undefined ? null : (value as TData);
  }

  has(trackId: string): boolean {
    return this.data.has(trackId);
  }

  delete(trackId: string): void {
    this.data.delete(trackId);
  }

  clear(): void {
    this.data.clear();
  }
}
