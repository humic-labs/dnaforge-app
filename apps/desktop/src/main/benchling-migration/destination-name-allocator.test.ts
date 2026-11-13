import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BenchlingMigrationActionAllocation } from '../../shared/benchling-migration-action-journal';
import {
  allocateBenchlingDestination,
  allocationCollisionKey,
  DestinationAllocationCancelledError,
  DestinationStructuralConflictError,
  safeDestinationSegment,
  type AllocateBenchlingDestinationInput,
} from './destination-name-allocator';

describe('Benchling destination name allocator', () => {
  it('maps the provider hierarchy directly and normalizes unsafe or empty names', async () => {
    const workspacePath = await workspace();
    const allocation = await allocateBenchlingDestination(
      request(workspacePath, {
        displayName: 'CON',
        canonicalMembership: membership(['Selected Root', 'Café']),
      })
    );
    expect(allocation.destination).toEqual({
      kind: 'file',
      relativePath: 'Selected Root/Café/CON_.gb',
    });
    expect(
      allocation.destination.kind === 'file' && allocation.destination.relativePath
    ).not.toContain('Benchling Imports');
    expect(safeDestinationSegment('  <>  ', 'Imported item')).toBe('Imported item');
    expect(
      safeDestinationSegment(
        '[ENTRY 9] Lysis and Buffer Exchange for Asparaginase Activity Assay #1 (on lysate)',
        'Imported item'
      )
    ).toContain('#1');
  });

  it('uses NFC plus ASCII case folding for collision identity', () => {
    expect(allocationCollisionKey('Café/ABC.gb')).toBe(allocationCollisionKey('Cafe\u0301/abc.gb'));
    expect(allocationCollisionKey('É')).not.toBe(allocationCollisionKey('é'));
  });

  it('adds a stable-ID suffix before the extension and remains stable on retry', async () => {
    const workspacePath = await workspace();
    await mkdir(join(workspacePath, 'Selected Root'), { recursive: true });
    await writeFile(join(workspacePath, 'Selected Root', 'Plasmid.gb'), 'existing', 'utf8');
    const first = await allocateBenchlingDestination(request(workspacePath));
    expect(first.destination).toEqual({
      kind: 'file',
      relativePath: 'Selected Root/Plasmid--seq_ABCDEFGH.gb',
    });
    expect(first.collisionSuffixDecision).toEqual({
      kind: 'stable_id',
      suffix: '--seq_ABCDEFGH',
      ordinal: 1,
    });

    await writeFile(
      join(workspacePath, 'Selected Root', 'Plasmid--seq_ABCDEFGH.gb'),
      'later collision',
      'utf8'
    );
    await expect(
      allocateBenchlingDestination(request(workspacePath, { existingAllocations: [first] }))
    ).resolves.toEqual(first);
    const second = await allocateBenchlingDestination(
      request(workspacePath, { sourceObjectId: 'seq_IJKLMNOP', providerStableId: 'seq_IJKLMNOP' })
    );
    expect(second.destination).toEqual({
      kind: 'file',
      relativePath: 'Selected Root/Plasmid--seq_IJKLMNOP.gb',
    });
  });

  it('allocates against batch, journal, manifest, and catalog reservations', async () => {
    const workspacePath = await workspace();
    const allocation = await allocateBenchlingDestination(
      request(workspacePath, {
        variant: {
          kind: 'catalog-record',
          catalogType: 'strain',
          presentationKind: 'strain',
        },
        reservations: [
          {
            relativePath: 'Selected Root/Plasmid',
            kind: 'catalog-record',
            ownerSourceObjectId: 'other',
          },
        ],
      })
    );
    expect(allocation.destination).toEqual({
      kind: 'catalog-record',
      parentRelativePath: 'Selected Root',
      displayName: 'Plasmid--seq_ABCDEFGH',
      catalogType: 'strain',
      presentationKind: 'strain',
    });
    expect(allocation.actionOwnedPaths).toEqual([]);
  });

  it('requires a persisted decision for file-versus-folder and intermediate conflicts', async () => {
    const workspacePath = await workspace();
    await writeFile(join(workspacePath, 'Selected Root'), 'file blocks hierarchy', 'utf8');
    const unresolved = request(workspacePath);
    const conflict = await allocateBenchlingDestination(unresolved).catch((error) => error);
    expect(conflict).toBeInstanceOf(DestinationStructuralConflictError);
    expect(conflict).toMatchObject({ relativePath: 'Selected Root' });

    const expectedExistingState = (conflict as DestinationStructuralConflictError)
      .expectedExistingState;
    await expect(
      allocateBenchlingDestination(
        request(workspacePath, {
          decisions: [
            {
              kind: 'structural_path_conflict',
              relativePath: 'Selected Root',
              expectedExistingState,
              policy: 'replace_existing',
            },
          ],
        })
      )
    ).resolves.toMatchObject({
      destination: { kind: 'file', relativePath: 'Selected Root/Plasmid.gb' },
      rollback: {
        kind: 'displaced',
        targetRelativePath: 'Selected Root',
      },
    });
    await expect(
      allocateBenchlingDestination(
        request(workspacePath, {
          decisions: [
            {
              kind: 'structural_path_conflict',
              relativePath: 'Selected Root',
              expectedExistingState,
              policy: 'cancel_import',
            },
          ],
        })
      )
    ).rejects.toBeInstanceOf(DestinationAllocationCancelledError);
  });

  it('renames an incoming file when its leaf is an existing directory', async () => {
    const workspacePath = await workspace();
    await mkdir(join(workspacePath, 'Selected Root', 'Plasmid.gb'), { recursive: true });
    const conflict = await allocateBenchlingDestination(request(workspacePath)).catch(
      (error) => error
    );
    expect(conflict).toBeInstanceOf(DestinationStructuralConflictError);
    const expectedExistingState = (conflict as DestinationStructuralConflictError)
      .expectedExistingState;
    const allocation = await allocateBenchlingDestination(
      request(workspacePath, {
        decisions: [
          {
            kind: 'structural_path_conflict',
            relativePath: 'Selected Root/Plasmid.gb',
            expectedExistingState,
            policy: 'rename_incoming',
          },
        ],
      })
    );
    expect(allocation.destination).toEqual({
      kind: 'file',
      relativePath: 'Selected Root/Plasmid--seq_ABCDEFGH.gb',
    });
  });

  it('rejects protected roots and every symlink traversal', async () => {
    const workspacePath = await workspace();
    await mkdir(join(workspacePath, 'outside'));
    await symlink(join(workspacePath, 'outside'), join(workspacePath, 'Linked'));
    await expect(
      allocateBenchlingDestination(
        request(workspacePath, { canonicalMembership: membership(['Linked']) })
      )
    ).rejects.toThrow(/symlink/iu);
    await expect(
      allocateBenchlingDestination(
        request(workspacePath, { canonicalMembership: membership(['.forge']) })
      )
    ).rejects.toThrow(/protected/iu);
  });

  it('persists one canonical membership while retaining alternate memberships', async () => {
    const workspacePath = await workspace();
    const canonicalMembership = {
      sourceFolderId: 'fld_primary',
      hierarchySegments: ['Primary folder'],
      alternateSourceFolderIds: ['fld_other_a', 'fld_other_b'],
    } as const;
    const allocation = await allocateBenchlingDestination(
      request(workspacePath, { canonicalMembership })
    );
    expect(allocation.canonicalMembership).toEqual(canonicalMembership);
    expect(allocation.destination).toEqual({
      kind: 'file',
      relativePath: 'Primary folder/Plasmid.gb',
    });
  });
});

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dnaforge-destination-allocator-'));
}

function membership(hierarchySegments: readonly string[]) {
  return {
    sourceFolderId: 'fld_ABCDEFGH',
    hierarchySegments,
    alternateSourceFolderIds: [],
  } as const;
}

function request(
  workspacePath: string,
  overrides: Partial<Extract<AllocateBenchlingDestinationInput, { providerIdentity: object }>> & {
    providerStableId?: string;
  } = {}
): AllocateBenchlingDestinationInput {
  const sourceObjectId = overrides.sourceObjectId ?? 'seq_ABCDEFGH';
  const providerStableId = overrides.providerStableId ?? sourceObjectId;
  const existingAllocations =
    overrides.existingAllocations ?? ([] as readonly BenchlingMigrationActionAllocation[]);
  return {
    actionId: 'action-1',
    workspacePath,
    sourceObjectId,
    providerIdentity: {
      provider: 'benchling',
      stableObjectId: providerStableId,
      objectClass: 'sequence',
    },
    destinationEntityId: `entity-${sourceObjectId}`,
    displayName: 'Plasmid',
    variant: { kind: 'file', extension: '.gb' },
    canonicalMembership: membership(['Selected Root']),
    expectedPriorImportedHash: null,
    decisions: [],
    reservations: [],
    existingAllocations,
    ...overrides,
  };
}
