import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('indexed stadium retained camera presenter', () => {
  it('keeps the stadium retained-camera body out of the overlay class', () => {
    const source = overlaySource();
    expect(source).toContain('this.retainedLinear.updateRetainedCamera(camera)');
    expect(source).not.toContain('stadiumRetainedCameraParams(');
    expect(source).not.toContain('createStadiumRetainedCameraHost');
    expect(source).not.toContain('createRetainedDrawHost');
    expect(source).not.toContain('createBeginDrawAuditHost');
    expect(source).not.toContain('updateRetainedStadiumCameraFn(');
  });
});
