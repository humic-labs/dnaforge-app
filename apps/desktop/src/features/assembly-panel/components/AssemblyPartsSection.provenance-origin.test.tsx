import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import { useCanvasStore } from '../../canvas/store';
import { useSequenceStore } from '../../sequence/store';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { AssemblyPartsSection } from './AssemblyPartsSection';

const PLASMID_LENGTH = 4898;
const MCS_START = 3913;
const BACKBONE_START = 4000;
const BACKBONE_LENGTH = PLASMID_LENGTH - 87;

const SOURCE = 'sequence-prs416';

function region(overrides: Partial<DesignRegion>): DesignRegion {
  return {
    id: 'a',
    sourceSequenceId: SOURCE,
    sourceSequenceName: 'pRS416 backbone (URA3, CEN6/ARSH4, AmpR, ori)',
    sourceStart: 0,
    sourceEnd: 12,
    sequence: 'A'.repeat(BACKBONE_LENGTH),
    annotations: [],
    sourceType: 'pcr',
    ...overrides,
  };
}

function design(r: DesignRegion): SequenceDesign {
  const now = new Date('2026-05-10T00:00:00.000Z');
  return {
    id: 'origin-span-design',
    name: 'Origin span',
    topology: 'circular',
    regions: [r],
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function clickSourceLinkAndReadViewState(r: DesignRegion) {
  const d = design(r);
  useDesignStore.setState({ designs: { [d.id]: d }, activeDesignId: d.id });
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: SOURCE,
    sequenceDocument: { kind: 'catalog-sequence', entityId: SOURCE },
    label: 'pRS416.gb',
  });
  render(<AssemblyPartsSection design={d} />);
  fireEvent.click(screen.getByTestId('assembly-part-source-link-a'));
  const tab = useCanvasStore.getState().panels.main.tabs.find((t) => t.id === tabId);
  return tab?.viewState;
}

describe('origin-spanning part provenance highlight', () => {
  beforeEach(() => {
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    useSequenceStore.getState().clearAll();
  });

  it('CONTROL — a normal, non-spanning part highlights its real span', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({ sourceStart: 100, sourceEnd: 600, sequence: 'A'.repeat(500) })
    );
    expect(vs?.highlightRange).toEqual({ start: 100, end: 599 });
  });

  it('CASE 1 — origin-spanning, circular flag SET', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({ sourceStart: BACKBONE_START, sourceEnd: MCS_START, sourceIsCircular: true })
    );
    const hr = vs?.highlightRange as { start: number; end: number; wraps?: boolean } | undefined;
    const covered = hr?.wraps
      ? PLASMID_LENGTH - hr.start + hr.end + 1
      : (hr?.end ?? 0) - (hr?.start ?? 0) + 1;
    expect(covered).toBe(BACKBONE_LENGTH);
  });

  it('CASE 2 — origin-spanning, circular flag NOT set', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({ sourceStart: BACKBONE_START, sourceEnd: MCS_START })
    );
    const hr = vs?.highlightRange as { start: number; end: number; wraps?: boolean } | undefined;
    const covered = hr?.wraps
      ? PLASMID_LENGTH - hr.start + hr.end + 1
      : (hr?.end ?? 0) - (hr?.start ?? 0) + 1;
    expect(covered).toBe(BACKBONE_LENGTH);
  });

  it('CASE 3 — origin-spanning stored UNWRAPPED, length known from the part', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({
        sourceStart: BACKBONE_START,
        sourceEnd: BACKBONE_START + BACKBONE_LENGTH,
        sourceLength: PLASMID_LENGTH,
        sourceIsCircular: true,
      })
    );
    const hr = vs?.highlightRange as { start: number; end: number; wraps?: boolean } | undefined;
    expect(hr?.end).toBeLessThan(PLASMID_LENGTH);
    expect(hr?.wraps).toBe(true);
    expect(PLASMID_LENGTH - hr!.start + hr!.end + 1).toBe(BACKBONE_LENGTH);
  });

  it('CASE 4 — origin-spanning stored UNWRAPPED, length known only from the loaded source', () => {
    useSequenceStore.getState().setSequence(SOURCE, {
      id: SOURCE,
      name: 'pRS416',
      sequence: 'A'.repeat(PLASMID_LENGTH),
      length: PLASMID_LENGTH,
      circular: true,
      annotations: [],
    });
    const vs = clickSourceLinkAndReadViewState(
      region({
        sourceStart: BACKBONE_START,
        sourceEnd: BACKBONE_START + BACKBONE_LENGTH,
      })
    );
    const hr = vs?.highlightRange as { start: number; end: number; wraps?: boolean } | undefined;
    expect(hr?.end).toBeLessThan(PLASMID_LENGTH);
    expect(hr?.wraps).toBe(true);
    expect(PLASMID_LENGTH - hr!.start + hr!.end + 1).toBe(BACKBONE_LENGTH);
  });

  it('a part ending exactly ON the origin covers to the last base and does NOT wrap', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({
        sourceStart: 100,
        sourceEnd: 0,
        sourceLength: PLASMID_LENGTH,
        sourceIsCircular: true,
      })
    );
    expect(vs?.highlightRange).toEqual({ start: 100, end: PLASMID_LENGTH - 1 });
    expect((vs?.highlightRange as { wraps?: boolean }).wraps).toBeUndefined();
  });

  it('a zero-length span does NOT light up the whole molecule', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({
        sourceStart: 500,
        sourceEnd: 500,
        sourceLength: PLASMID_LENGTH,
        sourceIsCircular: true,
      })
    );
    const hr = vs?.highlightRange as { start: number; end: number; wraps?: boolean };
    expect(hr.wraps).toBeUndefined();
    expect(hr.end).toBeGreaterThanOrEqual(hr.start);
    expect(hr).toEqual({ start: 500, end: 500 });
  });

  it('leaves an ordinary non-spanning part untouched', () => {
    const vs = clickSourceLinkAndReadViewState(
      region({ sourceStart: 10, sourceEnd: 30, sequence: 'A'.repeat(20) })
    );
    expect(vs?.highlightRange).toEqual({ start: 10, end: 29 });
    expect(vs?.scrollPosition).toBe(11);
  });
});
