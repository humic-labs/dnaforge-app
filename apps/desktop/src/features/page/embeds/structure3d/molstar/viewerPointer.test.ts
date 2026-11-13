// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bindMolstarCanvasCursor } from './viewerPointer';

function pointer(target: EventTarget, type: string, buttons = 0, x = 0) {
  target.dispatchEvent(new MouseEvent(type, { buttons, clientX: x, bubbles: true }));
}

describe('protein canvas cursor', () => {
  it('uses an arrow for clicks, a closed hand for dragging, and resets on release outside the canvas', () => {
    const canvas = document.createElement('canvas');
    const cleanup = bindMolstarCanvasCursor(canvas);
    try {
      expect(canvas.style.cursor).toBe('default');
      pointer(canvas, 'pointerdown', 1);
      pointer(window, 'pointermove', 1, 1);
      expect(canvas.style.cursor).toBe('default');
      pointer(window, 'pointermove', 1, 10);
      expect(canvas.style.cursor).toBe('grabbing');
      pointer(window, 'pointerup');
      expect(canvas.style.cursor).toBe('default');
    } finally {
      cleanup();
    }
  });

  it('recovers after a lost release, cancellation or window blur', () => {
    const canvas = document.createElement('canvas');
    const cleanup = bindMolstarCanvasCursor(canvas);
    try {
      for (const end of ['pointermove', 'pointercancel', 'blur']) {
        pointer(canvas, 'pointerdown', 2);
        pointer(window, 'pointermove', 2, 10);
        expect(canvas.style.cursor).toBe('grabbing');
        pointer(window, end);
        expect(canvas.style.cursor).toBe('default');
        pointer(window, 'pointermove', 2, 20);
        expect(canvas.style.cursor).toBe('default');
      }
    } finally {
      cleanup();
    }
  });

  it('removes gesture listeners and restores the original style on detach', () => {
    const canvas = document.createElement('canvas');
    canvas.style.cursor = 'crosshair';
    const cleanup = bindMolstarCanvasCursor(canvas);
    pointer(canvas, 'pointerdown', 1);
    pointer(window, 'pointermove', 1, 10);
    cleanup();
    expect(canvas.style.cursor).toBe('crosshair');
    pointer(window, 'pointermove');
    expect(canvas.style.cursor).toBe('crosshair');
  });
});
