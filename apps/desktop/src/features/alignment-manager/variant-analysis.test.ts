import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceVariantCall } from '@waypoint/api-client';
import {
  inspectVariantAnalysisCall,
  variantCallMutation,
  type VariantAnalysis,
} from './variant-analysis';
import { useCanvasStore } from '../canvas/public/store';
import { sha256Hex } from '../structure-drawer/public/api/protein-identity';
const sequence = {
  sequence: 'ATGGCTAAATGA',
  annotations: [],
  name: 'Reference',
} as AnnotatedSequence;
const call: SequenceVariantCall = {
  id: 'call-1',
  position: 4,
  reference: 'G',
  alternate: 'A',
  allele_index: 1,
  quality: 60,
  filters: ['PASS'],
  genotype: '1',
};
describe('VCF mutation projection', () => {
  it('navigates to the exact DNA evidence even when the call has no protein mapping', () => {
    const documentId = 'variant-navigation-reference';
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      recentlyClosed: [],
    });
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: documentId,
      label: 'Reference',
      sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
    });
    const analysis: VariantAnalysis = {
      kind: 'sequence-variant-analysis',
      version: 1,
      documentId,
      name: 'Sample A',
      sourceLabel: 'calls.vcf',
      sourceIdentity: 'source-A',
      referenceSha256: sha256Hex(sequence.sequence),
      chrom: 'Reference',
      sample: 'A',
      countBasis: 'AD',
      calls: [call],
      createdAt: 1,
    };
    inspectVariantAnalysisCall(analysis, sequence, call.id);
    const view = useCanvasStore
      .getState()
      .panels.main.tabs.find((tab) => tab.id === tabId)!.viewState;
    expect(view).toMatchObject({
      variantSelectedCallId: 'call-1',
      scrollPosition: 4,
      highlightRange: { start: 3, end: 3 },
    });
    expect(view?.sequenceNavigationRequestId).toBeTruthy();
  });
  it('preserves single-base coordinates and rejects changed DNA', () => {
    expect(variantCallMutation(call, sequence)).toMatchObject({
      position: 4,
      referenceBase: 'G',
      alternateBase: 'A',
      type: 'substitution',
    });
    expect(() => variantCallMutation({ ...call, reference: 'C' }, sequence)).toThrow(
      'no longer matches'
    );
  });
  it('removes VCF indel anchors once, retaining the insertion-before convention', () => {
    expect(
      variantCallMutation({ ...call, reference: 'GC', alternate: 'G' }, sequence)
    ).toMatchObject({ position: 5, referenceBase: 'C', alternateBase: '', type: 'deletion' });
    expect(
      variantCallMutation({ ...call, reference: 'G', alternate: 'GCCC' }, sequence)
    ).toMatchObject({ position: 4, referenceBase: '', alternateBase: 'CCC', type: 'insertion' });
  });
});
