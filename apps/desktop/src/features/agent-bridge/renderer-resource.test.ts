import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGetEntityReference } = vi.hoisted(() => ({
  mockGetEntityReference: vi.fn(),
}));

vi.mock('../../db/entity-references', () => ({
  getEntityReference: mockGetEntityReference,
}));

import { readSelectionResource } from './renderer-resource';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ref-123',
    entity_type: 'sequence_region',
    display_label: 'pUC19.gb 123–456',
    locator: 'plasmids/pUC19.gb',
    deep_link_params: JSON.stringify({ start: 123, end: 456 }),
    data: JSON.stringify({
      schemaVersion: 2,
      kind: 'sequence_region',
      measured: { lengthBp: 334 },
    }),
    source: 'user',
    status: 'created',
    created_at: 1,
    updated_at: 1,
    workspace_scope: '/lab/project.workspace',
    ...overrides,
  };
}

describe('readSelectionResource', () => {
  const context = {
    expectedSessionToken: 'renderer-session',
    providedSessionToken: 'renderer-session',
    agentCapabilities: ['read-workspace'],
    boundWorkspaceId: '/lab/project.workspace',
    currentWorkspaceId: '/lab/project.workspace',
  };
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the parsed descriptor as reference.data for a stored biology card', async () => {
    mockGetEntityReference.mockResolvedValue(row());

    const result = await readSelectionResource('ref-123', context);

    expect(result).toEqual({
      ok: true,
      reference: {
        id: 'ref-123',
        entityType: 'sequence_region',
        displayLabel: 'pUC19.gb 123–456',
        locator: 'plasmids/pUC19.gb',
        deepLinkParams: { start: 123, end: 456 },
        data: {
          schemaVersion: 2,
          kind: 'sequence_region',
          measured: { lengthBp: 334 },
        },
      },
    });
    expect(mockGetEntityReference).toHaveBeenCalledWith('ref-123');
  });

  it('returns SELECTION_NOT_FOUND when the row is missing', async () => {
    mockGetEntityReference.mockResolvedValue(null);

    const result = await readSelectionResource('missing', context);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'SELECTION_NOT_FOUND',
        message: 'No selection reference found for id: missing',
        retriable: false,
      },
    });
  });

  it('returns SELECTION_NO_DESCRIPTOR when the row has null data (coords-only chip)', async () => {
    mockGetEntityReference.mockResolvedValue(row({ data: null }));

    const result = await readSelectionResource('ref-123', context);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SELECTION_NO_DESCRIPTOR' },
    });
  });

  it('returns SELECTION_NO_DESCRIPTOR when the stored descriptor JSON is corrupt', async () => {
    mockGetEntityReference.mockResolvedValue(row({ data: '{not valid json' }));

    const result = await readSelectionResource('ref-123', context);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SELECTION_NO_DESCRIPTOR' },
    });
  });

  it('rejects non-v2 and entity-kind-mismatched selection descriptors', async () => {
    mockGetEntityReference.mockResolvedValueOnce(
      row({ data: JSON.stringify({ kind: 'sequence_region', measured: {} }) })
    );
    await expect(readSelectionResource('ref-123', context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SELECTION_INVALID_DESCRIPTOR' },
    });

    mockGetEntityReference.mockResolvedValueOnce(
      row({ data: JSON.stringify({ schemaVersion: 2, kind: 'annotation', measured: {} }) })
    );
    await expect(readSelectionResource('ref-123', context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SELECTION_KIND_MISMATCH' },
    });
  });

  it('rejects a structure descriptor unless every selected residue identity is complete', async () => {
    mockGetEntityReference.mockResolvedValue(
      row({
        entity_type: 'structure',
        data: JSON.stringify({
          schemaVersion: 2,
          kind: 'structure',
          measured: {
            residueCount: 1,
            residueOmittedCount: 0,
            residueIdentityKnownCount: 0,
            residueIdentityUnknownCount: 1,
            residueIdentityOmittedCount: 0,
            residues: [{ chain: 'A', authSeqId: 57, identityStatus: 'unknown', labelCompId: null }],
          },
        }),
      })
    );

    await expect(readSelectionResource('ref-123', context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'STRUCTURE_RESIDUE_IDENTITIES_INCOMPLETE' },
    });
  });

  it('tolerates unparseable deep_link_params without failing the read', async () => {
    mockGetEntityReference.mockResolvedValue(row({ deep_link_params: null }));

    const result = await readSelectionResource('ref-123', context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reference.deepLinkParams).toBeNull();
  });

  it('rejects an empty reference id with BAD_INPUT before touching the DB', async () => {
    const result = await readSelectionResource('', context);

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(mockGetEntityReference).not.toHaveBeenCalled();
  });

  it('fails closed for an unscoped legacy row or a row owned by another workspace', async () => {
    mockGetEntityReference.mockResolvedValueOnce(row({ workspace_scope: null }));
    await expect(readSelectionResource('ref-123', context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'REFERENCE_UNSCOPED' },
    });

    mockGetEntityReference.mockResolvedValueOnce(row({ workspace_scope: '/lab/other.workspace' }));
    await expect(readSelectionResource('ref-123', context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'REFERENCE_SCOPE_MISMATCH' },
    });
  });

  it('rejects missing capability and a renderer session bound to another workspace', async () => {
    await expect(
      readSelectionResource('ref-123', { ...context, agentCapabilities: [] })
    ).resolves.toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_SCOPE' } });
    await expect(
      readSelectionResource('ref-123', { ...context, boundWorkspaceId: '/lab/other.workspace' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'WRONG_WORKSPACE' } });
    expect(mockGetEntityReference).not.toHaveBeenCalled();
  });
});
