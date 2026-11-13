import { describe, expect, it } from 'vitest';
import { assertTerminalSender } from './trusted-sender';

describe('terminal native privilege boundary', () => {
  it('accepts the trusted main frame and refuses embedded, foreign, destroyed and unbound frames', () => {
    const frame = { url: 'http://localhost:1670/' };
    const sender = { mainFrame: frame, isDestroyed: () => false };
    expect(() =>
      assertTerminalSender({ sender, senderFrame: frame }, 'http://localhost:1670/')
    ).not.toThrow();
    expect(() => assertTerminalSender({ sender, senderFrame: { ...frame } }, frame.url)).toThrow(
      /trusted/i
    );
    expect(() =>
      assertTerminalSender({ sender, senderFrame: frame }, 'http://localhost:1420/')
    ).toThrow(/trusted/i);
    expect(() =>
      assertTerminalSender(
        { sender: { ...sender, isDestroyed: () => true }, senderFrame: frame },
        frame.url
      )
    ).toThrow(/trusted/i);
    expect(() => assertTerminalSender({ sender, senderFrame: frame }, null)).toThrow(/trusted/i);
  });
});
