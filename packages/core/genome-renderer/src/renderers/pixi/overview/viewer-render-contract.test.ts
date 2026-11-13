import { describe, expect, it } from 'vitest';

import { linearViewerRenderContract } from './viewer-render-contract';

describe('linearViewerRenderContract', () => {
  it('does not expose a stale linear atlas crossfade policy', () => {
    const contract = linearViewerRenderContract({
      bpLeftX: (bp) => bp * 0.5,
      fwdStrandTop: 42,
      pixelsPerBp: 0.5,
      viewStartBp: 10,
    });

    expect(contract.projectX(20)).toBe(10);
    expect(contract.projectY(-6)).toBe(36);
    expect(contract.pixelsPerBp).toBe(0.5);
    expect(contract.xOriginBp).toBe(10);
    expect('crossfade' in contract).toBe(false);
  });
});
