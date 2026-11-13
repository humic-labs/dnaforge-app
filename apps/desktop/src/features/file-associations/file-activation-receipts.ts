const DEFAULT_RECEIPT_LIMIT = 256;

export class FileActivationReceiptLedger {
  private readonly deliveryIds = new Set<string>();
  private readonly insertionOrder: string[] = [];

  constructor(private readonly limit: number = DEFAULT_RECEIPT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('File activation receipt limit must be a positive integer.');
    }
  }

  admit(deliveryId: string): boolean {
    if (this.deliveryIds.has(deliveryId)) return false;
    this.deliveryIds.add(deliveryId);
    this.insertionOrder.push(deliveryId);

    while (this.insertionOrder.length > this.limit) {
      const expired = this.insertionOrder.shift();
      if (expired) this.deliveryIds.delete(expired);
    }
    return true;
  }
}
