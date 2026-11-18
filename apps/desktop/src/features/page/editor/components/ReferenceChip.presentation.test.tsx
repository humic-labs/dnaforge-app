import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ saved: vi.fn(), resource: vi.fn() }));
vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../molecular-documents/public/references', () => ({
  resolveMolecularReferenceRecord: mocks.saved,
}));
vi.mock('../../../../platform', () => ({
  platform: () => ({ notebook: { resolveResourceReference: mocks.resource } }),
}));
import { SavedReferenceChip } from './SavedReferenceChip';
import { ProjectResourceReferenceChip } from './ProjectResourceReferenceChip';
const extension = { options: { referenceNotebookPageId: () => 'notebook-id' } };
beforeEach(() => vi.clearAllMocks());
describe('notebook reference icon presentation', () => {
  it('uses the resolved canonical RNA kind for a saved primer reference', async () => {
    mocks.saved.mockResolvedValue({
      id: 'a25ea0f6-aa8a-45e3-bd55-60028d7b7dc9',
      entity_type: 'primer',
      locator: 'entity://primer/oligo-id',
      data: JSON.stringify({ registryEntityId: 'oligo-id' }),
      iconContext: { kind: 'rna_oligo' },
    });
    const props = {
      node: {
        attrs: {
          referenceUri: 'dnaforge-chat://reference/a25ea0f6-aa8a-45e3-bd55-60028d7b7dc9',
          label: 'Saved oligo',
        },
      },
      extension,
    } as never;
    const { container } = render(<SavedReferenceChip {...props} />);
    await waitFor(() =>
      expect(container.querySelector('svg')).toHaveAttribute('data-entity-color-family', 'rna')
    );
  });
  it.each([
    ['analysis.py', 'code'],
    ['measurements.csv', 'data'],
  ] as const)('uses the actual resource path for %s', async (path, family) => {
    const reference = { kind: 'path', projectId: 'project-id', resourceKind: 'file', path };
    mocks.resource.mockResolvedValue({
      reference,
      workspaceRoot: '/project',
      path: '/project/' + path,
      entityType: 'file',
      label: 'A label without an extension',
    });
    const props = {
      node: { attrs: { resourceReference: reference, label: 'A label without an extension' } },
      extension,
    } as never;
    const { container } = render(<ProjectResourceReferenceChip {...props} />);
    await waitFor(() =>
      expect(container.querySelector('svg')).toHaveAttribute('data-entity-color-family', family)
    );
  });
});
