import { beforeEach, expect, it, vi } from 'vitest';
import type { ITerminalAddon } from '@xterm/xterm';
import { TerminalRendering } from './terminal-rendering';

const model = vi.hoisted(() => ({
  failGraphics: false,
  events: [] as string[],
  graphics: [] as Array<{ lose(): void; dispose: ReturnType<typeof vi.fn> }>,
  activations: new Map<object, () => void>(),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    private lost: (() => void) | undefined;
    constructor() {
      model.graphics.push(this);
      model.activations.set(this, () => this.activate());
    }
    activate() {
      model.events.push('graphics:activate');
      if (model.failGraphics) throw new Error('WebGL is unavailable');
    }
    onContextLoss(callback: () => void) {
      this.lost = callback;
      return {
        dispose: () => {
          this.lost = undefined;
        },
      };
    }
    lose() {
      this.lost?.();
    }
    dispose = vi.fn(() => {
      model.events.push('graphics:dispose');
    });
  },
}));

vi.mock('@xterm/addon-ligatures/lib/addon-ligatures.mjs', () => ({
  LigaturesAddon: class {
    constructor() {
      model.activations.set(this, () => this.activate());
    }
    activate() {
      model.events.push('ligatures:activate');
    }
    dispose() {
      model.events.push('ligatures:dispose');
    }
  },
}));

const setup = () => {
  const terminal = {
    element: document.createElement('div'),
    rows: 24,
    refresh: vi.fn(),
    loadAddon: vi.fn<(addon: ITerminalAddon) => void>(),
  };
  terminal.loadAddon.mockImplementation((addon) => {
    const activate = model.activations.get(addon);
    if (!activate) throw new Error('The test addon was not registered.');
    activate();
  });
  return { terminal, renderer: new TerminalRendering(terminal) };
};

beforeEach(() => {
  model.failGraphics = false;
  model.events.length = 0;
  model.graphics.length = 0;
  model.activations.clear();
});

it('loads optional symbol joining before creating the graphics font atlas', () => {
  const { terminal, renderer } = setup();
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: true });
  expect(model.events).toEqual(['ligatures:activate', 'graphics:activate']);
  expect(terminal.element.dataset).toMatchObject({
    terminalRenderer: 'webgl',
    terminalLigatures: 'true',
  });
});

it('keeps a readable fallback after activation failure without repeated automatic retries', () => {
  const { terminal, renderer } = setup();
  model.failGraphics = true;
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: false });
  expect(terminal.element.dataset.terminalRenderer).toBe('dom');
  expect(model.graphics[0]!.dispose).toHaveBeenCalledOnce();
  model.failGraphics = false;
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: false });
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: true });
  expect(model.graphics).toHaveLength(1);
  renderer.configure({ gpuAcceleration: 'off', fontLigatures: true });
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: true });
  expect(model.graphics).toHaveLength(2);
  expect(terminal.element.dataset.terminalRenderer).toBe('webgl');
});

it('drops a lost graphics context and repaints through the fallback', () => {
  const { terminal, renderer } = setup();
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: false });
  model.graphics[0]!.lose();
  expect(terminal.element.dataset.terminalRenderer).toBe('dom');
  expect(model.graphics[0]!.dispose).toHaveBeenCalledOnce();
  expect(terminal.refresh).toHaveBeenLastCalledWith(0, 23);
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: false });
  expect(model.graphics).toHaveLength(1);
});

it('rebuilds the graphics atlas when symbol joining changes and releases the disabled joiner', () => {
  const { terminal, renderer } = setup();
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: false });
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: true });
  expect(model.events.slice(-3)).toEqual([
    'graphics:dispose',
    'ligatures:activate',
    'graphics:activate',
  ]);
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: false });
  expect(model.events.slice(-3)).toEqual([
    'graphics:dispose',
    'ligatures:dispose',
    'graphics:activate',
  ]);
  expect(terminal.element.dataset.terminalLigatures).toBe('false');
});

it('releases each graphics resource once and ignores late callbacks after unmount', () => {
  const { terminal, renderer } = setup();
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: true });
  renderer.dispose();
  renderer.dispose();
  const refreshes = terminal.refresh.mock.calls.length;
  model.graphics[0]!.lose();
  renderer.configure({ gpuAcceleration: 'auto', fontLigatures: true });
  expect(model.graphics).toHaveLength(1);
  expect(model.graphics[0]!.dispose).toHaveBeenCalledOnce();
  expect(model.events.filter((event) => event === 'ligatures:dispose')).toHaveLength(1);
  expect(terminal.refresh).toHaveBeenCalledTimes(refreshes);
});
