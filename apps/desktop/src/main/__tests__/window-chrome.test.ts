import { describe, expect, it } from 'vitest';

import { getMainWindowChromeOptions } from '../window-chrome';

describe('getMainWindowChromeOptions', () => {
  it('combines the Windows titlebar with native caption controls', () => {
    expect(getMainWindowChromeOptions('win32')).toEqual({
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#fdfdfc', symbolColor: '#22201c', height: 32 },
    });
  });

  it('preserves the standard Linux frame', () => {
    expect(getMainWindowChromeOptions('linux')).toEqual({ frame: true });
  });

  it('keeps the custom inset titlebar on macOS', () => {
    expect(getMainWindowChromeOptions('darwin')).toEqual({
      frame: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
    });
  });
});
