import type { AcceptedAssemblyValidationIssue } from '../accepted-types';
import {
  goldenGateConflictSeverity,
  goldenGateConflictTitle,
  validateGoldenGateAssembly,
  type InternalCutSite,
  type OverhangConflict,
  type OverhangConflictType,
} from '../../design/public/validation/golden-gate-overhangs';
import {
  GIBSON_MIN_HOMOLOGY_LENGTH,
  GIBSON_MAX_HOMOLOGY_LENGTH,
} from '../../design/public/validation-constants';
import { isHomologyAssemblyMethod } from '../../design/public/restriction-digest';
import { findDuplicateSpacerGroups } from '../../design/public/spacer-invariants';
import type {
  DesignRegion,
  GoldenGateEnzyme,
  SequenceDesign,
  ValidationError,
} from '../../design/public/types';
import type { VirtualDigestDiagnosticKind } from '../../assembly-panel/public/hooks/useVirtualDigest';
import type { AssemblyWorkbenchErrorCode } from '../../junction-workbench/public/AssemblyWorkbenchContract';

export type AssemblyIssueSeverity = 'error' | 'warning' | 'info';

export type AssemblyIssueKind =
  | 'assembly-topology-unsupported'
  | 'assembly-min-fragments'
  | 'assembly-empty-part'
  | 'spacer-duplicate-junction'
  | 'gibson-rd-rd-junction'
  | 'gg-internal-site'
  | 'gg-overhang-mismatch'
  | 'gg-self-ligation'
  | 'gg-duplicate-overhang'
  | 'gg-rd-enzyme-mismatch'
  | 'gg-rd-enzyme-unknown'
  | 'gg-rd-polarity-unsupported'
  | 'gg-rd-cut-site-mismatch'
  | 'gg-rd-spacer-unsupported'
  | 'gg-junction-invalid'
  | 'gg-invalid-pair'
  | 'gg-extra-sites'
  | 'homology-length-out-of-range'
  | 'homology-length-suboptimal'
  | 'homology-tm-suboptimal'
  | 'homology-gc-suboptimal'
  | 'primer-pbs-out-of-range'
  | 'primer-pbs-suboptimal'
  | 'digest-no-cut-sites'
  | 'digest-duplicate-overhang'
  | 'export-missing-workspace'
  | 'export-not-validated'
  | 'export-finalize-failed';

export const ASSEMBLY_ISSUE_KINDS = [
  'assembly-topology-unsupported',
  'assembly-min-fragments',
  'assembly-empty-part',
  'spacer-duplicate-junction',
  'gibson-rd-rd-junction',
  'gg-internal-site',
  'gg-overhang-mismatch',
  'gg-self-ligation',
  'gg-duplicate-overhang',
  'gg-rd-enzyme-mismatch',
  'gg-rd-enzyme-unknown',
  'gg-rd-polarity-unsupported',
  'gg-rd-cut-site-mismatch',
  'gg-rd-spacer-unsupported',
  'gg-junction-invalid',
  'gg-invalid-pair',
  'gg-extra-sites',
  'homology-length-out-of-range',
  'homology-length-suboptimal',
  'homology-tm-suboptimal',
  'homology-gc-suboptimal',
  'primer-pbs-out-of-range',
  'primer-pbs-suboptimal',
  'digest-no-cut-sites',
  'digest-duplicate-overhang',
  'export-missing-workspace',
  'export-not-validated',
  'export-finalize-failed',
] as const satisfies readonly AssemblyIssueKind[];

export type AssemblyIssueSource =
  | 'dispatcher-validation'
  | 'workbench-finding'
  | 'workbench-command'
  | 'virtual-digest'
  | 'finalize'
  | 'accepted-assembly';

export type AssemblyIssueScope =
  | { type: 'assembly'; designId: string }
  | { type: 'part'; designId: string; regionId: string; fragmentIndex: number }
  | {
      type: 'junction';
      designId: string;
      junctionIndex: number;
      leftRegionId?: string;
      rightRegionId?: string;
    }
  | {
      type: 'primer';
      designId: string;
      primerId?: string;
      fragmentIndex: number;
      direction: 'forward' | 'reverse';
    }
  | { type: 'digest-preview'; sequenceId: string; fragmentId?: string }
  | { type: 'export'; designId: string };

export type AssemblyIssueAnchor =
  | { surface: 'design-drawer'; refId: string }
  | { surface: 'part-card'; regionId: string }
  | { surface: 'junction-card'; junctionIndex: number }
  | { surface: 'workbench-junction-card'; junctionIndex: number }
  | {
      surface: 'primer-row';
      primerId?: string;
      fragmentIndex: number;
      direction: 'forward' | 'reverse';
    }
  | { surface: 'digest-panel'; fragmentId?: string }
  | { surface: 'export-card'; refId: string };

export interface AssemblyIssueAction {
  id: string;
  label: string;
  anchor?: AssemblyIssueAnchor;
}

export interface AssemblyIssueGates {
  run: boolean;
  finalize: boolean;
  export: boolean;
}

export interface AssemblyIssue {
  id: string;
  dedupeKey: string;
  kind: AssemblyIssueKind;
  legacyCode: string;
  severity: AssemblyIssueSeverity;
  gates: AssemblyIssueGates;
  source: AssemblyIssueSource;
  lifecycle: 'committed' | 'provisional';
  scope: AssemblyIssueScope;
  anchors: AssemblyIssueAnchor[];
  title: string;
  shortMessage: string;
  detail: string;
  actions: AssemblyIssueAction[];
  sortKey: string;
  internalSites?: InternalCutSite[];
}

interface IssueDefaults {
  producer: AssemblyIssueSource;
  severity: AssemblyIssueSeverity;
  gates: AssemblyIssueGates;
  legacyCode: string;
  title: string;
}

const HARD_INPUT_GATES: AssemblyIssueGates = { run: true, finalize: true, export: true };
const WARNING_GATES: AssemblyIssueGates = { run: false, finalize: false, export: false };
const EXPORT_GATES: AssemblyIssueGates = { run: false, finalize: true, export: true };

export const ASSEMBLY_ISSUE_REGISTRY: Record<AssemblyIssueKind, IssueDefaults> = {
  'assembly-topology-unsupported': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'unsupported_linear_topology',
    title: 'Unsupported assembly topology',
  },
  'assembly-min-fragments': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'min_fragments',
    title: 'Not enough assembly parts',
  },
  'assembly-empty-part': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'empty_fragment',
    title: 'Empty assembly part',
  },
  'spacer-duplicate-junction': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'spacer_duplicate_junction',
    title: 'Two spacers in one gap',
  },
  'gibson-rd-rd-junction': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'gibson_rd_rd_junction',
    title: 'Restriction digest junction cannot be bridged',
  },
  'gg-internal-site': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: EXPORT_GATES,
    legacyCode: 'goldengate_internal_site',
    title: 'Enzyme site inside this part',
  },
  'gg-overhang-mismatch': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_mismatch',
    title: 'RD overhang mismatch',
  },
  'gg-self-ligation': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_self_ligation',
    title: 'Both ends have the same overhang',
  },
  'gg-duplicate-overhang': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_duplicate',
    title: 'Duplicate overhang conflict',
  },
  'gg-rd-enzyme-mismatch': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_rd_enzyme_mismatch',
    title: 'Incompatible RD enzyme',
  },
  'gg-rd-enzyme-unknown': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_rd_enzyme_unknown',
    title: 'Unsupported RD fragment',
  },
  'gg-rd-polarity-unsupported': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_rd_fragment_not_insert',
    title: "This part can't be used as an insert",
  },
  'gg-rd-cut-site-mismatch': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_rd_cut_site_mismatch',
    title: 'RD cut-site provenance mismatch',
  },
  'gg-rd-spacer-unsupported': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_rd_spacer_unsupported',
    title: 'Unsupported RD spacer junction',
  },
  'gg-junction-invalid': {
    producer: 'dispatcher-validation',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'goldengate_junction_invalid',
    title: 'Invalid Golden Gate junction',
  },
  'gg-invalid-pair': {
    producer: 'virtual-digest',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'goldengate_invalid_pair',
    title: 'Invalid Golden Gate digest pair',
  },
  'gg-extra-sites': {
    producer: 'virtual-digest',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'goldengate_extra_sites',
    title: 'Extra Golden Gate sites',
  },
  'homology-length-out-of-range': {
    producer: 'workbench-finding',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'homology_length_out_of_range',
    title: 'Homology length is outside supported range',
  },
  'homology-length-suboptimal': {
    producer: 'workbench-finding',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'homology_length_suboptimal',
    title: 'Homology length is outside the preferred range',
  },
  'homology-tm-suboptimal': {
    producer: 'workbench-finding',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'homology_tm_suboptimal',
    title: 'Homology Tm is outside the preferred range',
  },
  'homology-gc-suboptimal': {
    producer: 'workbench-finding',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'homology_gc_suboptimal',
    title: 'Homology GC content is outside preferred range',
  },
  'primer-pbs-out-of-range': {
    producer: 'workbench-finding',
    severity: 'error',
    gates: HARD_INPUT_GATES,
    legacyCode: 'primer_pbs_out_of_range',
    title: 'Primer binding length outside supported range',
  },
  'primer-pbs-suboptimal': {
    producer: 'workbench-finding',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'primer_pbs_suboptimal',
    title: 'Primer binding length outside preferred range',
  },
  'digest-no-cut-sites': {
    producer: 'virtual-digest',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'digest_no_cut_sites',
    title: 'No cut sites found',
  },
  'digest-duplicate-overhang': {
    producer: 'virtual-digest',
    severity: 'warning',
    gates: WARNING_GATES,
    legacyCode: 'digest_duplicate_overhang',
    title: 'Duplicate digest overhang',
  },
  'export-missing-workspace': {
    producer: 'finalize',
    severity: 'error',
    gates: EXPORT_GATES,
    legacyCode: 'export_missing_workspace',
    title: 'Choose a project save location',
  },
  'export-not-validated': {
    producer: 'finalize',
    severity: 'error',
    gates: EXPORT_GATES,
    legacyCode: 'export_not_validated',
    title: 'Assembly has not been validated',
  },
  'export-finalize-failed': {
    producer: 'finalize',
    severity: 'error',
    gates: EXPORT_GATES,
    legacyCode: 'export_finalize_failed',
    title: 'Finalization failed',
  },
};

export const OVERHANG_CONFLICT_MIGRATION: Record<OverhangConflictType, AssemblyIssueKind> = {
  duplicate: 'gg-duplicate-overhang',
  mismatch: 'gg-overhang-mismatch',
  'self-ligation': 'gg-self-ligation',
  'internal-site': 'gg-internal-site',
  'rd-enzyme-mismatch': 'gg-rd-enzyme-mismatch',
  'rd-enzyme-unknown': 'gg-rd-enzyme-unknown',
  'rd-fragment-not-insert': 'gg-rd-polarity-unsupported',
  'rd-cut-site-mismatch': 'gg-rd-cut-site-mismatch',
};

export const VIRTUAL_DIGEST_DIAGNOSTIC_MIGRATION: Record<
  VirtualDigestDiagnosticKind,
  AssemblyIssueKind
> = {
  'no-cut-sites': 'digest-no-cut-sites',
  'goldengate-invalid-pair': 'gg-invalid-pair',
  'goldengate-extra-sites': 'gg-extra-sites',
  'goldengate-duplicate-overhang': 'digest-duplicate-overhang',
};

export const WORKBENCH_COMMAND_DIAGNOSTIC_MIGRATION: Record<
  AssemblyWorkbenchErrorCode,
  'transient-command-outcome'
> = {
  'stale-design-version': 'transient-command-outcome',
  'unsupported-command': 'transient-command-outcome',
  'unsupported-mode-command': 'transient-command-outcome',
  'invalid-command-target': 'transient-command-outcome',
  'invalid-command-value': 'transient-command-outcome',
  'fixed-goldengate-junction': 'transient-command-outcome',
  'optimizer-data-unavailable': 'transient-command-outcome',
  'optimizer-search-limit': 'transient-command-outcome',
  'missing-source-context': 'transient-command-outcome',
  'source-window-too-small': 'transient-command-outcome',
};

export interface AssemblyIssueKeyPayload {
  designId: string;
  regionId?: string;
  fragmentIndex?: number;
  junctionIndex?: number;
  primerId?: string;
  direction?: 'forward' | 'reverse';
  expectedEnzyme?: string;
  actualEnzyme?: string | null;
  endName?: string;
  expectedSite?: string;
  actualSite?: string;
  reasonCode?: string;
  field?: string;
  overhang?: string;
}

function designIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}`;
}

function regionUnknownIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}:${payload.regionId ?? payload.fragmentIndex ?? 'unknown'}`;
}

function regionGlobalIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}:${payload.regionId ?? payload.fragmentIndex ?? 'global'}:${payload.overhang ?? payload.reasonCode ?? 'issue'}`;
}

function junctionGlobalIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}:${payload.junctionIndex ?? 'global'}:${payload.reasonCode ?? 'issue'}`;
}

function primerIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}:${payload.primerId ?? `${payload.fragmentIndex ?? 'unknown'}:${payload.direction ?? 'unknown'}`}`;
}

function digestIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}:${payload.overhang ?? payload.reasonCode ?? 'digest'}`;
}

function exportIssueKey(kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload): string {
  return `${kind}:${payload.designId}:${payload.reasonCode ?? 'export'}`;
}

const ASSEMBLY_ISSUE_KEY_BUILDERS: Record<
  AssemblyIssueKind,
  (kind: AssemblyIssueKind, payload: AssemblyIssueKeyPayload) => string
> = {
  'assembly-topology-unsupported': designIssueKey,
  'assembly-min-fragments': designIssueKey,
  'assembly-empty-part': regionUnknownIssueKey,
  'spacer-duplicate-junction': (kind, payload) =>
    `${kind}:${payload.designId}:${payload.junctionIndex ?? 'unknown'}`,
  'gibson-rd-rd-junction': (kind, payload) =>
    `${kind}:${payload.designId}:${payload.junctionIndex ?? payload.fragmentIndex ?? 'unknown'}`,
  'gg-rd-enzyme-mismatch': (kind, payload) =>
    `${kind}:${payload.designId}:${payload.regionId ?? payload.fragmentIndex ?? 'unknown'}:${payload.expectedEnzyme ?? 'unknown'}:${payload.actualEnzyme ?? 'unknown'}`,
  'gg-rd-cut-site-mismatch': (kind, payload) =>
    `${kind}:${payload.designId}:${payload.regionId ?? payload.fragmentIndex ?? 'unknown'}:${payload.endName ?? 'end'}:${payload.expectedSite ?? 'expected'}:${payload.actualSite ?? payload.overhang ?? 'actual'}:${payload.reasonCode ?? 'mismatch'}`,
  'gg-overhang-mismatch': regionGlobalIssueKey,
  'gg-self-ligation': regionGlobalIssueKey,
  'gg-duplicate-overhang': regionGlobalIssueKey,
  'gg-internal-site': regionGlobalIssueKey,
  'gg-rd-enzyme-unknown': regionGlobalIssueKey,
  'gg-rd-polarity-unsupported': regionGlobalIssueKey,
  'gg-rd-spacer-unsupported': regionGlobalIssueKey,
  'gg-junction-invalid': junctionGlobalIssueKey,
  'homology-length-out-of-range': junctionGlobalIssueKey,
  'homology-length-suboptimal': junctionGlobalIssueKey,
  'homology-tm-suboptimal': junctionGlobalIssueKey,
  'homology-gc-suboptimal': junctionGlobalIssueKey,
  'primer-pbs-out-of-range': primerIssueKey,
  'primer-pbs-suboptimal': primerIssueKey,
  'digest-no-cut-sites': digestIssueKey,
  'digest-duplicate-overhang': digestIssueKey,
  'gg-invalid-pair': digestIssueKey,
  'gg-extra-sites': digestIssueKey,
  'export-missing-workspace': exportIssueKey,
  'export-not-validated': exportIssueKey,
  'export-finalize-failed': exportIssueKey,
};

export function keyForAssemblyIssue(
  kind: AssemblyIssueKind,
  payload: AssemblyIssueKeyPayload
): string {
  const builder = ASSEMBLY_ISSUE_KEY_BUILDERS[kind];
  if (!builder) return exhaustiveIssueKind(kind as never);
  return builder(kind, payload);
}

export interface AssemblyIssueDerivationInput {
  design: SequenceDesign;
}

export function deriveAssemblyIssues(input: AssemblyIssueDerivationInput): AssemblyIssue[] {
  const design = input.design;
  const issues: AssemblyIssue[] = [];

  if (design.topology !== 'circular') {
    issues.push(
      createIssue({
        kind: 'assembly-topology-unsupported',
        design,
        scope: { type: 'assembly', designId: design.id },
        anchors: baseAnchors(design.id),
        detail: 'Assembly designs must be circular.',
        keyPayload: { designId: design.id },
        sortKey: 'assembly:topology',
      })
    );
  }

  if (design.regions.length < 2) {
    issues.push(
      createIssue({
        kind: 'assembly-min-fragments',
        design,
        scope: { type: 'assembly', designId: design.id },
        anchors: baseAnchors(design.id),
        detail: 'At least two fragments are required.',
        keyPayload: { designId: design.id },
        sortKey: 'assembly:min-fragments',
      })
    );
  }

  for (let index = 0; index < design.regions.length; index++) {
    const region = design.regions[index];
    if (!region.isPlaceholder && region.sequence.length > 0) continue;
    issues.push(
      createIssue({
        kind: 'assembly-empty-part',
        design,
        scope: { type: 'part', designId: design.id, regionId: region.id, fragmentIndex: index },
        anchors: [...baseAnchors(design.id), { surface: 'part-card', regionId: region.id }],
        detail: 'Fragment sequence is required.',
        keyPayload: {
          designId: design.id,
          regionId: region.id,
          fragmentIndex: index,
          field: `regions[${index}].sequence`,
        },
        sortKey: `part:${index}:empty`,
      })
    );
  }

  for (const group of findDuplicateSpacerGroups(design.spacers)) {
    issues.push(
      createIssue({
        kind: 'spacer-duplicate-junction',
        design,
        scope: { type: 'assembly', designId: design.id },
        anchors: [...baseAnchors(design.id)],
        detail:
          `Gap ${group.junctionIndex} holds ${group.droppedIds.length + 1} spacers. The construct ` +
          `sequence uses the first while the primers use the last, so they would not match. ` +
          `Keep one.`,
        keyPayload: {
          designId: design.id,
          junctionIndex: group.junctionIndex,
          field: `spacers[gap ${group.junctionIndex}]`,
        },
        sortKey: `spacer:${group.junctionIndex}:duplicate`,
      })
    );
  }

  issues.push(...deriveHomologyInputIssues(design));
  issues.push(...deriveHomologyQualityIssues(design));
  issues.push(...deriveGoldenGateIssues(design));

  return mergeAndSortIssues(issues);
}

export function issuesToValidationErrors(issues: readonly AssemblyIssue[]): ValidationError[] {
  return issues.filter(isLegacyValidationIssueSeverity).map((issue): ValidationError => {
    const fragmentIndex = issue.scope.type === 'part' ? issue.scope.fragmentIndex : undefined;
    const field =
      issue.scope.type === 'part'
        ? `regions[${issue.scope.fragmentIndex}]`
        : issue.scope.type === 'assembly'
          ? issue.kind === 'assembly-topology-unsupported'
            ? 'topology'
            : 'regions'
          : issue.scope.type === 'junction'
            ? `junctions[${issue.scope.junctionIndex}]`
            : undefined;
    return {
      code: issue.legacyCode,
      severity: issue.severity,
      message: issue.detail,
      ...(field ? { field } : {}),
      ...(fragmentIndex !== undefined ? { fragmentIndex } : {}),
    };
  });
}

export function issuesToAcceptedValidationIssues(
  issues: readonly AssemblyIssue[]
): AcceptedAssemblyValidationIssue[] {
  return issues.filter(isLegacyValidationIssueSeverity).map((issue) => ({
    code: issue.legacyCode,
    severity: issue.severity,
    message: issue.detail,
    ...(issue.scope.type === 'part'
      ? {
          field: `regions[${issue.scope.fragmentIndex}]`,
          fragmentIndex: issue.scope.fragmentIndex,
        }
      : {}),
    ...(issue.scope.type === 'junction' ? { junctionIndex: issue.scope.junctionIndex } : {}),
  }));
}

function isLegacyValidationIssueSeverity(
  issue: AssemblyIssue
): issue is AssemblyIssue & { severity: 'error' | 'warning' } {
  return issue.severity === 'error' || issue.severity === 'warning';
}

export function issueBlocksGate(issue: AssemblyIssue, gate: keyof AssemblyIssueGates): boolean {
  return issue.lifecycle === 'committed' && issue.severity === 'error' && issue.gates[gate];
}

export function issuesBlockingGate(
  issues: readonly AssemblyIssue[],
  gate: keyof AssemblyIssueGates
): AssemblyIssue[] {
  return issues.filter((issue) => issueBlocksGate(issue, gate));
}

export function internalCutSiteBadgeLabel(issues: readonly AssemblyIssue[]): string | null {
  const blockers = issues.filter((issue) => issue.severity === 'error');
  if (blockers.length === 0) return null;
  if (!blockers.every((issue) => issue.kind === 'gg-internal-site')) return null;
  const siteCount = blockers.reduce((sum, issue) => sum + (issue.internalSites?.length ?? 0), 0);
  if (siteCount === 0) return null;
  return `${siteCount} internal cut site${siteCount === 1 ? '' : 's'}`;
}

export function highestIssueSeverity(
  issues: readonly AssemblyIssue[]
): AssemblyIssueSeverity | null {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.some((issue) => issue.severity === 'warning')) return 'warning';
  if (issues.some((issue) => issue.severity === 'info')) return 'info';
  return null;
}

export type AssemblyDrawerSection = 'parts' | 'junctions' | 'export' | 'general';

export function assemblyIssueSection(issue: AssemblyIssue): AssemblyDrawerSection {
  switch (issue.scope.type) {
    case 'part':
      return 'parts';
    case 'junction':
    case 'primer':
      return 'junctions';
    case 'export':
      return 'export';
    case 'assembly':
    case 'digest-preview':
      return 'general';
  }
}

export function issuesForSection(
  issues: readonly AssemblyIssue[],
  section: AssemblyDrawerSection
): AssemblyIssue[] {
  return issues.filter((issue) => assemblyIssueSection(issue) === section);
}

function deriveHomologyQualityIssues(design: SequenceDesign): AssemblyIssue[] {
  if (!isHomologyAssemblyMethod(design.assemblyMethod)) return [];
  const issues: AssemblyIssue[] = [];
  for (const homology of design.homologyRegions) {
    const length = homology.encoding.onLeft + homology.encoding.onRight;
    const actualLength = homology.metadata?.sequence?.length;
    if (
      Number.isInteger(length) &&
      length >= GIBSON_MIN_HOMOLOGY_LENGTH &&
      length <= GIBSON_MAX_HOMOLOGY_LENGTH &&
      (actualLength === undefined || actualLength === length)
    )
      continue;
    issues.push(
      createIssue({
        kind: 'homology-length-out-of-range',
        design,
        scope: { type: 'junction', designId: design.id, junctionIndex: homology.junctionIndex },
        anchors: [
          ...baseAnchors(design.id),
          { surface: 'junction-card', junctionIndex: homology.junctionIndex },
        ],
        detail: `Junction ${homology.junctionIndex + 1} has ${actualLength ?? length} bp shared homology; Gibson and NEBuilder require ${GIBSON_MIN_HOMOLOGY_LENGTH}–${GIBSON_MAX_HOMOLOGY_LENGTH} bp matching the encoded overlap. The two primer tails contribute to this shared overlap.`,
        keyPayload: { designId: design.id, junctionIndex: homology.junctionIndex },
        sortKey: `junction:${homology.junctionIndex}:homology-length`,
      })
    );
  }
  const target = design.primerDesignConstraints?.targetPcrTm ?? 60;
  for (const pair of design.designPrimers) {
    for (const primer of [pair.forward, pair.reverse]) {
      if (
        typeof primer.tm !== 'number' ||
        !Number.isFinite(primer.tm) ||
        Math.abs(primer.tm - target) <= 5
      )
        continue;
      issues.push(
        createIssue({
          kind: 'primer-pbs-suboptimal',
          design,
          scope: {
            type: 'part',
            designId: design.id,
            regionId: design.regions[primer.fragmentIndex].id,
            fragmentIndex: primer.fragmentIndex,
          },
          anchors: baseAnchors(design.id),
          title: 'Primer binding temperature is far from target',
          detail: `${primer.name} binding-site Tm is ${primer.tm.toFixed(1)} C; target is near ${target} C. Adjust its binding length or PCR temperature settings before ordering.`,
          keyPayload: {
            designId: design.id,
            primerId: primer.id,
            fragmentIndex: primer.fragmentIndex,
            field: 'pbsTm',
          },
          sortKey: `primer:${primer.fragmentIndex}:${primer.direction}:tm`,
        })
      );
    }
  }
  return issues;
}

function deriveHomologyInputIssues(design: SequenceDesign): AssemblyIssue[] {
  if (!isHomologyAssemblyMethod(design.assemblyMethod) || design.regions.length < 2) return [];
  const issues: AssemblyIssue[] = [];
  const junctionCount =
    design.topology === 'circular' ? design.regions.length : design.regions.length - 1;

  for (const homology of design.homologyRegions) {
    const length = homology.metadata?.sequence?.length ?? 0;
    if (length >= GIBSON_MIN_HOMOLOGY_LENGTH && length <= GIBSON_MAX_HOMOLOGY_LENGTH) continue;
    issues.push(
      createIssue({
        kind: 'homology-length-out-of-range',
        design,
        scope: { type: 'junction', designId: design.id, junctionIndex: homology.junctionIndex },
        anchors: [
          ...baseAnchors(design.id),
          { surface: 'junction-card', junctionIndex: homology.junctionIndex },
        ],
        detail: `Junction ${homology.junctionIndex + 1} has ${length} bp of homology; use ${GIBSON_MIN_HOMOLOGY_LENGTH}–${GIBSON_MAX_HOMOLOGY_LENGTH} bp before drafting or finalizing.`,
        keyPayload: { designId: design.id, junctionIndex: homology.junctionIndex },
        sortKey: `junction:${homology.junctionIndex}:homology-length`,
      })
    );
  }

  for (let junctionIndex = 0; junctionIndex < junctionCount; junctionIndex++) {
    const leftIndex = junctionIndex;
    const rightIndex = (junctionIndex + 1) % design.regions.length;
    const leftRegion = design.regions[leftIndex];
    const rightRegion = design.regions[rightIndex];
    if (!isRestrictionDigestRegion(leftRegion) || !isRestrictionDigestRegion(rightRegion)) {
      continue;
    }
    const detail =
      'Gibson and NEBuilder cannot currently bridge two adjacent restriction digest fragments. Add a PCR-amplified part or spacer-controlled PCR junction.';
    issues.push(
      createIssue({
        kind: 'gibson-rd-rd-junction',
        design,
        scope: {
          type: 'part',
          designId: design.id,
          regionId: leftRegion.id,
          fragmentIndex: leftIndex,
        },
        anchors: [
          ...baseAnchors(design.id),
          { surface: 'part-card', regionId: leftRegion.id },
          { surface: 'part-card', regionId: rightRegion.id },
          { surface: 'junction-card', junctionIndex },
          { surface: 'workbench-junction-card', junctionIndex },
        ],
        detail,
        keyPayload: { designId: design.id, junctionIndex, fragmentIndex: leftIndex },
        sortKey: `junction:${junctionIndex}:rd-rd`,
      })
    );
  }

  return issues;
}

function deriveGoldenGateIssues(design: SequenceDesign): AssemblyIssue[] {
  if (design.assemblyMethod !== 'goldengate') return [];
  const enzyme = design.goldenGateConfig?.enzyme ?? 'BsaI';
  const validation = validateGoldenGateAssembly(
    design.regions,
    design.topology === 'circular',
    enzyme,
    { backboneSequenceId: design.backboneSequenceId }
  );
  return validation.conflicts.map((conflict, index) =>
    goldenGateConflictToIssue(design, conflict, enzyme, index)
  );
}

function goldenGateConflictToIssue(
  design: SequenceDesign,
  conflict: OverhangConflict,
  enzyme: GoldenGateEnzyme,
  fallbackIndex: number
): AssemblyIssue {
  const kind = OVERHANG_CONFLICT_MIGRATION[conflict.type];
  const severity = goldenGateConflictSeverity(conflict.type);
  const regionIndex = conflict.regionIndex ?? conflict.involvedIndices[0] ?? 0;
  const region = design.regions[regionIndex];
  const junctionIndex = conflict.junctionIndex ?? firstJunctionIndexForConflict(conflict, design);
  const title = goldenGateConflictTitle(conflict.type);
  const scope: AssemblyIssueScope = region
    ? { type: 'part', designId: design.id, regionId: region.id, fragmentIndex: regionIndex }
    : junctionIndex !== null
      ? {
          type: 'junction',
          designId: design.id,
          junctionIndex,
          leftRegionId: conflict.leftRegionId,
          rightRegionId: conflict.rightRegionId,
        }
      : { type: 'assembly', designId: design.id };
  const anchors: AssemblyIssueAnchor[] = [
    ...baseAnchors(design.id),
    ...(region ? [{ surface: 'part-card' as const, regionId: region.id }] : []),
    ...(junctionIndex !== null
      ? [
          { surface: 'junction-card' as const, junctionIndex },
          { surface: 'workbench-junction-card' as const, junctionIndex },
        ]
      : []),
  ];
  return createIssue({
    kind,
    design,
    severity,
    scope,
    anchors,
    title,
    shortMessage: title,
    detail: conflict.message,
    internalSites: conflict.internalSites,
    keyPayload: {
      designId: design.id,
      regionId: region?.id ?? conflict.regionId,
      fragmentIndex: regionIndex,
      junctionIndex: junctionIndex ?? undefined,
      expectedEnzyme: conflict.expectedEnzyme ?? enzyme,
      actualEnzyme: conflict.actualEnzyme ?? null,
      endName: conflict.endName,
      expectedSite: conflict.expectedRecognitionSequence,
      actualSite: conflict.actualRecognitionSequence,
      overhang: conflict.overhang,
      reasonCode: conflict.mismatchReason ?? conflict.type,
    },
    sortKey: `goldengate:${regionIndex}:${junctionIndex ?? fallbackIndex}:${conflict.type}`,
  });
}

function firstJunctionIndexForConflict(
  conflict: OverhangConflict,
  design: SequenceDesign
): number | null {
  if (conflict.involvedIndices.length >= 2) {
    const [first, second] = conflict.involvedIndices;
    if ((first + 1) % design.regions.length === second) return first;
    if ((second + 1) % design.regions.length === first) return second;
  }
  return null;
}

function createIssue(input: {
  kind: AssemblyIssueKind;
  design: SequenceDesign;
  severity?: AssemblyIssueSeverity;
  scope: AssemblyIssueScope;
  anchors: AssemblyIssueAnchor[];
  title?: string;
  shortMessage?: string;
  detail: string;
  keyPayload: AssemblyIssueKeyPayload;
  sortKey: string;
  internalSites?: InternalCutSite[];
}): AssemblyIssue {
  const defaults = ASSEMBLY_ISSUE_REGISTRY[input.kind];
  const dedupeKey = keyForAssemblyIssue(input.kind, input.keyPayload);
  const issue: AssemblyIssue = {
    id: dedupeKey,
    dedupeKey,
    kind: input.kind,
    legacyCode: defaults.legacyCode,
    severity: input.severity ?? defaults.severity,
    gates: defaults.gates,
    source: defaults.producer,
    lifecycle: 'committed',
    scope: input.scope,
    anchors: input.anchors,
    title: input.title ?? defaults.title,
    shortMessage: input.shortMessage ?? defaults.title,
    detail: input.detail,
    actions: [],
    sortKey: input.sortKey,
    ...(input.internalSites ? { internalSites: input.internalSites } : {}),
  };
  assertValidIssue(issue);
  return issue;
}

function mergeAndSortIssues(issues: AssemblyIssue[]): AssemblyIssue[] {
  const byId = new Map<string, AssemblyIssue>();
  for (const issue of issues) {
    const existing = byId.get(issue.id);
    if (!existing) {
      byId.set(issue.id, {
        ...issue,
        anchors: dedupeAnchors(issue.anchors),
      });
      continue;
    }
    byId.set(issue.id, {
      ...existing,
      anchors: dedupeAnchors([...existing.anchors, ...issue.anchors]),
    });
  }
  return Array.from(byId.values()).sort(compareIssues);
}

function compareIssues(left: AssemblyIssue, right: AssemblyIssue): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    Number(right.gates.run) - Number(left.gates.run) ||
    scopeRank(left.scope.type) - scopeRank(right.scope.type) ||
    left.sortKey.localeCompare(right.sortKey) ||
    left.id.localeCompare(right.id)
  );
}

function severityRank(severity: AssemblyIssueSeverity): number {
  if (severity === 'error') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function scopeRank(scope: AssemblyIssueScope['type']): number {
  return ['assembly', 'part', 'junction', 'primer', 'export', 'digest-preview'].indexOf(scope);
}

function dedupeAnchors(anchors: readonly AssemblyIssueAnchor[]): AssemblyIssueAnchor[] {
  const seen = new Set<string>();
  const result: AssemblyIssueAnchor[] = [];
  for (const anchor of anchors) {
    const key = JSON.stringify(anchor);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(anchor);
  }
  return result;
}

function baseAnchors(designId: string): AssemblyIssueAnchor[] {
  return [
    { surface: 'design-drawer', refId: designId },
    { surface: 'export-card', refId: designId },
  ];
}

function isRestrictionDigestRegion(region: DesignRegion): boolean {
  return region.sourceType === 'rd' || Boolean(region.rdOverhangs);
}

function assertValidIssue(issue: AssemblyIssue): void {
  if (issue.id !== issue.dedupeKey) {
    throw new Error(`Assembly issue id must equal dedupeKey for ${issue.kind}.`);
  }
  if (!ASSEMBLY_ISSUE_REGISTRY[issue.kind]) {
    throw new Error(`Unregistered assembly issue kind: ${issue.kind}`);
  }
  if (issue.anchors.length === 0) {
    throw new Error(`Assembly issue ${issue.id} must have at least one anchor.`);
  }
  if (!issue.detail.trim()) {
    throw new Error(`Assembly issue ${issue.id} must have detail copy.`);
  }
}

function exhaustiveIssueKind(kind: never): never {
  throw new Error(`Unhandled assembly issue kind: ${kind}`);
}
