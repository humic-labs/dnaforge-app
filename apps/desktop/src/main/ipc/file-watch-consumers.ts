export class FileWatchConsumers {
  private readonly consumersByPath = new Map<string, Map<number, number>>();
  private readonly pathsBySender = new Map<number, Map<string, number>>();

  acquire(filePath: string, senderId: number): boolean {
    const consumers = this.consumersByPath.get(filePath) ?? new Map<number, number>();
    const firstConsumer = consumers.size === 0;
    consumers.set(senderId, (consumers.get(senderId) ?? 0) + 1);
    this.consumersByPath.set(filePath, consumers);

    const paths = this.pathsBySender.get(senderId) ?? new Map<string, number>();
    paths.set(filePath, (paths.get(filePath) ?? 0) + 1);
    this.pathsBySender.set(senderId, paths);
    return firstConsumer;
  }

  release(filePath: string, senderId: number, count = 1): boolean {
    const consumers = this.consumersByPath.get(filePath);
    const current = consumers?.get(senderId) ?? 0;
    const released = Math.min(current, Math.max(0, count));
    if (released === 0) return false;

    const remaining = current - released;
    if (remaining > 0) consumers?.set(senderId, remaining);
    else consumers?.delete(senderId);
    const lastConsumer = consumers?.size === 0;
    if (lastConsumer) this.consumersByPath.delete(filePath);

    const paths = this.pathsBySender.get(senderId);
    const senderRemaining = Math.max(0, (paths?.get(filePath) ?? 0) - released);
    if (senderRemaining > 0) paths?.set(filePath, senderRemaining);
    else paths?.delete(filePath);
    if (paths?.size === 0) this.pathsBySender.delete(senderId);
    return lastConsumer;
  }

  releaseSender(senderId: number): string[] {
    const paths = [...(this.pathsBySender.get(senderId)?.entries() ?? [])];
    const pathsWithoutConsumers: string[] = [];
    for (const [filePath, count] of paths) {
      if (this.release(filePath, senderId, count)) pathsWithoutConsumers.push(filePath);
    }
    return pathsWithoutConsumers;
  }

  clear(): void {
    this.consumersByPath.clear();
    this.pathsBySender.clear();
  }
}
