import { withUserMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMocloKitDefinition } from '../../design/public/moclo-kit-definition';
import { MocloKitBuilderDialog } from './MocloKitBuilderDialog';

const mocks = vi.hoisted(() => ({
  saveMocloKit: vi.fn(),
  templates: vi.fn(),
  searchCatalog: vi.fn(),
}));

vi.mock('../../../db/catalog-reference-search', () => ({
  searchCatalogReferencesByName: mocks.searchCatalog,
}));

vi.mock('../../design/public/moclo-schema-catalog', () => ({
  saveMocloKit: mocks.saveMocloKit,
}));

vi.mock('../../design/public/moclo-kit-templates', () => ({
  loadMocloKitTemplates: mocks.templates,
}));

const templateKit = parseMocloKitDefinition(
  JSON.stringify({
    schema: 'dnaforge.moclo-kit',
    formatVersion: 3,
    id: 'cidar',
    name: 'CIDAR MoClo',
    revision: 1,
    description: 'CIDAR architecture.',
    citations: [{ label: 'Iverson 2016' }],
    partTypes: [],
    members: [],
    recipes: [],
    assemblySchemas: [
      {
        id: 'transcription-unit',
        name: 'Transcription unit',
        description: 'Four parts and a backbone.',
        enzyme: 'BsaI',
        topology: 'circular',
        slots: [
          { id: 'promoter', label: 'Promoter', outgoingOverhang: 'TACT', preferredRoles: [] },
          { id: 'rbs', label: 'RBS', outgoingOverhang: 'AATG', preferredRoles: [] },
          { id: 'cds', label: 'CDS', outgoingOverhang: 'GCTT', preferredRoles: [] },
          {
            id: 'vector',
            label: 'Destination vector',
            outgoingOverhang: 'GGAG',
            preferredRoles: [],
          },
        ],
      },
    ],
  })
);

const existingKit = parseMocloKitDefinition(
  JSON.stringify({
    schema: 'dnaforge.moclo-kit',
    formatVersion: 3,
    id: 'lab-kit',
    name: 'Lab kit',
    revision: 2,
    description: 'Already in the project.',
    citations: [],
    partTypes: [],
    members: [{ id: 'pkg-insert', name: 'Insert part', sequencePackageId: 'pkg-insert' }],
    recipes: [],
    assemblySchemas: [
      {
        id: 'unit',
        name: 'Unit',
        description: 'Two parts.',
        enzyme: 'BsaI',
        topology: 'circular',
        slots: [
          { id: 'insert', label: 'Insert', outgoingOverhang: 'AATG', preferredRoles: [] },
          { id: 'backbone', label: 'Backbone', outgoingOverhang: 'GGAG', preferredRoles: [] },
        ],
      },
    ],
  })
);

function renderDialogWithUnmount(
  kit: Parameters<typeof MocloKitBuilderDialog>[0]['kit'] = null,
  existingKits: Parameters<typeof MocloKitBuilderDialog>[0]['existingKits'] = []
) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onEditExisting = vi.fn();
  const view = render(
    <MocloKitBuilderDialog
      projectRoot="/project"
      kit={kit}
      existingKits={existingKits}
      onSaved={onSaved}
      onClose={onClose}
      onEditExisting={onEditExisting}
    />
  );
  return { onSaved, onClose, onEditExisting, unmount: view.unmount };
}

function renderDialog(
  kit: Parameters<typeof MocloKitBuilderDialog>[0]['kit'] = null,
  existingKits: Parameters<typeof MocloKitBuilderDialog>[0]['existingKits'] = []
) {
  return renderDialogWithUnmount(kit, existingKits);
}

function fillStarterLayout() {
  const junctions = ['AATG', 'GCTT', 'GGAG'];
  junctions.forEach((overhang, index) => {
    fireEvent.change(screen.getByLabelText(`Position ${index + 1} junction`), {
      target: { value: overhang },
    });
  });
}

describe('MocloKitBuilderDialog', () => {
  beforeEach(() => {
    mocks.saveMocloKit.mockReset();
    mocks.saveMocloKit.mockResolvedValue({ kitId: 'my-kit', kitRevision: 1 });
    mocks.searchCatalog.mockResolvedValue([
      {
        name: 'pYTK002 ConLS',
        sequenceDocument: { kind: 'managed-sequence', packageId: 'pkg-conls', packageRoot: '/p' },
      },
      {
        name: 'A plain file, not a package',
        sequenceDocument: { kind: 'catalog-sequence' },
      },
    ]);
    mocks.templates.mockResolvedValue([
      {
        id: 'cidar',
        name: 'CIDAR MoClo',
        organism: 'E. coli',
        addgene: { kitId: '1000000059', url: 'https://www.addgene.org/kits/densmore-cidar-moclo/' },
        definition: templateKit,
      },
    ]);
  });

  afterEach(cleanup);

  it('disables unchanged kit metadata, including after reverting a field', () => {
    renderDialogWithUnmount(existingKit);
    const save = screen.getByTestId('moclo-kit-builder-save');
    expect(save).toBeDisabled();
    const name = screen.getByLabelText('Kit description');
    fireEvent.change(name, { target: { value: 'Changed description' } });
    expect(save).toBeEnabled();
    fireEvent.change(name, { target: { value: existingKit.description } });
    expect(save).toBeDisabled();
  });

  it('saves a hand-built kit through the shared writer', async () => {
    const { onSaved } = renderDialog();
    fireEvent.change(screen.getByLabelText('Kit name'), { target: { value: 'My kit' } });
    fireEvent.change(screen.getByLabelText('Kit description'), {
      target: { value: 'Built by hand.' },
    });
    fireEvent.change(screen.getByLabelText('Layout name'), { target: { value: 'Unit' } });
    fillStarterLayout();

    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));

    await waitFor(() => expect(mocks.saveMocloKit).toHaveBeenCalledTimes(1));
    expect(mocks.saveMocloKit).toHaveBeenCalledWith({
      projectRoot: '/project',
      kitId: 'my-kit',
      expectedKitRevision: 0,
      name: 'My kit',
      description: 'Built by hand.',
      assemblySchemas: [
        {
          id: expect.any(String),
          name: 'Unit',
          description: 'Unit',
          enzyme: 'BsaI',
          topology: 'circular',
          slots: [
            { id: 'position-1', label: 'Position 1', outgoingOverhang: 'AATG', preferredRoles: [] },
            { id: 'position-2', label: 'Position 2', outgoingOverhang: 'GCTT', preferredRoles: [] },
            { id: 'position-3', label: 'Position 3', outgoingOverhang: 'GGAG', preferredRoles: [] },
          ],
        },
      ],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('my-kit', 'My kit'));
  });

  it('refuses to save an incomplete kit and says what is missing', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));
    expect(mocks.saveMocloKit).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The kit needs a name.');
    expect(alert).toHaveTextContent('has no junction yet');
  });

  it('selects a generated default so typing replaces it', () => {
    renderDialog();
    const layoutName = screen.getByLabelText('Layout name') as HTMLInputElement;
    const select = vi.spyOn(layoutName, 'select');
    fireEvent.focus(layoutName);
    expect(select).toHaveBeenCalled();

    fireEvent.change(layoutName, { target: { value: 'Pilot unit' } });
    select.mockClear();
    fireEvent.focus(layoutName);
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps only concrete bases in a junction field', () => {
    renderDialog();
    const junction = screen.getByLabelText('Position 1 junction');
    fireEvent.change(junction, { target: { value: 'aaxtg!' } });
    expect(junction).toHaveValue('AATG');
  });

  it('fills the form from a published kit template', async () => {
    renderDialog();
    const picker = await screen.findByRole('combobox', { name: 'Kit template' });
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'cidar' } });
    fireEvent.click(await screen.findByRole('option', { name: /^CIDAR MoClo/ }));

    expect(screen.getByLabelText('Kit name')).toHaveValue('CIDAR MoClo');
    expect(screen.getByLabelText('Layout name')).toHaveValue('Transcription unit');
    expect(screen.getByLabelText('Position 1 junction')).toHaveValue('TACT');
    expect(screen.getByLabelText('Position 4 name')).toHaveValue('Destination vector');
    expect(screen.getByText(/Source: Iverson 2016/)).toBeTruthy();
  });

  it('keeps the template citation on the saved kit', async () => {
    renderDialog();
    const picker = await screen.findByRole('combobox', { name: 'Kit template' });
    fireEvent.focus(picker);
    fireEvent.click(await screen.findByRole('option', { name: /^CIDAR MoClo/ }));
    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));

    await waitFor(() => expect(mocks.saveMocloKit).toHaveBeenCalledTimes(1));
    expect(mocks.saveMocloKit.mock.calls[0][0].citations).toEqual([{ label: 'Iverson 2016' }]);
  });

  it('warns that editing an existing kit is experimental, and does not warn for a new one', () => {
    const { unmount } = renderDialogWithUnmount(existingKit);
    const notice = screen.getByTestId('moclo-kit-builder-experimental-notice');
    expect(notice).toHaveTextContent('Experimental');
    expect(notice).toHaveTextContent('changes layouts only');
    unmount();

    renderDialog();
    expect(screen.queryByTestId('moclo-kit-builder-experimental-notice')).toBeNull();
  });

  it('edits an existing kit at its current revision and removes deleted layouts', async () => {
    renderDialog(existingKit);
    expect(screen.getByLabelText('Kit name')).toHaveValue('Lab kit');
    expect(screen.getByLabelText('Kit name')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add position' }));
    fireEvent.change(screen.getByLabelText('Position 2 junction'), { target: { value: 'TTCG' } });
    fireEvent.change(screen.getByLabelText('Position 3 junction'), { target: { value: 'GGAG' } });
    fireEvent.change(screen.getByLabelText('Position 3 name'), { target: { value: 'Backbone' } });
    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));

    await waitFor(() => expect(mocks.saveMocloKit).toHaveBeenCalledTimes(1));
    const payload = mocks.saveMocloKit.mock.calls[0][0];

    expect(payload.citations).toBeUndefined();
    expect(payload.kitId).toBe('lab-kit');
    expect(payload.expectedKitRevision).toBe(2);
    expect(payload.assemblySchemas[0].slots).toHaveLength(3);
    expect(payload.removeSchemaIds).toBeUndefined();
  });

  it('adds a project sequence as a kit part and saves it', async () => {
    const { onSaved } = renderDialog();
    fireEvent.change(screen.getByLabelText('Kit name'), { target: { value: 'My kit' } });
    fireEvent.change(screen.getByLabelText('Kit description'), { target: { value: 'Desc.' } });
    fillStarterLayout();

    const option = await screen.findByRole('option', { name: /pYTK002 ConLS/ });
    expect(screen.queryByRole('option', { name: /plain file/ })).toBeNull();
    fireEvent.click(option);
    expect(screen.getByTestId('moclo-kit-members')).toHaveTextContent('1 in this kit');

    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));
    await waitFor(() => expect(mocks.saveMocloKit).toHaveBeenCalledTimes(1));
    expect(mocks.saveMocloKit.mock.calls[0][0].members).toEqual([
      { sequencePackageId: 'pkg-conls' },
    ]);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('says plainly when a kit has no parts', async () => {
    renderDialog();
    expect(screen.getByTestId('moclo-kit-members')).toHaveTextContent(
      'a kit with no parts fills no positions'
    );
  });

  it('removes a declared part', async () => {
    renderDialog(existingKit);
    const members = screen.getByTestId('moclo-kit-members');
    expect(members).toHaveTextContent('1 in this kit');
    fireEvent.click(screen.getByRole('button', { name: /Remove Insert part from this kit/ }));
    await waitFor(() => expect(members).toHaveTextContent('None yet'));

    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));
    await waitFor(() => expect(mocks.saveMocloKit).toHaveBeenCalledTimes(1));
    expect(mocks.saveMocloKit.mock.calls[0][0].removeMemberPackageIds).toEqual(['pkg-insert']);
  });

  it('warns before creating a second copy of a kit the project already has', () => {
    const { onEditExisting } = renderDialog(null, [existingKit]);
    expect(screen.queryByTestId('moclo-kit-duplicate-warning')).toBeNull();

    fireEvent.change(screen.getByLabelText('Kit name'), { target: { value: 'MoClo Lab kit' } });
    const warning = screen.getByTestId('moclo-kit-duplicate-warning');
    expect(warning).toHaveTextContent('already has “Lab kit”');

    fireEvent.click(screen.getByTestId('moclo-kit-duplicate-edit'));
    expect(onEditExisting).toHaveBeenCalledWith('lab-kit');
  });

  it('does not call an edited kit a duplicate of itself', () => {
    renderDialog(existingKit, [existingKit]);
    expect(screen.queryByTestId('moclo-kit-duplicate-warning')).toBeNull();
  });

  it('surfaces a revision conflict from the writer instead of silently losing the edit', async () => {
    mocks.saveMocloKit.mockRejectedValue(
      withUserMessage(
        new Error('The kit changed. Read the current kit revision before saving.'),
        'validation.compatible.25'
      )
    );
    const { onSaved } = renderDialog();
    fireEvent.change(screen.getByLabelText('Kit name'), { target: { value: 'My kit' } });
    fireEvent.change(screen.getByLabelText('Kit description'), { target: { value: 'Desc.' } });
    fillStarterLayout();
    fireEvent.click(screen.getByTestId('moclo-kit-builder-save'));

    expect(await screen.findByText(/The kit changed\./)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('adds and removes layouts', async () => {
    renderDialog(existingKit);
    fireEvent.click(screen.getByRole('button', { name: 'Add layout' }));
    expect(screen.getByRole('tab', { name: 'New layout' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove layout' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'New layout' })).toBeNull());
  });
});
