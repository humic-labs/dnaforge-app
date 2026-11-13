import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';

const mocks = vi.hoisted(() => ({
  namespace: vi.fn(),
  read: vi.fn(),
  text: vi.fn(),
  exists: vi.fn(),
}));
vi.mock('./read-scientific-namespace', () => ({ readScientificNamespace: mocks.namespace }));
vi.mock('../platform', () => ({
  platform: () => ({
    scientificObjects: { read: mocks.read },
    fs: { readTextFile: mocks.text, exists: mocks.exists },
  }),
}));
import { scientificRelationshipGitPaths } from './scientific-git-projections';

const path = '.dnaforge/relationships/ancestry.json';
const workspace = parseWorkspaceIdentity(workspaceScopeKey('scientific-project', 1));
const acceptedRevision = `rr_${'b'.repeat(64)}`;
const document = {
  formatVersion: 1,
  kind: 'strain-descent',
  strainId: 'assay',
  parent: { resourceId: 'parent', revisionId: `rr_${'a'.repeat(64)}` },
  assertion: 'planned',
  evidence: [],
} as const;

describe('accepted relationship Git publication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.namespace.mockResolvedValue({
      workspace,
      entries: [{ resourceId: 'ancestry', revisionId: acceptedRevision, path, tombstone: false }],
    });
    mocks.read.mockResolvedValue({
      resourceId: 'ancestry',
      revisionId: acceptedRevision,
      document,
    });
    mocks.text.mockResolvedValue(defineScientificDocument(document as never).text);
  });

  it('includes the exact accepted projection while leaving unrelated working files out', async () => {
    const paths = await scientificRelationshipGitPaths(
      '/project',
      new Map([
        [path, '?'],
        ['.dnaforge/relationships/unsubmitted.json', '?'],
        ['notes.txt', 'M'],
      ])
    );
    expect(paths).toEqual([path]);
    expect(mocks.read).toHaveBeenCalledWith({
      workspaceRoot: '/project',
      request: {
        workspace,
        resourceId: 'ancestry',
        revisionId: acceptedRevision,
      },
    });
  });

  it('refuses to commit a working edit that differs from accepted relationship bytes', async () => {
    mocks.text.mockResolvedValue('external unsubmitted relationship edit');
    await expect(
      scientificRelationshipGitPaths('/project', new Map([[path, 'M']]))
    ).rejects.toThrow('conflicting working edit');
  });
});
