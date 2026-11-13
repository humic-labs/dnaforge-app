import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool } from './test-helpers';
import { importEntitiesOutputSchema,
  createImportEntitiesTool as uncheckedcreateImportEntitiesTool,
  importEntitiesSchema,
  type ImportEntitiesDependencies,
} from './import-entities';

const folders: WorkspaceFolder[] = [{ name: 'project', path: '/workspace/project', addedAt: 1 }];

function dependencies(): ImportEntitiesDependencies {
  return {
    readSource: vi.fn(async () => ({ text: 'Name,Sequence\nAlpha,MSTNPKPQR' })),
    ensureDestination: vi.fn(async () => {}),
    createPlan: vi.fn(async (input) => {
      const protein = input.forcedKind === 'protein';
      const rna = input.forcedKind === 'rna_oligo';
      const notation = rna ? '/5Phos/rArCrGrU' : '/5Phos/ACGT';
      return {
        id: 'plan-1',
        sourceName: input.fileName,
        sourceKind: 'csv',
        detectedKind: 'sequence_file',
        columns: [],
        records: [
          {
            id: 'row-2',
            accepted: true,
            action: 'create',
            entityDraft: {
              kind: input.forcedKind!,
              name: 'Alpha',
              fields: {
                sequence: protein
                  ? { mode: 'inline', aminoAcids: 'MSTNPKPQR' }
                  : { mode: 'inline', bases: rna ? 'ACGU' : 'ACGT' },
              },
            },
            sequenceNotation: protein ? undefined : notation,
            duplicateCandidates: [],
            proposedLinks: [],
            unresolvedLinks: [],
            errors: [],
            warnings: [],
            source: { Name: 'Alpha', Sequence: protein ? 'MSTNPKPQR' : notation },
          },
        ],
        aggregateWarnings: [],
        forcedKind: input.forcedKind,
        canApply: true,
        oracle: { ok: true, source: input.fileName, invariants: [] },
      };
    }),
    recordProteins: vi.fn(async () => ({
      added: 1,
      skipped: 0,
      failed: 0,
      failures: [],
      reconciliationRequired: [],
      artifactRelativePaths: ['imports/Alpha.entity.json'],
      artifactAbsolutePaths: ['/workspace/project/imports/Alpha.entity.json'],
      gitCommitted: true,
      importSet: {
        id: 'import-set-1',
        manifestRelativePath: '.waypoint/import-sets/1/manifest.json',
      },
      members: [],
      partition: { plan: null, members: [] },
    })),
    recordOligos: vi.fn(async () => ({
      added: 1,
      skipped: 0,
      failed: 0,
      failures: [],
      artifactRelativePaths: ['imports/Alpha.primer.json'],
      importSet: {
        id: 'import-set-oligo',
        manifestRelativePath: '.waypoint/import-sets/oligo/manifest.json',
      },
      members: [],
      partition: { plan: null, members: [] },
    })),
  } as ImportEntitiesDependencies;
}

describe('import_entities tool', () => {
  it('reports known imported packages when later import provenance fails', async () => {
    const deps = dependencies();
    const summary = await deps.recordProteins({} as never, {} as never);
    vi.mocked(deps.recordProteins).mockResolvedValue({...summary, importSetError: 'Manifest write failed'});
    const result = await execTool(createImportEntitiesTool(folders, deps), {
      sourcePath: 'orders/proteins.csv', entityType: 'protein', destinationPath: 'imports',
    });
    expect(result).toMatchObject({ok: false, code: 'ENTITY_IMPORT_PARTIAL_FAILURE', retriable: false,
      stateChanged: true, partialEffects: [{artifactPath: 'imports/Alpha.entity.json'}],
      details: {imported: 1, importSetError: 'Manifest write failed'}});
  });

  it('reports unknown effects when the native writer rejects without a receipt', async () => {
    const deps = dependencies();
    vi.mocked(deps.recordProteins).mockRejectedValue(new Error('Native reply lost'));
    const result = await execTool(createImportEntitiesTool(folders, deps), {
      sourcePath: 'orders/proteins.csv', entityType: 'protein', destinationPath: 'imports',
    });
    expect(result).toMatchObject({ok: false, code: 'ENTITY_IMPORT_FAILED', retriable: false,
      stateChanged: 'unknown', partialEffects: []});
  });

  it('imports a typed protein source through the shared protein import writer', async () => {
    const deps = dependencies();
    const result = await execTool<{ changed: boolean; imported: number; artifactPaths: string[] }>(
      createImportEntitiesTool(folders, deps),
      {
        sourcePath: 'orders/proteins.csv',
        entityType: 'protein',
        destinationPath: 'imports/proteins',
      }
    );

    expect(deps.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'proteins.csv',
        sourcePath: '/workspace/project/orders/proteins.csv',
        forcedKind: 'protein',
      })
    );
    expect(deps.recordProteins).toHaveBeenCalledWith(
      expect.objectContaining({ forcedKind: 'protein' }),
      expect.objectContaining({
        workspaceRoot: '/workspace/project',
        destinationDir: '/workspace/project/imports/proteins',
        source: { sourcePath: '/workspace/project/orders/proteins.csv' },
      })
    );
    expect(deps.ensureDestination).toHaveBeenCalledWith('/workspace/project/imports/proteins');
    expect(vi.mocked(deps.ensureDestination).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.recordProteins).mock.invocationCallOrder[0]
    );
    expect(result).toEqual(
      expect.objectContaining({
        changed: true,
        imported: 1,
        artifactPaths: ['imports/Alpha.entity.json'],
      })
    );
  });

  it.each([
    ['dna_oligo', 'oligo', '/5Phos/ACGT'],
    ['rna_oligo', 'rna_oligo', '/5Phos/rArCrGrU'],
  ] as const)('imports %s through the shared oligo writer', async (entityType, kind, notation) => {
    const deps = dependencies();
    const result = await execTool<{ changed: boolean; imported: number }>(
      createImportEntitiesTool(folders, deps),
      { sourcePath: 'orders/oligos.csv', entityType }
    );

    expect(deps.recordOligos).toHaveBeenCalledWith(
      expect.objectContaining({
        forcedKind: kind,
        records: [expect.objectContaining({ sequenceNotation: notation })],
      }),
      expect.objectContaining({ workspaceRoot: '/workspace/project' })
    );
    expect(deps.recordProteins).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: true, imported: 1 });
  });

  it('returns review-required with zero writes when the plan cannot apply', async () => {
    const deps = dependencies();
    vi.mocked(deps.createPlan).mockImplementationOnce(async (input) => ({
      ...(await dependencies().createPlan(input)),
      canApply: false,
      records: [],
      aggregateWarnings: ['Map the sequence column.'],
    }));

    const result = await execTool<{ changed: boolean; code: string }>(
      createImportEntitiesTool(folders, deps),
      { sourcePath: 'orders/proteins.csv', entityType: 'protein' }
    );

    expect(result).toMatchObject({ changed: false, code: 'IMPORT_REVIEW_REQUIRED' });
    expect(deps.recordProteins).not.toHaveBeenCalled();
  });

  it('refuses mixed valid and invalid rows before any writer runs', async () => {
    const deps = dependencies();
    const basePlan = await dependencies().createPlan({
      fileName: 'proteins.csv',
      text: '',
      forcedKind: 'protein',
    });
    vi.mocked(deps.createPlan).mockResolvedValueOnce({
      ...basePlan,
      records: [
        basePlan.records[0],
        {
          ...basePlan.records[0],
          id: 'row-3',
          accepted: false,
          action: 'skip',
          errors: ['Missing sequence'],
        },
      ],
      canApply: true,
    });

    const result = await execTool<{ changed: boolean; code: string }>(
      createImportEntitiesTool(folders, deps),
      { sourcePath: 'orders/proteins.csv', entityType: 'protein' }
    );

    expect(result).toMatchObject({ changed: false, code: 'IMPORT_REVIEW_REQUIRED' });
    expect(deps.recordProteins).not.toHaveBeenCalled();
    expect(deps.recordOligos).not.toHaveBeenCalled();
  });

  it('returns a clean unchanged result for an exact duplicate-only plan', async () => {
    const deps = dependencies();
    const basePlan = await dependencies().createPlan({
      fileName: 'proteins.csv',
      text: '',
      forcedKind: 'protein',
    });
    vi.mocked(deps.createPlan).mockResolvedValueOnce({
      ...basePlan,
      records: [
        {
          ...basePlan.records[0],
          accepted: false,
          action: 'skip',
          duplicateCandidates: [{ entityId: 'existing', name: 'Alpha', reason: 'exact match' }],
        },
      ],
      canApply: false,
    });

    const result = await execTool<{ changed: boolean; code: string; skipped: number }>(
      createImportEntitiesTool(folders, deps),
      { sourcePath: 'orders/proteins.csv', entityType: 'protein' }
    );

    expect(result).toMatchObject({ changed: false, code: 'IMPORT_UNCHANGED', skipped: 1 });
    expect(deps.recordProteins).not.toHaveBeenCalled();
  });

  it('rejects pinned roots before reading or writing', async () => {
    const deps = dependencies();
    const foldersWithPinned: WorkspaceFolder[] = [
      ...folders,
      { name: 'Dev Assets', path: '/repo/test-fixtures', addedAt: 1, pinned: true },
    ];

    const result = await execTool<{ changed: boolean; code: string; message: string }>(
      createImportEntitiesTool(foldersWithPinned, deps),
      { sourcePath: 'Dev Assets/proteins.csv', entityType: 'protein' }
    );

    expect(result).toMatchObject({ changed: false, code: 'ENTITY_IMPORT_FAILED' });
    expect(result.message).toMatch(/read-only/i);
    expect(deps.readSource).not.toHaveBeenCalled();
    expect(deps.recordProteins).not.toHaveBeenCalled();
  });

  it.each([
    { sheetName: undefined, selectedSheet: 'Orders', expected: /multiple importable/i },
    { sheetName: 'Typo', selectedSheet: 'Orders', expected: /was not found/i },
  ])('refuses ambiguous worksheet selection with zero writes', async (scenario) => {
    const deps = dependencies();
    const basePlan = await dependencies().createPlan({
      fileName: 'book.xlsx',
      arrayBuffer: new ArrayBuffer(0),
      forcedKind: 'protein',
    });
    vi.mocked(deps.createPlan).mockResolvedValueOnce({
      ...basePlan,
      sourceKind: 'xlsx',
      selectedSheet: scenario.selectedSheet,
      sheetDispositions: [
        { sheetName: 'Orders', verdict: 'entity-table', score: 10, rowCount: 10 },
        { sheetName: 'Archive', verdict: 'possible-table', score: 6, rowCount: 5 },
      ],
    });

    const result = await execTool<{ changed: boolean; code: string; message: string }>(
      createImportEntitiesTool(folders, deps),
      {
        sourcePath: 'orders/book.xlsx',
        entityType: 'protein',
        ...(scenario.sheetName ? { sheetName: scenario.sheetName } : {}),
      }
    );

    expect(result).toMatchObject({ changed: false, code: 'IMPORT_REVIEW_REQUIRED' });
    expect(result.message).toMatch(scenario.expected);
    expect(deps.recordProteins).not.toHaveBeenCalled();
  });

  it('keeps every callable parameter visible at the top level', () => {
    expect(Object.keys(importEntitiesSchema.shape)).toEqual([
      'sourcePath',
      'entityType',
      'destinationPath',
      'sheetName',
      'columnMappings',
    ]);
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const createImportEntitiesTool = checkedToolFactory(uncheckedcreateImportEntitiesTool, importEntitiesOutputSchema);
