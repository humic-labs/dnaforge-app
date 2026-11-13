export enum OperatingSystem {
  Windows = 1,
  Macintosh = 2,
  Linux = 3,
}

export class Lazy<T> {
  private cached: T | undefined;
  constructor(private readonly factory: () => T) {}
  get value(): T {
    return (this.cached ??= this.factory());
  }
}
