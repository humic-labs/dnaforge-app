import type { IParser, ITheme } from '@xterm/headless';

export function observeTerminalColorSchemeMode(
  parser: IParser,
  changed: (enabled: boolean) => void
) {
  let enabled = false;
  const set = (value: boolean) => {
    if (enabled !== value) {
      enabled = value;
      changed(value);
    }
  };
  const subscriptions = [
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2031)) set(true);
      return false;
    }),
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(2031)) set(false);
      return false;
    }),
    parser.registerEscHandler({ final: 'c' }, () => {
      set(false);
      return false;
    }),
  ];
  return {
    get enabled() {
      return enabled;
    },
    set,
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

function paletteSignature(theme: ITheme): string {
  return JSON.stringify(
    Object.entries(theme)
      .filter(([key]) => !key.startsWith('cursor') && !key.startsWith('selection'))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function scheme(theme: ITheme): 1 | 2 | undefined {
  const match = /^#([\da-f]{6})(?:[\da-f]{2})?$/i.exec(theme.background ?? '');
  if (!match) return undefined;
  const rgb = Number.parseInt(match[1]!, 16);
  return 0.299 * (rgb >> 16) + 0.587 * ((rgb >> 8) & 255) + 0.114 * (rgb & 255) > 128 ? 2 : 1;
}

export class TerminalColorScheme {
  private readonly mode;
  private readonly subscriptions;
  private signature: string;
  private disposed = false;

  constructor(
    parser: IParser,
    private readonly theme: () => ITheme,
    private readonly send: (data: string) => void
  ) {
    this.signature = paletteSignature(theme());
    this.mode = observeTerminalColorSchemeMode(parser, () => undefined);
    this.subscriptions = [
      parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
        if (params.length !== 1 || params[0] !== 996) return false;
        this.report();
        return true;
      }),
      parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
        if (params.length !== 1 || params[0] !== 2031) return false;
        send(`\x1b[?2031;${this.mode.enabled ? 1 : 2}$y`);
        return true;
      }),
    ];
  }

  restore(enabled: boolean): void {
    this.mode.set(enabled);
  }

  resynchronize(): void {
    if (!this.disposed && this.mode.enabled) this.report();
  }

  private report(): void {
    const value = scheme(this.theme());
    if (value !== undefined) this.send(`\x1b[?997;${value}n`);
  }

  paletteChanged(): void {
    if (this.disposed) return;
    const next = paletteSignature(this.theme());
    if (next === this.signature) return;
    this.signature = next;
    if (this.mode.enabled) this.report();
  }

  dispose(): void {
    this.disposed = true;
    this.mode.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
