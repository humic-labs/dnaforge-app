import { describe, expect, it } from 'vitest';
import { createConversationSendLease } from './send-lease';

describe('conversation send lease', () => {
  it('rejects a second same-conversation claim synchronously', () => {
    const lease = createConversationSendLease();

    const first = lease.tryAcquire('conversation-a');
    const second = lease.tryAcquire('conversation-a');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('allows different conversations to run concurrently', () => {
    const lease = createConversationSendLease();

    const first = lease.tryAcquire('conversation-a');
    const second = lease.tryAcquire('conversation-b');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('releases only the matching claim and makes release idempotent', () => {
    const lease = createConversationSendLease();
    const first = lease.tryAcquire('conversation-a');
    expect(first).not.toBeNull();

    first?.release();
    first?.release();

    const next = lease.tryAcquire('conversation-a');
    expect(next).not.toBeNull();
  });
});
