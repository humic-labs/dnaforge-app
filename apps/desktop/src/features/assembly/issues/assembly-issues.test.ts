import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import {
  goldenGateConflictTitle,
  validateGoldenGateAssembly,
} from '../../design/validation/golden-gate-overhangs';
import {
  ASSEMBLY_ISSUE_KINDS,
  ASSEMBLY_ISSUE_REGISTRY,
  OVERHANG_CONFLICT_MIGRATION,
  VIRTUAL_DIGEST_DIAGNOSTIC_MIGRATION,
  WORKBENCH_COMMAND_DIAGNOSTIC_MIGRATION,
  assemblyIssueSection,
  deriveAssemblyIssues,
  internalCutSiteBadgeLabel,
  issueBlocksGate,
  issuesForSection,
  issuesToAcceptedValidationIssues,
  issuesToValidationErrors,
  keyForAssemblyIssue,
} from './assembly-issues';
import type { AssemblyIssueScope } from './assembly-issues';
import type { AssemblyIssue } from './assembly-issues';
import * as assemblyIssues from './assembly-issues';
import { validateInputs } from '../dispatcher';
import { ASSEMBLY_WORKBENCH_CAPABILITIES } from '../../junction-workbench/AssemblyWorkbenchContract';

describe('assembly issue module surface', () => {
  it('does not export unused issueCountLabel', () => {
    expect(assemblyIssues).not.toHaveProperty('issueCountLabel');
    expect(assemblyIssues.internalCutSiteBadgeLabel).toBe(internalCutSiteBadgeLabel);
  });
});

describe('canonical assembly issues', () => {
  it('treats missing homology sequence metadata as a zero-length blocker', () => {
    const design = createGoldenGateDesign([
      region('left', 'ATCG'.repeat(20), 'pcr'),
      region('right', 'GCTA'.repeat(20), 'pcr'),
    ]);
    design.assemblyMethod = 'gibson';
    design.homologyRegions = [
      {
        id: 'missing-sequence',
        junctionIndex: 0,
        junctionPosition: 80,
        start: 70,
        end: 90,
        encoding: { onLeft: 10, onRight: 10 },
        metadata: {},
      },
    ];
    expect(deriveAssemblyIssues({ design })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'homology-length-out-of-range',
          scope: expect.objectContaining({ junctionIndex: 0 }),
          detail: expect.stringContaining('0 bp'),
          gates: { run: true, finalize: true, export: true },
        }),
      ])
    );
  });

  it('derives one gated canonical issue for a BsaI Golden Gate design with a BsmBI RD part', () => {
    const design = createGoldenGateDesign([
      {
        ...region('bsmBI-rd', 'ATCG'.repeat(30), 'rd'),
        rdSourceEnzyme: 'BsmBI',
        rdSourceEnzymeName: 'BsmBI',
      },
      region('pcr', 'GCTA'.repeat(30), 'pcr'),
    ]);

    const issues = deriveAssemblyIssues({ design });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'gg-rd-enzyme-mismatch:design-1:bsmBI-rd:BsaI:BsmBI',
      dedupeKey: 'gg-rd-enzyme-mismatch:design-1:bsmBI-rd:BsaI:BsmBI',
      kind: 'gg-rd-enzyme-mismatch',
      legacyCode: 'goldengate_rd_enzyme_mismatch',
      severity: 'error',
      gates: { run: true, finalize: true, export: true },
      source: 'dispatcher-validation',
      lifecycle: 'committed',
      scope: { type: 'part', designId: design.id, regionId: 'bsmBI-rd', fragmentIndex: 0 },
      title: 'Incompatible RD enzyme',
      shortMessage: 'Incompatible RD enzyme',
      detail:
        'bsmBI-rd was produced by BsmBI, so it cannot be used in a BsaI Golden Gate reaction.',
    });
    expect(issues[0].anchors).toEqual(
      expect.arrayContaining([
        { surface: 'design-drawer', refId: design.id },
        { surface: 'part-card', regionId: 'bsmBI-rd' },
        { surface: 'export-card', refId: design.id },
      ])
    );
    expect(issueBlocksGate(issues[0], 'run')).toBe(true);
    expect(issueBlocksGate(issues[0], 'finalize')).toBe(true);
    expect(issueBlocksGate(issues[0], 'export')).toBe(true);
  });

  it('carries internal-site footprints from the validator into the gg-internal-site issue  #8)', () => {
    const design = createGoldenGateDesign([
      region('p-internal', 'AAAAGGTCTCAAAA', 'pcr'),
      region('p-clean', 'GCTA'.repeat(20), 'pcr'),
    ]);

    const issues = deriveAssemblyIssues({ design });
    const internalSiteIssue = issues.find((issue) => issue.kind === 'gg-internal-site');

    expect(internalSiteIssue).toBeDefined();
    expect(internalSiteIssue?.severity).toBe('error');
    expect(internalSiteIssue?.internalSites).toEqual([{ start: 4, end: 10, strand: 'forward' }]);

    for (const other of issues.filter((issue) => issue.kind !== 'gg-internal-site')) {
      expect(other.internalSites).toBeUndefined();
    }
  });

  it('lets internal Type IIS sites draft (run) but blocks finalize/export ', () => {
    const design = createGoldenGateDesign([
      region('p-internal', 'AAAAGGTCTCAAAA', 'pcr'),
      region('p-clean', 'GCTA'.repeat(20), 'pcr'),
    ]);
    const issue = deriveAssemblyIssues({ design }).find((i) => i.kind === 'gg-internal-site');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issueBlocksGate(issue!, 'run')).toBe(false);
    expect(issueBlocksGate(issue!, 'finalize')).toBe(true);
    expect(issueBlocksGate(issue!, 'export')).toBe(true);
  });

  it('the draft gate (validateInputs) excludes internal sites so primers still draft ', () => {
    const design = createGoldenGateDesign([
      region('p-internal', 'AAAAGGTCTCAAAA', 'pcr'),
      region('p-clean', 'GCTA'.repeat(20), 'pcr'),
    ]);
    expect(validateInputs(design).some((e) => e.code === 'goldengate_internal_site')).toBe(false);
    expect(deriveAssemblyIssues({ design }).some((i) => i.kind === 'gg-internal-site')).toBe(true);
  });

  it('projects canonical issues to legacy validation snapshots without changing the gate source', () => {
    const design = createGoldenGateDesign([
      {
        ...region('bsmBI-rd', 'ATCG'.repeat(30), 'rd'),
        rdSourceEnzyme: 'BsmBI',
        rdSourceEnzymeName: 'BsmBI',
      },
      region('pcr', 'GCTA'.repeat(30), 'pcr'),
    ]);
    const issues = deriveAssemblyIssues({ design });

    expect(issuesToValidationErrors(issues)).toEqual([
      expect.objectContaining({
        code: 'goldengate_rd_enzyme_mismatch',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      }),
    ]);
    expect(issuesToAcceptedValidationIssues(issues)).toEqual([
      expect.objectContaining({
        code: 'goldengate_rd_enzyme_mismatch',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      }),
    ]);
  });

  it('fails loudly if a registry, key recipe, or migration inventory drifts', () => {
    expect(Object.keys(ASSEMBLY_ISSUE_REGISTRY).sort()).toEqual([...ASSEMBLY_ISSUE_KINDS].sort());
    expect(
      keyForAssemblyIssue('gg-rd-enzyme-mismatch', {
        designId: 'design-1',
        regionId: 'part-1',
        expectedEnzyme: 'BsaI',
        actualEnzyme: 'BsmBI',
      })
    ).toBe('gg-rd-enzyme-mismatch:design-1:part-1:BsaI:BsmBI');

    expect(Object.keys(OVERHANG_CONFLICT_MIGRATION).sort()).toEqual([
      'duplicate',
      'internal-site',
      'mismatch',
      'rd-cut-site-mismatch',
      'rd-enzyme-mismatch',
      'rd-enzyme-unknown',
      'rd-fragment-not-insert',
      'self-ligation',
    ]);
    expect(Object.keys(VIRTUAL_DIGEST_DIAGNOSTIC_MIGRATION).sort()).toEqual([
      'goldengate-duplicate-overhang',
      'goldengate-extra-sites',
      'goldengate-invalid-pair',
      'no-cut-sites',
    ]);
    const workbenchCodes = Array.from(
      new Set(ASSEMBLY_WORKBENCH_CAPABILITIES.flatMap((capability) => capability.errorCodes))
    ).sort();
    for (const code of workbenchCodes) {
      expect(WORKBENCH_COMMAND_DIAGNOSTIC_MIGRATION[code]).toBe('transient-command-outcome');
    }
  });

  it('rewords the wrong-polarity error into plain language naming the part + remedy ', () => {
    const design = createGoldenGateDesign([
      { ...region('pUC19-backbone', 'ATCG'.repeat(30), 'rd'), ggType: 'backbone' },
      region('insert-pcr', 'GCTA'.repeat(30), 'pcr'),
    ]);
    const issue = deriveAssemblyIssues({ design }).find(
      (i) => i.kind === 'gg-rd-polarity-unsupported'
    );
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issueBlocksGate(issue!, 'run')).toBe(true);
    expect(issueBlocksGate(issue!, 'finalize')).toBe(true);
    expect(issueBlocksGate(issue!, 'export')).toBe(true);
    expect(issue!.title).toBe("This part can't be used as an insert");
    expect(issue!.detail).toContain('pUC19-backbone');
    expect(issue!.detail.toLowerCase()).toContain('insert');
    expect(issue!.detail).not.toMatch(/re-digest/i);
    expect(issue!.detail).not.toMatch(/insert-polarity RD fragments only/i);
  });

  it('keeps the registry default title in sync with goldenGateConflictTitle  DRY guard)', () => {
    expect(ASSEMBLY_ISSUE_REGISTRY['gg-rd-polarity-unsupported'].title).toBe(
      goldenGateConflictTitle('rd-fragment-not-insert')
    );
    expect(ASSEMBLY_ISSUE_REGISTRY['gg-internal-site'].title).toBe(
      goldenGateConflictTitle('internal-site')
    );
    expect(ASSEMBLY_ISSUE_REGISTRY['gg-self-ligation'].title).toBe(
      goldenGateConflictTitle('self-ligation')
    );
  });

  it('requires structured Golden Gate facts for stable RD mismatch keys and anchors', () => {
    const design = createGoldenGateDesign([
      {
        ...region('bsmBI-rd', 'ATCG'.repeat(30), 'rd'),
        rdSourceEnzyme: 'BsmBI',
        rdSourceEnzymeName: 'BsmBI',
      },
      region('pcr', 'GCTA'.repeat(30), 'pcr'),
    ]);

    const validation = validateGoldenGateAssembly(design.regions, true, 'BsaI');

    expect(validation.conflicts).toHaveLength(1);
    expect(validation.conflicts[0]).toMatchObject({
      type: 'rd-enzyme-mismatch',
      regionId: 'bsmBI-rd',
      regionIndex: 0,
      expectedEnzyme: 'BsaI',
      actualEnzyme: 'BsmBI',
      mismatchReason: 'rd-enzyme-mismatch',
    });
  });
});

describe('internalCutSiteBadgeLabel  #9)', () => {
  function fakeIssue(
    over: Pick<AssemblyIssue, 'kind' | 'severity'> & Partial<AssemblyIssue>
  ): AssemblyIssue {
    return {
      id: over.id ?? `${over.kind}-x`,
      dedupeKey: over.id ?? `${over.kind}-x`,
      legacyCode: 'x',
      gates: { run: true, finalize: true, export: true },
      source: 'dispatcher-validation',
      lifecycle: 'committed',
      scope: { type: 'assembly', designId: 'd' },
      anchors: [{ surface: 'design-drawer', refId: 'd' }],
      title: 't',
      shortMessage: 't',
      detail: 'd',
      actions: [],
      sortKey: 's',
      ...over,
    } as AssemblyIssue;
  }

  const site = (start: number) => ({ start, end: start + 6, strand: 'forward' as const });

  it('counts SITE RECORDS (not blocker objects) when all blockers are internal cut sites', () => {
    const issues = [
      fakeIssue({
        kind: 'gg-internal-site',
        severity: 'error',
        internalSites: [site(4), site(14)],
      }),
      fakeIssue({ kind: 'gg-internal-site', severity: 'error', internalSites: [site(30)] }),
    ];
    expect(internalCutSiteBadgeLabel(issues)).toBe('3 internal cut sites');
  });

  it('singularizes a single internal site', () => {
    expect(
      internalCutSiteBadgeLabel([
        fakeIssue({ kind: 'gg-internal-site', severity: 'error', internalSites: [site(2)] }),
      ])
    ).toBe('1 internal cut site');
  });

  it('returns null (generic label fallback) when a non-cut-site blocker is present', () => {
    const issues = [
      fakeIssue({ kind: 'gg-internal-site', severity: 'error', internalSites: [site(4)] }),
      fakeIssue({ kind: 'gg-rd-enzyme-mismatch', severity: 'error' }),
    ];
    expect(internalCutSiteBadgeLabel(issues)).toBeNull();
  });

  it('returns null when there are no blockers (warnings only)', () => {
    expect(
      internalCutSiteBadgeLabel([
        fakeIssue({ kind: 'homology-tm-suboptimal', severity: 'warning' }),
      ])
    ).toBeNull();
  });

  it('returns null when a cut-site blocker somehow carries zero footprints', () => {
    expect(
      internalCutSiteBadgeLabel([
        fakeIssue({ kind: 'gg-internal-site', severity: 'error', internalSites: [] }),
      ])
    ).toBeNull();
  });
});

function createGoldenGateDesign(regions: DesignRegion[]): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'Golden Gate fixture',
    topology: 'circular',
    regions,
    spacers: [],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'goldengate',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(id: string, sequence: string, sourceType: 'pcr' | 'rd'): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType,
    ...(sourceType === 'rd'
      ? {
          ggType: 'insert' as const,
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
          rdSourceEnzyme: 'BsaI' as const,
          rdSourceEnzymeName: 'BsaI',
        }
      : {}),
  };
}

describe('assemblyIssueSection — drawer error-mapping ', () => {
  const issueWithScope = (scope: AssemblyIssueScope): AssemblyIssue => ({ scope }) as AssemblyIssue;

  it('routes a part-scoped issue (e.g. internal Type IIS site) to Parts, never Junctions', () => {
    const issue = issueWithScope({
      type: 'part',
      designId: 'd',
      regionId: 'r0',
      fragmentIndex: 0,
    });
    expect(assemblyIssueSection(issue)).toBe('parts');
  });

  it('routes junction and primer issues to Junctions', () => {
    expect(
      assemblyIssueSection(issueWithScope({ type: 'junction', designId: 'd', junctionIndex: 0 }))
    ).toBe('junctions');
    expect(
      assemblyIssueSection(
        issueWithScope({ type: 'primer', designId: 'd', fragmentIndex: 0, direction: 'forward' })
      )
    ).toBe('junctions');
  });

  it('routes export issues to Export and assembly/digest issues to general', () => {
    expect(assemblyIssueSection(issueWithScope({ type: 'export', designId: 'd' }))).toBe('export');
    expect(assemblyIssueSection(issueWithScope({ type: 'assembly', designId: 'd' }))).toBe(
      'general'
    );
    expect(assemblyIssueSection(issueWithScope({ type: 'digest-preview', sequenceId: 's' }))).toBe(
      'general'
    );
  });

  it('issuesForSection partitions a mixed issue set by section', () => {
    const part = issueWithScope({ type: 'part', designId: 'd', regionId: 'r', fragmentIndex: 0 });
    const junction = issueWithScope({ type: 'junction', designId: 'd', junctionIndex: 1 });
    const exportIssue = issueWithScope({ type: 'export', designId: 'd' });
    const all = [part, junction, exportIssue];

    expect(issuesForSection(all, 'parts')).toEqual([part]);
    expect(issuesForSection(all, 'junctions')).toEqual([junction]);
    expect(issuesForSection(all, 'export')).toEqual([exportIssue]);
    expect(issuesForSection(all, 'general')).toEqual([]);
  });
});
