// @vitest-environment node

import { FileActivationReceiptLedger } from './file-activation-receipts';

describe('FileActivationReceiptLedger', () => {
  it('admits a delivery id once', () => {
    const ledger = new FileActivationReceiptLedger();

    expect(ledger.admit('delivery-1')).toBe(true);
    expect(ledger.admit('delivery-1')).toBe(false);
    expect(ledger.admit('delivery-2')).toBe(true);
  });

  it('bounds retained receipts without rejecting later deliveries', () => {
    const ledger = new FileActivationReceiptLedger(2);

    expect(ledger.admit('delivery-1')).toBe(true);
    expect(ledger.admit('delivery-2')).toBe(true);
    expect(ledger.admit('delivery-3')).toBe(true);
    expect(ledger.admit('delivery-1')).toBe(true);
  });
});
