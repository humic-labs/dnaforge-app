import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn().mockResolvedValue([]),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    db: { select: mockSelect, execute: vi.fn() },
  }),
}));

import {
  findPrimerRegistryEntityId,
  searchPrimerReferencesByName,
} from './primer-reference-search';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p1',
    name: 'M13-fwd',
    sequence: 'GTAAAACGACGGCCAGT',
    length: 17,
    catalog_number: 'DNA-P-1',
    origin_details: JSON.stringify({
      authority: 'primer_artifact',
      artifactPath: 'primers/M13-fwd.primer.json',
      limsEntityId: 'oligo-m13-fwd',
    }),
    workspace_path: '/ws/beta',
    ...over,
  };
}

describe('searchPrimerReferencesByName', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    mockSelect.mockResolvedValue([]);
  });

  it('widens the SELECT to include origin_details', async () => {
    await searchPrimerReferencesByName({ query: 'M13', workspaceRoot: '/ws/beta' });

    const [sql] = mockSelect.mock.calls[0] as [string];
    expect(sql).toContain('origin_details');
  });

  it('returns a portable path for an artifact-backed primer in the owning root', async () => {
    mockSelect.mockResolvedValue([row()]);

    const [candidate] = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidate?.workspaceRelativePath).toBe('primers/M13-fwd.primer.json');
    expect(candidate?.localOnly).toBe(false);
    expect(candidate?.primerId).toBe('p1');
  });

  it('marks a primer with NO artifact as local-only (D9)', async () => {
    mockSelect.mockResolvedValue([row({ origin_details: null })]);

    const [candidate] = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidate?.localOnly).toBe(true);
    expect(candidate?.workspaceRelativePath).toBeNull();
  });

  it('marks a primer whose artifact lives in ANOTHER workspace as local-only', async () => {
    mockSelect.mockResolvedValue([row({ workspace_path: '/ws/alpha' })]);

    const [candidate] = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidate?.localOnly).toBe(true);
    expect(candidate?.workspaceRelativePath).toBeNull();
  });

  it('still OFFERS a cross-workspace primer rather than hiding it', async () => {
    mockSelect.mockResolvedValue([row({ workspace_path: '/ws/alpha' })]);

    const candidates = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('M13-fwd');
  });

  it('is local-only when origin_details is present but names no artifact path', async () => {
    mockSelect.mockResolvedValue([
      row({ origin_details: JSON.stringify({ authority: 'manual' }) }),
    ]);

    const [candidate] = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidate?.localOnly).toBe(true);
  });

  it('survives malformed origin_details rather than throwing', async () => {
    mockSelect.mockResolvedValue([row({ origin_details: '{not json' })]);

    const [candidate] = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidate?.localOnly).toBe(true);
  });

  it('rejects an artifact path that tries to escape the workspace', async () => {
    mockSelect.mockResolvedValue([
      row({
        origin_details: JSON.stringify({
          authority: 'primer_artifact',
          artifactPath: '../../etc/passwd',
        }),
      }),
    ]);

    const [candidate] = await searchPrimerReferencesByName({
      query: 'M13',
      workspaceRoot: '/ws/beta',
    });

    expect(candidate?.localOnly).toBe(true);
    expect(candidate?.workspaceRelativePath).toBeNull();
  });

  it('escapes LIKE wildcards in the query', async () => {
    await searchPrimerReferencesByName({ query: '50%', workspaceRoot: '/ws/beta' });

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ESCAPE '\\'");
    expect(params).toContain('%50\\%%');
  });

  it('treats every primer as local-only when there is no owning root', async () => {
    mockSelect.mockResolvedValue([row()]);

    const [candidate] = await searchPrimerReferencesByName({ query: 'M13', workspaceRoot: null });

    expect(candidate?.localOnly).toBe(true);
  });
});

describe('findPrimerRegistryEntityId', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    mockSelect.mockResolvedValue([]);
  });

  it('uses the explicit artifact projection bridge rather than assuming ids match', async () => {
    mockSelect.mockResolvedValue([
      { origin_details: JSON.stringify({ limsEntityId: 'oligo-registry-42' }) },
    ]);

    await expect(findPrimerRegistryEntityId('primer-library-7')).resolves.toBe('oligo-registry-42');
    expect(mockSelect).toHaveBeenCalledWith(expect.stringContaining('FROM primers WHERE id = ?'), [
      'primer-library-7',
    ]);
  });

  it('returns null for a manual legacy primer with no Registry projection', async () => {
    mockSelect.mockResolvedValue([{ origin_details: JSON.stringify({ authority: 'manual' }) }]);
    await expect(findPrimerRegistryEntityId('legacy-primer')).resolves.toBeNull();
  });

  it('degrades malformed origin metadata to no Registry target', async () => {
    mockSelect.mockResolvedValue([{ origin_details: '{broken' }]);
    await expect(findPrimerRegistryEntityId('broken-primer')).resolves.toBeNull();
  });
});
