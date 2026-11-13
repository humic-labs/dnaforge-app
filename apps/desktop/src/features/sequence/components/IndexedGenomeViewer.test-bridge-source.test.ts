// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const indexedGenomeViewerSource = readFileSync(
  'src/features/sequence/components/IndexedGenomeViewer.tsx',
  'utf8'
);

describe('IndexedGenomeViewer test viewport bridge', () => {
  it('leaves viewport notification to the native camera that publishes its readback', () => {
    const bridge = indexedGenomeViewerSource.match(
      /setViewport: \(range: \{ start: number; end: number \}\) => \{([\s\S]*?)\n      \},/
    )?.[1];
    expect(bridge).toContain('webglRef.current?.setViewport({ start, end });');
    expect(bridge).not.toContain('handleCameraChange');
  });
});
