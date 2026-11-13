/** @vitest-environment jsdom */

import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { LIMS_BUILTIN_ENTITY_SCHEMAS } from '../../shared/lims';
import { EntityCreationHost } from './EntityCreationHost';
import { supportsGenericEntityCreation } from './SchemaEntityCreationForm';
import { openEntityCreation, useEntityCreationStore } from './entity-creation-store';
import { EntityArtifactCreationProjectionError } from '../lims/public/record-entity-artifact';
import type { EntityArtifactV2 } from '../lims/public/entity-artifact';

const commandMocks = vi.hoisted(() => ({ createEntity: vi.fn(), listSchemas: vi.fn() }));

vi.mock('../lims/public/record-entity-artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lims/public/record-entity-artifact')>()),
  recordEntityArtifact: commandMocks.createEntity,
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { readDir: vi.fn(async () => []) },
    lims: { listSchemas: commandMocks.listSchemas },
  }),
}));

describe('EntityCreationHost', () => {
  it('supports a record whose schema requires an entity link', () => {
    expect(
      supportsGenericEntityCreation({
        schemaId: 'linked-record',
        currentRevisionId: 'linked-record-v1',
        entityKind: 'linked_record',
        baseKind: 'record',
        displayName: 'Linked record',
        description: null,
        version: 1,
        builtin: false,
        fields: [
          { key: 'parent', label: 'Parent entity', type: 'record_relationship', required: true },
        ],
      })
    ).toBe(true);
  });

  it('does not route a sequence-backed schema into the generic record-file creator', () => {
    expect(
      supportsGenericEntityCreation({
        schemaId: 'custom-sequence',
        currentRevisionId: 'custom-sequence-v1',
        entityKind: 'custom_sequence',
        baseKind: 'sequence',
        displayName: 'Custom sequence',
        description: null,
        version: 1,
        builtin: false,
        fields: [],
      })
    ).toBe(false);
  });
  beforeEach(() => {
    commandMocks.createEntity.mockReset();
    commandMocks.listSchemas.mockReset().mockResolvedValue(
      LIMS_BUILTIN_ENTITY_SCHEMAS.map((schema) => ({
        schemaId: `schema:${schema.name}`,
        currentRevisionId: `schema:${schema.name}:v1`,
        entityKind: schema.name,
        baseKind: schema.name,
        displayName: schema.displayName,
        description: schema.description,
        version: 1,
        builtin: true,
        fields: schema.fields.map((field) => ({ ...field })),
      }))
    );
    useEntityCreationStore.setState({ request: null });
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace/project', name: 'project', addedAt: 1 }],
    });
  });

  afterEach(() => {
    act(() => useEntityCreationStore.setState({ request: null }));
  });

  it('retains the strain draft and creation identity while publication is pending, then closes only after an unchanged retry succeeds', async () => {
    commandMocks.createEntity
      .mockRejectedValueOnce(new Error('Strain accepted; Registry refresh remains pending.'))
      .mockResolvedValueOnce({
        artifactPath: '/workspace/project/strain.entity.json',
        artifact: { id: 'saved-strain', name: 'Planned BY4741', kind: 'strain' },
        gitCommitted: true,
      });
    render(<EntityCreationHost />);
    act(() => openEntityCreation({ entityType: 'strains', destinationPath: '/workspace/project' }));
    fireEvent.change(screen.getByTestId('strain-name-input'), {
      target: { value: 'Planned BY4741' },
    });
    fireEvent.change(screen.getByTestId('strain-field-genotypeCanonical'), {
      target: { value: 'MATa ura3Δ0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));
    expect(await screen.findByTestId('strain-form-error')).toHaveTextContent(
      userMessage('failure.could-not-create-the-strain')
    );
    expect(screen.getByTestId('strain-name-input')).toHaveValue('Planned BY4741');
    const first = commandMocks.createEntity.mock.calls[0][0];
    expect(first.id).toEqual(expect.any(String));
    fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));
    await waitFor(() =>
      expect(screen.queryByTestId('entity-creation-dialog')).not.toBeInTheDocument()
    );
    expect(commandMocks.createEntity.mock.calls[1][0]).toEqual(first);
  });

  it('creates a schema-backed strain file and opens its exact Registry detail', async () => {
    commandMocks.createEntity.mockResolvedValue({
      artifactPath: '/workspace/project/strains/DH5alpha-a1b2c3d4.entity.json',
      artifact: { id: 'strain-1', name: 'DH5alpha', kind: 'strain' },
      gitCommitted: true,
    });
    const openRegistryEntity = vi.fn();
    render(<EntityCreationHost onOpenRegistryEntity={openRegistryEntity} />);

    act(() => {
      openEntityCreation({
        entityType: 'strains',
        destinationPath: '/workspace/project/strains',
      });
    });

    expect(screen.getByRole('dialog', { name: 'Create strain' })).toBeVisible();
    fireEvent.change(screen.getByTestId('strain-name-input'), {
      target: { value: 'DH5alpha' },
    });
    fireEvent.change(screen.getByTestId('strain-field-genotypeCanonical'), {
      target: { value: 'recA1 endA1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));

    await waitFor(() => {
      expect(commandMocks.createEntity).toHaveBeenCalledWith({
        id: expect.any(String),
        kind: 'strain',
        name: 'DH5alpha',
        fields: { genotypeCanonical: 'recA1 endA1' },
        workspaceRoot: '/workspace/project',
        destinationDir: '/workspace/project/strains',
      });
      expect(screen.queryByTestId('entity-creation-dialog')).not.toBeInTheDocument();
    });
    expect(openRegistryEntity).toHaveBeenCalledWith('strain-1', 'DH5alpha');
  });

  it('retains the written record and retries only its exact projection', async () => {
    const artifact = {
      id: 'retained-record',
      kind: 'strain',
      name: 'Retained',
    } as EntityArtifactV2;
    commandMocks.createEntity
      .mockRejectedValueOnce(
        new EntityArtifactCreationProjectionError(
          '/workspace/project/Retained-retained.entity.json',
          'Retained-retained.entity.json',
          artifact,
          true,
          new Error('database unavailable')
        )
      )
      .mockResolvedValueOnce({
        artifact,
        artifactPath: '/workspace/project/Retained-retained.entity.json',
        created: false,
        gitCommitted: true,
      });
    const openRegistryEntity = vi.fn();
    render(<EntityCreationHost onOpenRegistryEntity={openRegistryEntity} />);
    act(() => openEntityCreation({ entityType: 'strains', destinationPath: '/workspace/project' }));
    fireEvent.change(screen.getByTestId('strain-name-input'), { target: { value: 'Retained' } });
    fireEvent.change(screen.getByTestId('strain-field-genotypeCanonical'), {
      target: { value: 'recA1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));
    await screen.findByTestId('entity-projection-recovery');
    expect(screen.queryByTestId('strain-name-input')).not.toBeInTheDocument();
    expect(openRegistryEntity).not.toHaveBeenCalled();
    const firstInput = commandMocks.createEntity.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Retry Registry' }));
    await waitFor(() =>
      expect(openRegistryEntity).toHaveBeenCalledWith('retained-record', 'Retained')
    );
    expect(commandMocks.createEntity).toHaveBeenLastCalledWith({
      ...firstInput,
      id: 'retained-record',
      artifactStem: 'Retained-retained',
    });
    expect(commandMocks.createEntity).toHaveBeenCalledTimes(2);
  });

  it('does not close a newer creation request when an older save completes', async () => {
    let resolveSave!: (value: { artifact: { id: string; name: string } }) => void;
    commandMocks.createEntity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    const openRegistryEntity = vi.fn();
    render(<EntityCreationHost onOpenRegistryEntity={openRegistryEntity} />);
    act(() => openEntityCreation({ entityType: 'strains', destinationPath: '/workspace/project' }));
    fireEvent.change(screen.getByTestId('strain-name-input'), { target: { value: 'Older' } });
    fireEvent.change(screen.getByTestId('strain-field-genotypeCanonical'), {
      target: { value: 'recA1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create strain' }));
    act(() =>
      openEntityCreation({ entityType: 'strains', destinationPath: '/workspace/project/strains' })
    );
    await act(async () => resolveSave({ artifact: { id: 'older', name: 'Older' } }));
    expect(useEntityCreationStore.getState().request?.destinationPath).toBe(
      '/workspace/project/strains'
    );
    expect(openRegistryEntity).not.toHaveBeenCalled();
  });

  it('does not resurrect bundled definitions when the current catalog is empty', async () => {
    commandMocks.listSchemas.mockResolvedValue([]);
    render(<EntityCreationHost />);
    act(() =>
      openEntityCreation({ entityType: 'registry-types', destinationPath: '/workspace/project' })
    );
    expect(await screen.findByText('No record schemas are available.')).toBeVisible();
    expect(screen.queryByTestId('schema-entity-type-organism')).not.toBeInTheDocument();
    expect(commandMocks.createEntity).not.toHaveBeenCalled();
  });

  it('offers a retry after a schema load failure without substituting bundled definitions', async () => {
    commandMocks.listSchemas.mockRejectedValueOnce(new Error('Definitions unavailable'));
    render(<EntityCreationHost />);
    act(() =>
      openEntityCreation({ entityType: 'registry-types', destinationPath: '/workspace/project' })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.schemas-could-not-be-loaded')
    );
    expect(screen.queryByTestId('schema-entity-type-organism')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry schemas' }));
    expect(await screen.findByTestId('schema-entity-type-organism')).toBeEnabled();
    expect(commandMocks.createEntity).not.toHaveBeenCalled();
  });

  it('chooses a concrete Registry schema and creates its file-backed entity', async () => {
    commandMocks.createEntity.mockResolvedValue({
      artifactPath: '/workspace/project/E-coli-organism-1.entity.json',
      artifact: { id: 'organism-1', name: 'E. coli', kind: 'organism' },
      gitCommitted: true,
    });
    const openRegistryEntity = vi.fn();
    render(<EntityCreationHost onOpenRegistryEntity={openRegistryEntity} />);

    act(() => {
      openEntityCreation({
        entityType: 'registry-types',
        destinationPath: '/workspace/project',
      });
    });

    expect(screen.getByRole('dialog', { name: 'Create Registry entity' })).toBeVisible();
    expect(await screen.findByTestId('schema-entity-type-organism')).toBeEnabled();
    expect(screen.queryByTestId('schema-entity-type-plasmid')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('schema-entity-type-organism'));

    expect(screen.getByRole('dialog', { name: 'Create Organism' })).toBeVisible();
    fireEvent.change(screen.getByTestId('schema-entity-name-input'), {
      target: { value: 'E. coli' },
    });
    fireEvent.change(screen.getByTestId('schema-entity-field-taxid'), {
      target: { value: '562' },
    });
    fireEvent.change(screen.getByTestId('schema-entity-field-scientificName'), {
      target: { value: 'Escherichia coli' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Organism' }));

    await waitFor(() => {
      expect(commandMocks.createEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'organism',
          schemaId: 'schema:organism',
          expectedSchemaRevisionId: 'schema:organism:v1',
          name: 'E. coli',
          fields: { taxid: '562', scientificName: 'Escherichia coli' },
          workspaceRoot: '/workspace/project',
          destinationDir: '/workspace/project',
        })
      );
      expect(screen.queryByTestId('entity-creation-dialog')).not.toBeInTheDocument();
    });
    expect(openRegistryEntity).toHaveBeenCalledWith('organism-1', 'E. coli');
  });
});
