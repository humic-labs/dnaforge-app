import type { BrowserWindowConstructorOptions } from 'electron';

type MainWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'frame' | 'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'
>;

export function getWindowsTitleBarOverlay(dark: boolean, zoom = 1) {
  return {
    color: dark ? '#161413' : '#fdfdfc',
    symbolColor: dark ? '#eeece8' : '#22201c',
    height: Math.round(32 * zoom),
  };
}

export function getMainWindowChromeOptions(
  platform: NodeJS.Platform = process.platform
): MainWindowChromeOptions {
  if (platform === 'darwin') {
    return {
      frame: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
    };
  }

  if (platform === 'win32') {
    return {
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: getWindowsTitleBarOverlay(false),
    };
  }

  return {
    frame: true,
  };
}
