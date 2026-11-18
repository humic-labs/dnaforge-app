import { withUserMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsSchemaDefinitionView } from '../../../../shared/lims';
import { RegistrySchemaManager } from './RegistrySchemaManager';

const defineSchema = vi.fn();
const refineSchema = vi.fn();

vi.mock('../../operations', () => ({
  defineLimsSchema: (...args: unknown[]) => defineSchema(...args),
  refineLimsSchema: (...args: unknown[]) => refineSchema(...args),
}));

const plasmid: LimsSchemaDefinitionView = {
  schemaId: 'schema-entity-plasmid',
  currentRevisionId: 'schema-entity-plasmid-v2',
  entityKind: 'plasmid',
  baseKind: 'sequence',
  displayName: 'Plasmid',
  description: null,
  version: 2,
  builtin: true,
  fields: [{ key: 'markers', label: 'Markers', type: 'string_array' }],
};

beforeEach(() => {
  defineSchema.mockReset();
  refineSchema.mockReset();
});

describe('RegistrySchemaManager', () => {
  it('opts a calendar day into the project schedule only with an explicit named zone', async () => {
    const dated = {
      ...plasmid,
      fields: [{ key: 'expiry', label: 'Expiry', type: 'date' as const }],
    };
    const onRevise = vi.fn().mockResolvedValue(undefined);
    render(<RegistrySchemaManager schemas={[dated]} onChanged={vi.fn()} onRefine={onRevise} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.change(screen.getByLabelText('Expiry project schedule role'), {
      target: { value: 'deadline' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onRevise).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/time zone/);
    fireEvent.change(screen.getByLabelText('Expiry project schedule time zone'), {
      target: { value: 'Europe/Paris' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1));
    expect(onRevise.mock.calls[0][0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'expiry',
          agenda: { role: 'deadline', zone: 'Europe/Paris' },
        }),
      ])
    );
  });
  it('uses one library for same-name schemas and saves to the selected organization authority', async () => {
    const organizationSchema = {
      ...plasmid,
      schemaId: 'organization-plasmid',
      currentRevisionId: 'organization-plasmid-v7',
      version: 7,
      builtin: false,
    };
    const refineOrganization = vi.fn().mockResolvedValue(undefined);
    const refreshOrganization = vi.fn().mockResolvedValue(undefined);
    render(
      <RegistrySchemaManager
        schemas={[plasmid]}
        onChanged={vi.fn()}
        sources={[
          {
            id: 'lab',
            label: 'Example lab',
            schemas: [organizationSchema],
            onDefine: vi.fn(),
            onRefine: refineOrganization,
            onChanged: refreshOrganization,
          },
        ]}
      />
    );
    expect(screen.getAllByRole('region', { name: 'Registry schemas' })).toHaveLength(1);
    fireEvent.click(screen.getByTestId('registry-schema-lab-plasmid'));
    expect(screen.getByTestId('registry-schema-lab-plasmid')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByTestId('registry-schema-plasmid')).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.change(screen.getByLabelText('Field 1 label'), {
      target: { value: 'Organization markers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(refineOrganization).toHaveBeenCalledWith({
        schemaId: organizationSchema.schemaId,
        expectedRevisionId: organizationSchema.currentRevisionId,
        description: null,
        fields: [{ ...plasmid.fields[0], label: 'Organization markers' }],
      })
    );
    expect(refreshOrganization).toHaveBeenCalledOnce();
    expect(refineSchema).not.toHaveBeenCalled();
  });

  it('keeps the revision from edit entry when the library refreshes during a draft', async () => {
    const { rerender } = render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.change(screen.getByLabelText('Field 1 label'), {
      target: { value: 'My pending markers' },
    });
    rerender(
      <RegistrySchemaManager
        schemas={[{ ...plasmid, version: 3, currentRevisionId: 'plasmid-v3' }]}
        onChanged={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed');
    expect(refineSchema).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Field 1 label')).toHaveValue('My pending markers');
  });

  it('edits the existing schema table in place and keeps its title, origin and selection', () => {
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} />);
    const table = screen.getByTestId('schema-own-fields');
    const inherited = screen.getByTestId('schema-inherited-fields');
    const heading = screen.getByRole('heading', { name: 'Plasmid', exact: true });
    fireEvent.click(screen.getByRole('button', { name: /^(Edit|Revise) schema$/ }));
    expect(screen.getByTestId('schema-own-fields')).toBe(table);
    expect(screen.getByTestId('schema-inherited-fields')).toBe(inherited);
    expect(screen.getByRole('heading', { name: 'Plasmid', exact: true })).toBe(heading);
    expect(screen.getByTestId('registry-schema-plasmid')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Revise schema' })).not.toBeInTheDocument();
    expect(within(table).getByLabelText('Field 1 label')).toHaveValue('Markers');
    expect(within(table).getByLabelText('Field 1 key')).toHaveValue('markers');
    expect(within(table).getByRole('combobox', { name: 'Field 1 type' })).toBeEnabled();
    fireEvent.change(within(table).getByLabelText('Field 1 label'), {
      target: { value: 'Selection markers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(screen.getByTestId('schema-own-fields')).toBe(table);
    expect(within(table).getByText('Markers', { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit schema', exact: true })).toBeEnabled();
    expect(refineSchema).not.toHaveBeenCalled();
  });

  it('keeps failed edits in the same table for correction without changing the selected revision', async () => {
    refineSchema.mockRejectedValue(
      withUserMessage(
        new Error('Schema changed elsewhere. Reopen it before saving.'),
        'validation.compatible.41'
      )
    );
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} />);
    const table = screen.getByTestId('schema-own-fields');
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.change(within(table).getByLabelText('Field 1 label'), {
      target: { value: 'Selection markers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Schema changed elsewhere');
    expect(screen.getByTestId('schema-own-fields')).toBe(table);
    expect(within(table).getByLabelText('Field 1 label')).toHaveValue('Selection markers');
    expect(screen.getByTestId('registry-schema-plasmid')).toHaveTextContent('v2');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(refineSchema).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaId: plasmid.schemaId,
        expectedRevisionId: plasmid.currentRevisionId,
      })
    );
  });

  it('keeps schema editing unavailable for a read-only organization viewer', () => {
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} readOnly />);
    expect(screen.getByRole('button', { name: 'Edit schema' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New schema' })).toBeDisabled();
  });

  it('searches schema names and keys and narrows the library by Default or Custom origin', async () => {
    const custom = {
      ...plasmid,
      schemaId: 'custom',
      currentRevisionId: 'custom-v1',
      entityKind: 'lab_plasmid',
      displayName: 'Long experimental plasmid schema',
      builtin: false,
      version: 1,
    };
    render(<RegistrySchemaManager schemas={[plasmid, custom]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search schemas' }), {
      target: { value: 'LAB_PLASMID' },
    });
    expect(screen.getByTestId('registry-schema-lab_plasmid')).toBeVisible();
    expect(screen.queryByTestId('registry-schema-plasmid')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search schemas' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Schema origin' }));
    fireEvent.click(screen.getByRole('option', { name: 'Custom schemas' }));
    expect(screen.queryByTestId('registry-schema-plasmid')).not.toBeInTheDocument();
    expect(screen.getByTestId('registry-schema-lab_plasmid')).toHaveTextContent(
      'Long experimental plasmid schema'
    );
    fireEvent.click(screen.getByTestId('registry-schema-lab_plasmid'));
    expect(screen.getByRole('heading', { name: 'Long experimental plasmid schema' })).toBeVisible();
    expect(defineSchema).not.toHaveBeenCalled();
    expect(refineSchema).not.toHaveBeenCalled();
  });

  it('presents schema management inline with Default and Custom origins independent of revision number', () => {
    const custom = {
      ...plasmid,
      schemaId: 'custom',
      currentRevisionId: 'custom-v1',
      entityKind: 'custom_plasmid',
      displayName: 'Lab plasmid',
      builtin: false,
      version: 1,
    };
    const { rerender } = render(
      <RegistrySchemaManager schemas={[plasmid, custom]} onChanged={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.queryByRole('dialog', { name: 'Registry schemas' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Registry schemas' })).toBeVisible();
    expect(screen.getByTestId('registry-schema-plasmid')).toHaveTextContent('Default');
    expect(screen.getByTestId('registry-schema-custom_plasmid')).toHaveTextContent('Custom');
    rerender(
      <RegistrySchemaManager
        schemas={[{ ...plasmid, version: 3, currentRevisionId: 'plasmid-v3' }, custom]}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId('registry-schema-plasmid')).toHaveTextContent('Default');
    expect(screen.getByTestId('registry-schema-plasmid')).not.toHaveTextContent('Custom');
  });

  it('separates inherited sequence fields from the selected schema’s fields', () => {
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Plasmid' })).toBeInTheDocument();
    expect(screen.getByTestId('registry-schema-plasmid')).toHaveTextContent('plasmid · v2');
    expect(screen.getByTestId('schema-inherited-fields')).not.toHaveTextContent('Size');
    expect(screen.getByTestId('schema-inherited-fields')).toHaveTextContent('Topology');
    expect(screen.getByTestId('schema-inherited-fields')).toHaveTextContent('Genetic code');
    expect(screen.getByTestId('schema-own-fields')).toHaveTextContent('Markers');
    expect(screen.getByText('Text list')).toBeInTheDocument();
  });

  it('keeps sequence property keys unavailable as editable schema fields', async () => {
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.change(screen.getByLabelText('Field 2 label'), {
      target: { value: 'Stored length' },
    });
    fireEvent.change(screen.getByLabelText('Field 2 key'), { target: { value: 'size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sequence property keys cannot be schema fields'
    );
    expect(refineSchema).not.toHaveBeenCalled();
  });

  it('does not redisplay a legacy sequence property as an editable own field', () => {
    render(
      <RegistrySchemaManager
        schemas={[
          {
            ...plasmid,
            fields: [
              {
                key: 'size',
                label: 'Size',
                type: 'number',
                intrinsic: 'sequence.length',
                readOnly: true,
              },
              ...plasmid.fields,
            ],
          },
        ]}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId('schema-own-fields')).not.toHaveTextContent('Size');
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    expect(screen.queryByDisplayValue('size')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Field 1 label')).toHaveValue('Markers');
  });

  it('sends an Entity link definition without undefined properties to strict organization transports', async () => {
    defineSchema.mockResolvedValue({ id: 'linked' });
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New schema' }));
    fireEvent.change(screen.getByLabelText('Schema name'), { target: { value: 'Linked record' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.change(screen.getByLabelText('Field 1 label'), {
      target: { value: 'Parent entity' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Field 1 type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Entity link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create schema' }));
    await waitFor(() => expect(defineSchema).toHaveBeenCalledOnce());
    const definition = defineSchema.mock.calls[0][0].fields[0];
    expect(definition).toEqual({
      key: 'parentEntity',
      label: 'Parent entity',
      type: 'record_relationship',
      required: false,
    });
    expect(definition).not.toHaveProperty('enumOptions');
    expect(Object.values(definition)).not.toContain(undefined);
  });

  it('creates a sequence-backed schema with the inherited fields and no own fields', async () => {
    defineSchema.mockResolvedValue({ id: 'new-schema' });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={onChanged} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New schema' }));
    fireEvent.change(screen.getByLabelText('Schema name'), {
      target: { value: 'Custom sequence' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'DNA sequence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create schema' }));
    await waitFor(() => expect(defineSchema).toHaveBeenCalledTimes(1));
    expect(defineSchema).toHaveBeenCalledWith({
      kind: 'entity',
      name: 'custom_sequence',
      displayName: 'Custom sequence',
      baseKind: 'sequence',
      description: null,
      fields: [],
      existingPolicy: 'reject',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('revises the exact selected version and retains existing field keys', async () => {
    refineSchema.mockResolvedValue({ id: plasmid.schemaId });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={onChanged} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.change(screen.getByLabelText('Field 2 label'), { target: { value: 'Source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(refineSchema).toHaveBeenCalledTimes(1));
    expect(refineSchema).toHaveBeenCalledWith({
      schemaId: plasmid.schemaId,
      expectedRevisionId: plasmid.currentRevisionId,
      description: null,
      fields: [
        plasmid.fields[0],
        { key: 'source', label: 'Source', type: 'text', required: false },
      ],
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('does not send invalid or duplicate field keys to the backend', async () => {
    render(<RegistrySchemaManager schemas={[plasmid]} onChanged={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit schema' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.change(screen.getByLabelText('Field 2 label'), {
      target: { value: 'Another marker' },
    });
    fireEvent.change(screen.getByLabelText('Field 2 key'), { target: { value: 'markers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Field keys must be unique');
    expect(refineSchema).not.toHaveBeenCalled();
  });
});
