import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { StrainCreationForm } from './StrainCreationForm';
const native = vi.hoisted(() => ({ schemas: vi.fn(), search: vi.fn() }));
vi.mock('../operations', () => ({
  getLimsSchemas: native.schemas,
  queryLimsRegistrySummaries: native.search,
}));
vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { readDir: vi.fn(async () => []) } }),
}));
it('passes the exact structured record selection through ordinary Create strain', async () => {
  native.schemas.mockResolvedValue([
    {
      schemaId: 'strain-schema',
      currentRevisionId: 'strain-schema-v2',
      entityKind: 'strain',
      baseKind: 'strain',
      displayName: 'Strain',
      description: null,
      version: 2,
      builtin: true,
      fields: [
        {
          key: 'genotypeCanonical',
          label: 'Canonical genotype',
          type: 'long_text',
          required: true,
        },
        {
          key: 'relatedRecord',
          label: 'Related record',
          type: 'record_relationship',
          required: false,
        },
      ],
    },
  ]);
  native.search.mockResolvedValue({
    summaries: [
      {
        id: 'old-dna',
        name: 'Existing DNA',
        kind: 'sequence',
        registryId: 'dna001',
        archived: false,
      },
    ],
    totalCount: 1,
  });
  act(() =>
    useWorkspaceStore.setState({ folders: [{ path: '/project', name: 'Project', addedAt: 1 }] })
  );
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <StrainCreationForm
      workspaceRoot="/project"
      initialSaveDir="/project"
      onSave={save}
      onCancel={vi.fn()}
    />
  );
  fireEvent.change(screen.getByTestId('strain-name-input'), { target: { value: 'Linked strain' } });
  fireEvent.change(screen.getByTestId('strain-field-genotypeCanonical'), {
    target: { value: 'Explicit genotype' },
  });
  expect(
    (screen.getByRole('button', { name: 'Create strain' }) as HTMLButtonElement).disabled
  ).toBe(true);
  await screen.findByText('More details', { exact: true });
  fireEvent.click(screen.getByText('More details', { exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Related record' }));
  fireEvent.click(await screen.findByRole('button', { name: /Existing DNA/u }));
  fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toMatchObject({
    kind: 'strain',
    schemaId: 'strain-schema',
    expectedSchemaRevisionId: 'strain-schema-v2',
    name: 'Linked strain',
    workspaceRoot: '/project',
    destinationDir: '/project',
    fields: {
      genotypeCanonical: 'Explicit genotype',
      relatedRecord: {
        origin: 'native',
        resolution: 'exact',
        relationType: 'references',
        label: 'Existing DNA',
        destinationEntityId: 'old-dna',
      },
    },
  });
  expect(save.mock.calls[0][0].id).toBeTruthy();
});
it('omits an unselected optional record field while preserving the loaded schema pins', async () => {
  native.schemas.mockResolvedValue([
    {
      schemaId: 'strain-schema',
      currentRevisionId: 'strain-schema-v2',
      entityKind: 'strain',
      baseKind: 'strain',
      displayName: 'Strain',
      description: null,
      version: 2,
      builtin: true,
      fields: [
        {
          key: 'genotypeCanonical',
          label: 'Canonical genotype',
          type: 'long_text',
          required: true,
        },
        {
          key: 'relatedRecord',
          label: 'Related record',
          type: 'record_relationship',
          required: false,
        },
      ],
    },
  ]);
  act(() =>
    useWorkspaceStore.setState({ folders: [{ path: '/project', name: 'Project', addedAt: 1 }] })
  );
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <StrainCreationForm
      workspaceRoot="/project"
      initialSaveDir="/project"
      onSave={save}
      onCancel={vi.fn()}
    />
  );
  fireEvent.change(screen.getByTestId('strain-name-input'), {
    target: { value: 'Unlinked strain' },
  });
  fireEvent.change(screen.getByTestId('strain-field-genotypeCanonical'), {
    target: { value: 'Explicit genotype' },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Create strain' }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toMatchObject({
    schemaId: 'strain-schema',
    expectedSchemaRevisionId: 'strain-schema-v2',
    fields: { genotypeCanonical: 'Explicit genotype' },
  });
  expect(save.mock.calls[0][0].fields).not.toHaveProperty('relatedRecord');
});
