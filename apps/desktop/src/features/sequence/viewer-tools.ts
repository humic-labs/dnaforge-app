import { isHostedCapabilityShown, type HostedCapabilityId } from '../../hosted/capabilities';

export type SequenceViewerKind = 'sequence' | 'indexed-genome';

export type SequenceRailTool =
  | 'metadata'
  | 'restriction-enzymes'
  | 'alignments'
  | 'annotations'
  | 'primers'
  | 'git-history'
  | 'structure';

export type SequenceDisplayToggle =
  | 'annotations'
  | 'annotation-color-mode'
  | 'translation'
  | 'residue-numbers'
  | 'complement'
  | 'primers'
  | 'cut-sites'
  | 'orfs';

export interface SequenceViewerTools {
  readonly kind: SequenceViewerKind;
  readonly rail: ReadonlySet<SequenceRailTool>;
  readonly display: ReadonlySet<SequenceDisplayToggle>;
}

const RAIL_CAPABILITIES: Partial<Record<SequenceRailTool, HostedCapabilityId>> = {
  primers: 'primers',
  structure: 'external-lookups',
};

function availableRail(tools: readonly SequenceRailTool[]): ReadonlySet<SequenceRailTool> {
  return new Set(
    tools.filter((tool) => {
      const capability = RAIL_CAPABILITIES[tool];
      return !capability || isHostedCapabilityShown(capability);
    })
  );
}

export const SEQUENCE_VIEWER_TOOLS: Readonly<Record<SequenceViewerKind, SequenceViewerTools>> = {
  sequence: {
    kind: 'sequence',
    rail: availableRail([
      'metadata',
      'restriction-enzymes',
      'alignments',
      'annotations',
      'primers',
      'git-history',
      'structure',
    ]),
    display: new Set<SequenceDisplayToggle>([
      'annotations',
      'annotation-color-mode',
      'translation',
      'residue-numbers',
      'complement',
      'primers',
      'cut-sites',
      'orfs',
    ]),
  },
  'indexed-genome': {
    kind: 'indexed-genome',
    rail: availableRail(['primers', 'restriction-enzymes', 'structure']),
    display: new Set<SequenceDisplayToggle>(['primers', 'cut-sites']),
  },
};
