import { describe, expect, it, vi } from 'vitest';
import { TerminalClipboard } from './clipboard';

describe('native terminal clipboard paste', () => {
  it('awaits the native clipboard read before capturing text for paste', async () => {
    const paste = vi.fn();
    const terminal = {
      flush: vi.fn(async () => undefined),
      bracketedPasteMode: vi.fn(() => true),
      paste,
    };
    const clipboard = new TerminalClipboard(terminal, async () => 'async clipboard');
    const token = await clipboard.request(1, 'owned', true);
    expect(paste).not.toHaveBeenCalled();
    expect(await clipboard.commit(1, 'owned', token)).toBe(true);
    expect(paste).toHaveBeenCalledExactlyOnceWith(1, 'owned', 'async clipboard');
  });
  it('rejects a session detached while the native clipboard read is pending', async () => {
    let finishRead: (value: string) => void = () => {};
    let owned = true;
    const paste = vi.fn();
    const terminal = {
      flush: vi.fn(async () => undefined),
      bracketedPasteMode: vi.fn(() => {
        if (!owned) throw new Error('not owned');
        return true;
      }),
      paste,
    };
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        })
    );
    const clipboard = new TerminalClipboard(terminal, read);
    const request = clipboard.request(1, 'owned', true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    owned = false;
    clipboard.clear(1);
    finishRead('detached clipboard');
    await expect(request).rejects.toThrow('not owned');
    expect(paste).not.toHaveBeenCalled();
  });
  function fixture() {
    const read = vi.fn(() => 'first\r\nsecond\n');
    const paste = vi.fn();
    let bracketed = false;
    const terminal = {
      flush: vi.fn(async () => undefined),
      bracketedPasteMode(owner: number, id: string) {
        if (owner !== 1 || id !== 'owned') throw new Error('not owned');
        return bracketed;
      },
      paste,
    };
    const clipboard = new TerminalClipboard(terminal, read);
    return {
      clipboard,
      read,
      paste,
      bracket: () => {
        bracketed = true;
      },
      unbracket: () => {
        bracketed = false;
      },
    };
  }
  it('checks ownership before reading and returns only an opaque confirmation token', async () => {
    const { clipboard, read, paste } = fixture();
    await expect(clipboard.request(2, 'owned', true)).rejects.toThrow('not owned');
    expect(read).not.toHaveBeenCalled();
    const token = await clipboard.request(1, 'owned', true);
    expect(token).toMatch(/^[\da-f-]{36}$/);
    expect(paste).not.toHaveBeenCalled();
    expect(() => clipboard.confirm(2, 'owned', token!, true)).toThrow();
    clipboard.confirm(1, 'owned', token!, true);
    expect(paste).toHaveBeenCalledExactlyOnceWith(1, 'owned', 'first\r\nsecond\n');
    expect(() => clipboard.confirm(1, 'owned', token!, true)).toThrow();
  });
  it('cancels without writing and invalidates pending content when its window detaches', async () => {
    const { clipboard, paste } = fixture();
    const token = await clipboard.request(1, 'owned', true);
    clipboard.confirm(1, 'owned', token!, false);
    expect(paste).not.toHaveBeenCalled();
    const next = await clipboard.request(1, 'owned', true);
    clipboard.clear(1);
    expect(() => clipboard.confirm(1, 'owned', next!, true)).toThrow();
    expect(paste).not.toHaveBeenCalled();
  });
  it('stages bracketed paste without overtaking earlier renderer input', async () => {
    const { clipboard, bracket, paste } = fixture();
    bracket();
    const token = await clipboard.request(1, 'owned', true);
    expect(paste).not.toHaveBeenCalled();
    expect(token).toMatch(/^[\da-f-]{36}$/);
    expect(await clipboard.commit(1, 'owned', token!)).toBe(true);
    expect(paste).toHaveBeenCalledExactlyOnceWith(1, 'owned', 'first\r\nsecond\n');
    await expect(clipboard.commit(1, 'owned', token!)).rejects.toThrow();
  });
  it('keeps a second captured paste behind an earlier pending confirmation', async () => {
    const { clipboard, read, paste } = fixture();
    const first = await clipboard.request(1, 'owned', true);
    read.mockReturnValue('later clipboard');
    const second = await clipboard.request(1, 'owned', true);
    expect(paste).not.toHaveBeenCalled();
    clipboard.confirm(1, 'owned', first!, true);
    clipboard.confirm(1, 'owned', second!, true);
    expect(paste.mock.calls.map((call) => call[2])).toEqual([
      'first\r\nsecond\n',
      'later clipboard',
    ]);
  });
  it('rechecks native bracketed-paste mode after earlier input before committing', async () => {
    const { clipboard, bracket, unbracket, paste } = fixture();
    bracket();
    const token = await clipboard.request(1, 'owned', true);
    unbracket();
    expect(await clipboard.commit(1, 'owned', token)).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    clipboard.confirm(1, 'owned', token, false);
    await expect(clipboard.commit(1, 'owned', token)).rejects.toThrow();
  });
});
