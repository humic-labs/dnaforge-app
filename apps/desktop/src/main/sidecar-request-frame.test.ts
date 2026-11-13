import { describe, expect, it } from 'vitest';
import { isTrustedSidecarRequestOwner } from './sidecar-request-auth';

const url = 'file:///app/renderer/index.html';
const mainFrame = { url };
const webContents = { id: 41, mainFrame, isDestroyed: () => false };

describe('sidecar requesting frame authority', () => {
  it('accepts the registered application main frame', () => {
    expect(isTrustedSidecarRequestOwner({ webContents, frame: mainFrame }, 41, url)).toBe(true);
  });

  it.each([{ frame: { url: 'about:srcdoc' } }, { frame: { url } }, { frame: null }, {}])(
    'refuses subframes and absent frame identity %j',
    (request) => {
      expect(isTrustedSidecarRequestOwner({ webContents, ...request }, 41, url)).toBe(false);
    }
  );

  it('refuses the registered frame after navigation', () => {
    const frame = { url: 'https://untrusted.invalid/' };
    expect(
      isTrustedSidecarRequestOwner(
        { webContents: { ...webContents, mainFrame: frame }, frame },
        41,
        url
      )
    ).toBe(false);
  });
});
