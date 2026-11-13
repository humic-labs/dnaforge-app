import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCompiledBroadDemandRefreshRequired } from './indexed-compiled-broad-demand-refresh';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const ready = {
  policyValid: true,
  hasCurrentOwner: true,
  planStatus: 'broad-ready',
  detailStillOwnsLatestCamera: false,
  readyDetailMatchesCurrentLease: false,
  presenterOwnsCurrentCamera: true,
};

describe('isCompiledBroadDemandRefreshRequired', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('function isCompiledBroadDemandRefreshRequired');
  });

  it('fail-closes when policy or owner authority is missing', () => {
    expect(isCompiledBroadDemandRefreshRequired({ ...ready, policyValid: false })).toBe(true);
    expect(isCompiledBroadDemandRefreshRequired({ ...ready, hasCurrentOwner: false })).toBe(true);
  });

  it('skips rebuild when a ready detail lease still owns the latest camera', () => {
    expect(
      isCompiledBroadDemandRefreshRequired({
        ...ready,
        planStatus: 'detail-required',
        detailStillOwnsLatestCamera: true,
        readyDetailMatchesCurrentLease: true,
        presenterOwnsCurrentCamera: false,
      })
    ).toBe(false);
    expect(
      isCompiledBroadDemandRefreshRequired({
        ...ready,
        planStatus: 'detail-required',
        detailStillOwnsLatestCamera: true,
        readyDetailMatchesCurrentLease: false,
        presenterOwnsCurrentCamera: false,
      })
    ).toBe(true);
  });

  it('skips rebuild only when the presenter still owns the latest broad camera', () => {
    expect(isCompiledBroadDemandRefreshRequired(ready)).toBe(false);
    expect(
      isCompiledBroadDemandRefreshRequired({
        ...ready,
        presenterOwnsCurrentCamera: false,
      })
    ).toBe(true);
  });
});
