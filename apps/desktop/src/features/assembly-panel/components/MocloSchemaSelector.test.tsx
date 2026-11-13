/** @vitest-environment jsdom */

import { userMessage } from '@waypoint/user-messages';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from '../../design/store';
import type { SequenceDesign } from '../../design/types';
import { MocloSchemaSelector } from './MocloSchemaSelector';
import { parseMocloKitDefinition } from '../../design/moclo-kit-definition';
import { ConfirmDialogHost } from '../../../components/ConfirmDialogHost';
import { useConfirmDialogStore } from '../../../components/confirm-dialog-store';

const mocks = vi.hoisted(() => ({ loadInventory: vi.fn() }));

vi.mock('../../design/moclo-schema-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../design/moclo-schema-catalog')>()),
  loadMocloSchemaCatalog: mocks.loadInventory,
}));

const definition = parseMocloKitDefinition(
  JSON.stringify({
    schema: 'dnaforge.moclo-kit' as const,
    formatVersion: 2 as const,
    id: 'starter-kit',
    name: 'Starter kit',
    revision: 3,
    description: 'A compact test kit.',
    citations: [],
    partTypes: [],
    members: [],
    recipes: [
      {
        id: 'expression-unit',
        name: 'Expression unit',
        description: 'Promoter, coding sequence, and terminator.',
        stages: [
          {
            id: 'level-1',
            name: 'Three-part expression unit',
            description: 'A minimal Golden Gate module.',
            enzyme: 'BsaI' as const,
            topology: 'circular' as const,
            outputRole: { label: 'expression unit' },
            slots: [
              {
                id: 'promoter',
                label: 'Promoter',
                outgoingOverhang: 'TACT',
                preferredRoles: [{ label: 'promoter' }],
                input: { kind: 'kit-part' as const },
              },
              {
                id: 'coding-sequence',
                label: 'Coding sequence',
                outgoingOverhang: 'GCTT',
                preferredRoles: [{ label: 'coding sequence' }],
                input: { kind: 'kit-part' as const },
              },
              {
                id: 'terminator',
                label: 'Terminator',
                outgoingOverhang: 'GGAG',
                preferredRoles: [{ label: 'terminator' }],
                input: { kind: 'kit-part' as const },
              },
            ],
          },
        ],
      },
    ],
  })
);

describe('MocloSchemaSelector', () => {
  function Harness() {
    const design = useDesignStore((state) => state.designs.design);
    return (
      <>
        <MocloSchemaSelector design={design} projectRoot="/project-b" />
        <ConfirmDialogHost />
      </>
    );
  }

  function kitPicker() {
    return screen.getByRole('combobox', { name: 'Assembly kit' });
  }

  async function openKitList() {
    fireEvent.focus(kitPicker());
    return screen.findByRole('listbox', { name: 'Assembly kit' });
  }

  async function findKitOption(name: string) {
    return screen.findByRole('option', { name: new RegExp(`^${name}`) });
  }

  async function chooseKit(name: string) {
    await openKitList();
    fireEvent.click(await findKitOption(name));
  }

  beforeEach(() => {
    mocks.loadInventory.mockResolvedValue({
      definitions: [
        definition,
        {
          ...definition,
          id: 'no-recipes',
          name: 'Kit without recipes',
          recipes: [],
          assemblySchemas: [],
        },
      ],
      issues: [],
    });
    useConfirmDialogStore.setState({ request: null });
    useDesignStore.setState({
      designs: { design: goldenGateDesign() },
      draftDesignIds: {},
      activeDesignId: 'design',
      pendingDispatchId: null,
    });
  });

  afterEach(cleanup);

  it('says how many parts a kit has, so an empty kit is obvious before it is chosen', async () => {
    render(<Harness />);
    await openKitList();
    expect(await findKitOption('Starter kit')).toHaveTextContent('no parts yet');
    expect(await findKitOption('Kit without recipes')).toHaveTextContent('0 layouts');
  });

  it('lists actual kits including those without recipes, with a separate schema choice', async () => {
    render(<Harness />);
    expect(kitPicker()).toHaveValue('None (free-form)');
    await openKitList();
    await findKitOption('Kit without recipes');
    expect(screen.queryByRole('combobox', { name: 'Assembly schema' })).toBeNull();
    expect(mocks.loadInventory).toHaveBeenCalledWith('/project-b');
    expect(useDesignStore.getState().designs.design.regions).toHaveLength(1);
  });

  it('cancel leaves the exact assembly and both selectors unchanged', async () => {
    render(<Harness />);
    const before = useDesignStore.getState().designs.design;
    await chooseKit('Starter kit');
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(screen.getByRole('alertdialog', { name: 'Switch to Starter kit?' })).toHaveAttribute(
      'aria-modal',
      'true'
    );
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(useDesignStore.getState().designs.design).toBe(before);
    expect(kitPicker()).toHaveValue('None (free-form)');
    expect(screen.queryByRole('combobox', { name: 'Assembly schema' })).toBeNull();
  });

  it('confirm clears the draft, then schema selection creates only empty slots', async () => {
    render(<Harness />);
    await chooseKit('Starter kit');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear and switch' }));
    await waitFor(() => expect(kitPicker()).toHaveValue('Starter kit'));
    expect(useDesignStore.getState().designs.design.regions).toEqual([]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assembly schema' }), {
      target: { value: 'starter-kit:expression-unit:level-1' },
    });
    await waitFor(() => {
      const current = useDesignStore.getState().designs.design;
      expect(current.goldenGateSchema?.id).toBe('starter-kit:expression-unit:level-1');
      expect(current.regions).toHaveLength(3);
      expect(current.regions.every((region) => region.isPlaceholder && !region.sequence)).toBe(
        true
      );
      expect(current.version).toBe(2);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not clear edits made while modal confirmation is pending', async () => {
    render(<Harness />);
    await chooseKit('Starter kit');
    await screen.findByRole('button', { name: 'Clear and switch' });
    act(() =>
      useDesignStore
        .getState()
        .updateDesign('design', { name: 'Edited while confirmation pending' })
    );
    const edited = useDesignStore.getState().designs.design;
    fireEvent.click(screen.getByRole('button', { name: 'Clear and switch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('assembly.failed'));
    expect(useDesignStore.getState().designs.design).toBe(edited);
  });

  it.each(['Escape', 'Enter'])(
    '%s dismisses the modal without clearing the assembly',
    async (key) => {
      render(<Harness />);
      const before = useDesignStore.getState().designs.design;
      await chooseKit('Starter kit');
      await screen.findByRole('alertdialog');
      fireEvent.keyDown(window, { key });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(useDesignStore.getState().designs.design).toBe(before);
    }
  );

  it('dismisses its pending confirmation when the selector unmounts', async () => {
    const view = render(<Harness />);
    const before = useDesignStore.getState().designs.design;
    await chooseKit('Starter kit');
    await screen.findByRole('alertdialog');
    view.unmount();
    await waitFor(() => expect(useConfirmDialogStore.getState().request).toBeNull());
    expect(useDesignStore.getState().designs.design).toBe(before);
  });

  it('changing schemas within a kit also requires confirmation for occupied parts', async () => {
    const existing = goldenGateDesign();
    existing.goldenGateSchema = {
      id: 'old-schema',
      name: 'Old schema',
      revision: 1,
      origin: { type: 'kit', kitId: 'starter-kit', kitName: 'Starter kit' },
      enzyme: 'BsaI',
      slots: [{ id: 'old', label: 'Old slot', outgoingOverhang: 'GGAG', preferredRoles: [] }],
    };
    useDesignStore.setState({ designs: { design: existing } });
    render(<Harness />);
    await screen.findByRole('option', { name: 'expression unit' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Assembly schema' }), {
      target: { value: 'starter-kit:expression-unit:level-1' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(useDesignStore.getState().designs.design).toBe(existing);
    expect(screen.getByRole('combobox', { name: 'Assembly schema' })).toHaveValue('old-schema');
  });
});

function goldenGateDesign(): SequenceDesign {
  const now = new Date('2026-09-07T00:00:00.000Z');
  return {
    id: 'design',
    name: 'Test assembly',
    topology: 'circular',
    regions: [
      {
        id: 'existing',
        sourceSequenceId: 'sequence-existing',
        sourceSequenceName: 'Existing part',
        sourceStart: 0,
        sourceEnd: 4,
        sequence: 'ATGC',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'goldengate',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}
