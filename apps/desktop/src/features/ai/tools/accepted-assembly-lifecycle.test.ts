import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  finalizeDesignAssemblyOutputSchema,
  getAcceptedAssemblyOutputSchema,
  getConstructLineageOutputSchema,
} from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../../design/types';
import { useDesignStore } from '../../design/store';
import type { ResolvedAcceptedAssemblyRecord } from '../../assembly/accepted-record-reader';
import {
  createFinalizeDesignAssemblyTool,
  createGetAcceptedAssemblyTool,
  createGetConstructLineageTool,
  finalizeDesignAssemblySchema,
  getAcceptedAssemblySchema,
  getConstructLineageSchema,
  previewFinalizeDesignAssemblySchema,
  reopenAcceptedAssemblySchema,
} from './accepted-assembly-lifecycle';

describe('accepted assembly lifecycle read tools', () => {
  beforeEach(() => {
    useDesignStore.setState({
      designs: {
        'construct-1': {
          id: 'construct-1',
          constructId: 'construct-1',
        } as SequenceDesign,
        'draft-revision-2': {
          id: 'draft-revision-2',
          constructId: 'construct-1',
        } as SequenceDesign,
      },
    });
  });

  it('keeps every callable selector at the top level and rejects empty lineage lookup', () => {
    expect(getConstructLineageSchema.safeParse({}).success).toBe(false);
    expect(
      getConstructLineageSchema.safeParse({
        constructId: 'construct-1',
        acceptedAssemblyVersionId: 'accepted-1',
      }).success
    ).toBe(true);
    expect(
      getAcceptedAssemblySchema.safeParse({ acceptedAssemblyVersionId: 'accepted-1' }).success
    ).toBe(true);
    expect(
      previewFinalizeDesignAssemblySchema.safeParse({
        designId: 'design-1',
        expectedDesignVersion: 3,
      }).success
    ).toBe(true);
    expect(
      finalizeDesignAssemblySchema.safeParse({
        designId: 'design-1',
        expectedDesignVersion: 3,
        previewFingerprint: `sha256:${'a'.repeat(64)}`,
        idempotencyKey: 'finalize-once',
      }).success
    ).toBe(true);
    expect(
      reopenAcceptedAssemblySchema.safeParse({
        acceptedAssemblyVersionId: 'accepted-1',
        idempotencyKey: 'reopen-once',
      }).success
    ).toBe(true);
  });

  it('returns immutable accepted data and a typed lineage projection through the same resolver', async () => {
    const resolved = createResolvedRecord();
    const resolver = async () => resolved;
    const acceptedResult = await execDesignContract(
      getAcceptedAssemblyOutputSchema,
      createGetAcceptedAssemblyTool(resolver),
      {
        acceptedAssemblyVersionId: 'accepted-1',
      }
    );
    const lineageResult = await execDesignContract(
      getConstructLineageOutputSchema,
      createGetConstructLineageTool(resolver),
      {
        constructId: 'construct-1',
      }
    );

    expect(acceptedResult).toMatchObject({
      exists: true,
      immutable: true,
      constructId: 'construct-1',
      acceptedAssemblyVersionId: 'accepted-1',
    });
    expect(lineageResult).toMatchObject({
      exists: true,
      lineage: {
        rootConstructId: 'construct-1',
        acceptedAssemblyVersionId: 'accepted-1',
      },
    });
  });

  it(' retains native homology edit records while projecting the supported public intent contract', async () => {
    const resolved = createResolvedRecord();
    const nativeIntents = [
      { id: 'homology', regionId: 'part-1', direction: 'forward' as const, junctionIndex: 0, field: 'homologyLength' as const, length: 30 },
      { id: 'binding', regionId: 'part-1', direction: 'forward' as const, junctionIndex: 0, field: 'pbsLength' as const, length: 32 },
    ];
    resolved.accepted.projectionInput.assemblyWorkbench = { junctions: [], primers: [], primerEditIntents: nativeIntents };
    const result = await execDesignContract(getAcceptedAssemblyOutputSchema, createGetAcceptedAssemblyTool(async () => resolved), { acceptedAssemblyVersionId: 'accepted-1' });
    expect(result).toMatchObject({ exists: true, immutable: true, acceptedAssembly: { projectionInput: { assemblyWorkbench: { primerEditIntents: [nativeIntents[1]] } } } });
    expect(resolved.accepted.projectionInput.assemblyWorkbench.primerEditIntents).toEqual(nativeIntents);
  });

  it('reconciles an exact finalization retry from the durable package after preview cache loss', async () => {
    const resolved = createResolvedRecord();
    resolved.accepted.agentOperation = {
      idempotencyKey: 'finalize-once',
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
    };
    const result = await execDesignContract(
      finalizeDesignAssemblyOutputSchema,
      createFinalizeDesignAssemblyTool(async () => resolved),
      {
        designId: 'construct-1',
        expectedDesignVersion: 3,
        previewFingerprint: `sha256:${'b'.repeat(64)}`,
        idempotencyKey: 'finalize-once',
      }
    );

    expect(result).toMatchObject({
      status: 'completed',
      idempotentReplay: true,
      constructId: 'construct-1',
      acceptedAssemblyVersionId: 'accepted-1',
      historyState: 'committed',
      openTabRequired: true,
    });
  });

  it('rejects a durable idempotency-key collision with another preview fingerprint', async () => {
    const resolved = createResolvedRecord();
    resolved.accepted.agentOperation = {
      idempotencyKey: 'finalize-once',
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
    };
    const result = await execDesignContract(
      finalizeDesignAssemblyOutputSchema,
      createFinalizeDesignAssemblyTool(async () => resolved),
      {
        designId: 'construct-1',
        expectedDesignVersion: 3,
        previewFingerprint: `sha256:${'c'.repeat(64)}`,
        idempotencyKey: 'finalize-once',
      }
    );

    expect(result).toMatchObject({ status: 'rejected', idempotencyKey: 'finalize-once' });
    expect(result.error).toMatch(/different finalization preview/i);
  });

  it('reports a durable package without a completion marker as recovery-required', async () => {
    const resolved = createResolvedRecord();
    resolved.accepted.agentOperation = {
      idempotencyKey: 'partial-finalization',
      previewFingerprint: `sha256:${'e'.repeat(64)}`,
    };
    resolved.catalogEvents = [];
    const result = await execDesignContract(
      finalizeDesignAssemblyOutputSchema,
      createFinalizeDesignAssemblyTool(async () => resolved),
      {
        designId: 'construct-1',
        expectedDesignVersion: 3,
        previewFingerprint: `sha256:${'e'.repeat(64)}`,
        idempotencyKey: 'partial-finalization',
      }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 'recovery_required',
      code: 'FINALIZATION_RECOVERY_REQUIRED',
      stateChanged: true,
      acceptedAssemblyVersionId: 'accepted-1',
    });
    expect(result.partialEffects).toEqual([{ constructId: 'construct-1' }]);
  });

  it('reconciles a finalized reopened revision through its matured package binding', async () => {
    const resolved = createResolvedRecord();
    resolved.accepted.agentOperation = {
      idempotencyKey: 'finalize-reopened',
      previewFingerprint: `sha256:${'d'.repeat(64)}`,
    };
    const selectors: unknown[] = [];
    const resolver = async (selector: unknown) => {
      selectors.push(selector);
      if ((selector as { constructId?: string }).constructId === 'draft-revision-2') {
        throw new Error('Construct mismatch: draft revision is not the stable package id.');
      }
      return resolved;
    };
    const result = await execDesignContract(
      finalizeDesignAssemblyOutputSchema,
      createFinalizeDesignAssemblyTool(resolver, async () => ({
        path: '/workspace/pConstruct',
        file_kind: 'waypoint-plasmid',
      })),
      {
        designId: 'draft-revision-2',
        expectedDesignVersion: 1,
        previewFingerprint: `sha256:${'d'.repeat(64)}`,
        idempotencyKey: 'finalize-reopened',
      }
    );

    expect(selectors).toEqual([{ constructId: 'construct-1' }]);
    expect(result).toMatchObject({
      status: 'completed',
      idempotentReplay: true,
      constructId: 'construct-1',
      historyState: 'committed',
    });
  });
});

function createResolvedRecord(): ResolvedAcceptedAssemblyRecord {
  const accepted: ResolvedAcceptedAssemblyRecord['accepted'] = {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-08-05T18:00:00.000Z',
    designId: 'construct-1',
    designName: 'pConstruct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: 'sha256:draft',
      regionCount: 0,
      spacerCount: 0,
    },
    projectionInput: {
      schemaVersion: 1,
      designId: 'construct-1',
      designName: 'pConstruct',
      topology: 'circular',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      productSequence: '',
      regions: [],
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [],
      canonicalDraftChecksum: 'sha256:draft',
    },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'construct-1',
      designVersion: 3,
      assemblyMethod: 'gibson',
      projectionInputChecksum: 'sha256:draft',
      validatedAt: '2026-08-05T17:59:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: '/workspace/pConstruct/pConstruct.gb',
      sidecarJsonPath: '/workspace/pConstruct/.forge/plasmid.json',
      productSequenceChecksum: 'sha256:product',
      primerCsvPath: '/workspace/pConstruct/primers.csv',
      primerFastaPath: '/workspace/pConstruct/primers.fasta',
      primerCsvChecksum: 'sha256:primer-csv',
      primerFastaChecksum: 'sha256:primer-fasta',
      canonicalDraftChecksum: 'sha256:draft',
    },
  };
  return {
    constructId: 'construct-1',
    packageId: 'construct-1',
    packageRoot: '/workspace/pConstruct',
    productPath: '/workspace/pConstruct/pConstruct.gb',
    metaPath: '/workspace/pConstruct/.forge/plasmid.json',
    acceptedAssemblyVersionId: 'accepted-1',
    integrity: {
      productGenBank: 'verified',
      expectedChecksum: 'sha256:genbank',
      actualChecksum: 'sha256:genbank',
    },
    recordIsCurrent: true,
    acceptedRecords: [accepted],
    catalogEvents: [
      {
        id: 'event-finalized',
        eventType: 'assembly_finalized',
        actor: 'agent:test',
        summary: 'Finalized',
        payload: {
          acceptedAssemblyVersionId: 'accepted-1',
          historyState: 'committed',
        },
        createdAt: 1,
      },
    ],
    accepted,
  };
}
