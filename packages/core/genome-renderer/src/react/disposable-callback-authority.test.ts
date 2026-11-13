import { describe, expect, it, vi } from 'vitest';

import { createDisposableCallbackAuthority } from './disposable-callback-authority';

describe('createDisposableCallbackAuthority', () => {
  it('permanently severs a host callback from its retired handler', () => {
    const handler = vi.fn<(value: string) => void>();
    const authority = createDisposableCallbackAuthority(handler);

    authority.callback('before-dispose');
    authority.dispose();
    authority.callback('after-dispose');
    authority.dispose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('before-dispose');
  });
});
