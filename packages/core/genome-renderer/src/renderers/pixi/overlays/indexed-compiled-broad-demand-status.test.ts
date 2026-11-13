import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compiledBroadDemandEarlyStatus } from './indexed-compiled-broad-demand-status';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const ready = {
  hasManifest: true,
  hasPresenter: true,
  provenanceCurrent: true,
  policyValid: true,
  hasCamera: true,
};

describe('compiledBroadDemandEarlyStatus', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('function compiledBroadDemandEarlyStatus');
  });

  it('returns not-loaded before rejected, and camera-required only after a valid policy', () => {
    expect(compiledBroadDemandEarlyStatus({ ...ready, hasManifest: false })).toEqual({
      status: 'not-loaded',
    });
    expect(compiledBroadDemandEarlyStatus({ ...ready, hasPresenter: false })).toEqual({
      status: 'not-loaded',
    });
    expect(compiledBroadDemandEarlyStatus({ ...ready, provenanceCurrent: false })).toEqual({
      status: 'rejected',
      withPolicy: false,
    });
    expect(compiledBroadDemandEarlyStatus({ ...ready, policyValid: false })).toEqual({
      status: 'rejected',
      withPolicy: true,
    });
    expect(compiledBroadDemandEarlyStatus({ ...ready, hasCamera: false })).toEqual({
      status: 'camera-required',
    });
    expect(compiledBroadDemandEarlyStatus(ready)).toBeNull();
  });
});
