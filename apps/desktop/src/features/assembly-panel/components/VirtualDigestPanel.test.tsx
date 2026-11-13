// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RD_FRAGMENT_MIME_TYPE, VirtualDigestPanel } from './VirtualDigestPanel';
import type { VirtualDigestDiagnostic, VirtualDigestFragment } from '../hooks/useVirtualDigest';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/store';
import type { Annotation } from '@waypoint/sequence-utils';

function createMockFragment(
  index: number,
  upstream: string,
  downstream: string,
  enzymeName = 'TestI'
): VirtualDigestFragment {
  return {
    index,
    length: 1000,
    startPosition: index * 1000,
    endPosition: (index + 1) * 1000,
    wrapsOrigin: false,
    upstream: {
      sequence: upstream,
      enzymeName,
      enzymeNames: [enzymeName],
      sitePosition: index * 1000,
      siteOrientation: 'forward',
    },
    downstream: {
      sequence: downstream,
      enzymeName,
      enzymeNames: [enzymeName],
      sitePosition: (index + 1) * 1000,
      siteOrientation: 'forward',
    },
    ggType: 'insert',
    hasInternalSites: false,
    internalSites: [],
    annotations: [],
  };
}

describe('VirtualDigestPanel Golden Gate warning gating', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useRichSequenceClipboardStore.getState().clear();
  });

  const fragmentsWithRepeatedOverhangs: VirtualDigestFragment[] = [
    createMockFragment(0, 'CATG', 'TATG'),
    createMockFragment(1, 'GCGA', 'TATG'),
  ];
  const duplicateDiagnostic: VirtualDigestDiagnostic = {
    id: 'goldengate-duplicate-overhang:TATG',
    scope: 'goldengate',
    kind: 'goldengate-duplicate-overhang',
    severity: 'warning',
    message: 'Overhang TATG appears at 2 junctions - may cause mis-ligation',
    overhang: 'TATG',
    junctionIndices: [0, 1],
    fragmentIndices: [0, 1],
    affectedEnds: [
      { fragmentIndex: 0, end: 'downstream' },
      { fragmentIndex: 1, end: 'downstream' },
    ],
  };

  it('does not show Golden Gate duplicate-overhang warnings for a generic active-enzyme digest', () => {
    render(
      <VirtualDigestPanel
        enzymeName="AatII + BsaI + NspI + PacI"
        sequenceName="Source"
        fragments={fragmentsWithRepeatedOverhangs.map((fragment) => ({
          ...fragment,
          ggType: 'rd',
        }))}
        ggStatus="not-ready"
        digestKind="restriction"
        diagnostics={[duplicateDiagnostic]}
        overhangLength={4}
        onClose={vi.fn()}
        sourceSequence={'A'.repeat(3000)}
        sourceSequenceId="source"
      />
    );

    expect(screen.queryByTestId('collision-warning-banner')).toBeNull();
    expect(screen.queryAllByTestId('collision-warning')).toHaveLength(0);
    expect(screen.queryByText(/Duplicate overhangs detected/i)).toBeNull();
    expect(screen.queryByText(/mis-ligation/i)).toBeNull();
  });

  it('shows duplicate-overhang warnings for a single Golden Gate digest', () => {
    render(
      <VirtualDigestPanel
        enzymeName="BsaI"
        sequenceName="Source"
        fragments={fragmentsWithRepeatedOverhangs}
        ggStatus="ready-with-warning"
        digestKind="goldengate"
        diagnostics={[duplicateDiagnostic]}
        overhangLength={4}
        onClose={vi.fn()}
        sourceSequence={'A'.repeat(3000)}
        sourceSequenceId="source"
      />
    );

    expect(screen.getByTestId('collision-warning-banner')).toBeTruthy();
    expect(screen.getAllByTestId('collision-warning').length).toBeGreaterThan(0);
    expect(screen.getByText(/Duplicate overhangs detected/i)).toBeTruthy();
  });

  it('does not compute Golden Gate warnings in the panel when model diagnostics are absent', () => {
    render(
      <VirtualDigestPanel
        enzymeName="BsaI"
        sequenceName="Source"
        fragments={fragmentsWithRepeatedOverhangs}
        ggStatus="ready-with-warning"
        digestKind="goldengate"
        diagnostics={[]}
        overhangLength={4}
        onClose={vi.fn()}
        sourceSequence={'A'.repeat(3000)}
        sourceSequenceId="source"
      />
    );

    expect(screen.queryByTestId('collision-warning-banner')).toBeNull();
    expect(screen.queryAllByTestId('collision-warning')).toHaveLength(0);
  });

  it('uses identical canonical RD provenance for drag and copy of BpiI fragments', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    render(
      <VirtualDigestPanel
        enzymeName="BpiI"
        sequenceName="Source"
        fragments={[createMockFragment(0, 'CATG', 'TATG', 'BpiI')]}
        ggStatus="ready"
        digestKind="goldengate"
        diagnostics={[]}
        overhangLength={4}
        onClose={vi.fn()}
        sourceSequence={'A'.repeat(3000)}
        sourceSequenceId="source"
      />
    );

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('fragment-row-0'), {
      dataTransfer: {
        setData,
        setDragImage: vi.fn(),
        effectAllowed: '',
      },
    });
    const dragPayload = JSON.parse(
      setData.mock.calls.find(([type]) => type === RD_FRAGMENT_MIME_TYPE)?.[1]
    );

    expect(dragPayload.enzymeName).toBe('BpiI');
    expect(dragPayload.rdSourceEnzyme).toBe('BbsI');
    expect(dragPayload.rdSourceEnzymeName).toBe('BpiI');
    expect(useRichSequenceClipboardStore.getState().copiedRegion?.rdSourceEnzyme).toBe('BbsI');
    expect(useRichSequenceClipboardStore.getState().copiedRegion?.rdSourceEnzymeName).toBe('BpiI');

    useRichSequenceClipboardStore.getState().clear();
    fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));

    await waitFor(() => {
      expect(useRichSequenceClipboardStore.getState().copiedRegion?.rdSourceEnzyme).toBe('BbsI');
    });
    expect(useRichSequenceClipboardStore.getState().copiedRegion?.rdSourceEnzymeName).toBe('BpiI');
    expect(useRichSequenceClipboardStore.getState().copiedRegion?.sourceName).toContain(
      'BpiI fragment 1'
    );
  });
});

describe('VirtualDigestPanel origin-spanning annotation carryover ', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useRichSequenceClipboardStore.getState().clear();
  });

  it('carries a wrap-around source annotation through fragment drag AND copy in full', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    const sourceLength = 3000;
    const fragment: VirtualDigestFragment = {
      ...createMockFragment(0, 'CATG', 'TATG'),
      startPosition: 2900,
      endPosition: 100,
      length: 200,
      wrapsOrigin: true,
    };
    const originSpanning: Annotation = {
      name: 'ori-feature',
      type: 'misc_feature',
      start: 2996,
      end: 4,
      direction: 1,
    };

    render(
      <VirtualDigestPanel
        enzymeName="BsaI"
        sequenceName="Source"
        fragments={[fragment]}
        ggStatus="ready"
        digestKind="goldengate"
        diagnostics={[]}
        overhangLength={4}
        onClose={vi.fn()}
        sourceSequence={'A'.repeat(sourceLength)}
        sourceSequenceId="source"
        sourceAnnotations={[originSpanning]}
      />
    );

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('fragment-row-0'), {
      dataTransfer: { setData, setDragImage: vi.fn(), effectAllowed: '' },
    });
    const dragPayload = JSON.parse(
      setData.mock.calls.find(([type]) => type === RD_FRAGMENT_MIME_TYPE)?.[1]
    );
    expect(dragPayload.annotations).toEqual([
      expect.objectContaining({ name: 'ori-feature', start: 95, end: 104 }),
    ]);

    fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
    await waitFor(() => {
      expect(useRichSequenceClipboardStore.getState().copiedRegion?.annotations).toEqual([
        expect.objectContaining({ name: 'ori-feature', start: 95, end: 104 }),
      ]);
    });
  });
});
