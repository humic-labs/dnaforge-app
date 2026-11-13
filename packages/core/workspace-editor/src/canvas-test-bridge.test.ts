import { describe, expect, it } from 'vitest';
import { canvasTestWindow } from './canvas-test-bridge';

describe('canvasTestWindow', () => {
  it('reads and writes the named diagnostic flags without any', () => {
    const win = canvasTestWindow({} as Window);
    win.__forceMainThreadCanvas = true;
    win.__canvasDrawnRowDiagnostics = true;
    expect(win.__forceMainThreadCanvas).toBe(true);
    expect(win.__canvasDrawnRowDiagnostics).toBe(true);
  });
});

describe('Vite import meta contract', () => {
  it('exposes test mode through the direct compile-time expression', () => {
    expect(import.meta.env.MODE).toBe('test');
    expect(import.meta.env.DEV === true || import.meta.env.MODE === 'test').toBe(true);
  });
});
