import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectResourceReferenceHref,
  type ProjectResourceReference,
} from '../../../../shared/project-resource-reference';
import { buildInlineTextDocument, projectPersistedInlineTextDocument } from './document';
import { createInlineReferenceSession } from './session';

const transport = vi.hoisted(() => ({
  resolve: vi.fn(),
  fallback: vi.fn(),
  available: true,
}));
vi.mock('../../../../platform', () => ({
  platform: () => ({
    fs: {
      resolveProjectResourceReference: transport.available ? transport.resolve : undefined,
      resolveInlineReferenceTarget: transport.fallback,
    },
  }),
}));

const projectId = '6a06aec1-382d-4a2f-8d2f-d08c98850cb6';
const resources: ProjectResourceReference[] = [
  { kind: 'entity', projectId, entityId: 'track-view-exact-saved-klf17' },
  { kind: 'path', projectId, path: 'analyses/evo2-klf17/selection.json', resourceKind: 'file' },
  { kind: 'path', projectId, path: 'analyses/evo2-klf17', resourceKind: 'directory' },
];
afterEach(() => {
  transport.available = true;
  vi.clearAllMocks();
});

describe(' copied notebook resource links remain actionable in chat', () => {
  it.each(resources)(
    'keeps exact %j through live resolution, finalization and persisted projection',
    async (reference) => {
      const href = projectResourceReferenceHref(reference);
      const source = `Read [the pilot evidence](${href}).`;
      expect(buildInlineTextDocument(source, { streaming: false }).parts[0].declaration).toEqual({
        kind: 'project-resource',
        resource: reference,
      });
      transport.resolve.mockResolvedValue({
        reference,
        workspaceRoot: '/registered/hidden-project',
        path: '/registered/hidden-project/evidence',
        entityType: reference.kind === 'entity' ? 'track-view' : reference.resourceKind,
        label: 'Pilot evidence',
      });
      const session = createInlineReferenceSession({
        roots: [],
        workspaceScope: null,
        allowedExistingReferenceIds: [],
        loadReferences: async () => [],
      });
      session.update('answer', source);
      const final = await session.finalize();
      const answer = final.blocks.get('answer')!;
      expect(transport.resolve).toHaveBeenCalledWith(reference);
      expect(transport.fallback).not.toHaveBeenCalled();
      expect(answer.content).toContain(href);
      expect(answer.document.parts).toHaveLength(1);
      expect(answer.document.parts[0]).toMatchObject({
        declaration: { kind: 'project-resource', resource: reference },
        state: { status: 'resolved' },
      });
      expect(final.proposedRows).toEqual([]);
      expect(final.referencedRows).toEqual([]);
      expect(answer.referenceIds).toEqual([]);
      const persisted = projectPersistedInlineTextDocument(answer.content, [], new Map());
      expect(persisted.parts).toHaveLength(1);
      expect(persisted.parts[0]).toMatchObject({
        declaration: { kind: 'project-resource', resource: reference },
        state: { status: 'resolved' },
      });
    }
  );

  it('refuses unresolved native authority without falling back to caller-supplied filesystem paths', async () => {
    transport.available = false;
    const session = createInlineReferenceSession({
      roots: [{ name: 'Caller supplied root', path: '/host' }],
      workspaceScope: null,
      allowedExistingReferenceIds: [],
      loadReferences: async () => [],
    });
    session.update('answer', `[Evidence](${projectResourceReferenceHref(resources[1])})`);
    const final = await session.finalize();
    expect(final.blocks.get('answer')?.document.parts[0]?.state.status).not.toBe('resolved');
    expect(transport.fallback).not.toHaveBeenCalled();
    expect(final.proposedRows).toEqual([]);
  });
});
