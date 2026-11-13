import { createRequire } from 'node:module';
import type { ITerminalAddon } from '@xterm/headless';

export interface HeadlessSerializeAddon extends ITerminalAddon {
  serialize(options?: {
    scrollback?: number;
    excludeAltBuffer?: boolean;
    excludeModes?: boolean;
  }): string;
}

const requireAddon = createRequire(import.meta.url);
const serializationModule = requireAddon('@xterm/addon-serialize') as {
  SerializeAddon: new () => HeadlessSerializeAddon;
};
const unicodeModule = requireAddon('@xterm/addon-unicode11') as {
  Unicode11Addon: new () => ITerminalAddon;
};

export const SerializeAddon = serializationModule.SerializeAddon;
export const Unicode11Addon = unicodeModule.Unicode11Addon;
