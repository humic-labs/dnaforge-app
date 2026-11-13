import { userMessage } from '@waypoint/user-messages';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityDetailsPanel } from './EntityDetailsPanel';
import { EntityDetailsSession } from './session';
import type { EntityDetailsDefinition } from './types';

vi.mock('./OligoProperties', () => ({ OligoProperties: () => null }));
const linkSearch = vi.hoisted(() => vi.fn());
vi.mock('../lims/operations', () => ({ queryLimsRegistrySummaries: linkSearch }));
const sessions: EntityDetailsSession[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) {
    session.discard();
    session.dispose();
  }
});

async function setup(
  rename?: (name: string) => Promise<void>,
  configure?: (definition: EntityDetailsDefinition) => void
) {
  const definition: EntityDetailsDefinition = {
    record: {
      id: 'sample-1',
      name: 'Original',
      fields: { count: 3, notes: 'Saved' },
      schema: {
        schemaId: 's',
        schemaRevisionId: 'r',
        baseKind: 'record',
        name: 'sample',
        displayName: 'Sample',
        version: 1,
        fields: [
          { key: 'count', label: 'Count', type: 'number', required: true },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ],
      },
      properties: {},
      registryId: 'sample1',
      registrationStatus: 'registered',
      preview: null,
      refreshGeneticCodeRevision: false,
    },
    save: vi.fn(async (update) => {
      definition.record = { ...definition.record, ...update };
    }),
    rename,
  };
  configure?.(definition);
  const session = new EntityDetailsSession(
    { entityId: 'sample-1' },
    { load: async () => definition, history: async () => [], changed: vi.fn() }
  );
  sessions.push(session);
  await session.load();
  function Host() {
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [host, setHost] = useState('registry');
    return (
      <>
        <button onClick={() => setHost((value) => (value === 'registry' ? 'entity' : 'registry'))}>
          Switch host
        </button>
        <EntityDetailsPanel
          key={host}
          session={session}
          state={state}
          onClose={vi.fn()}
          related={<div>Version history</div>}
        />
      </>
    );
  }
  render(<Host />);
  return { session, definition };
}

describe('the common metadata panel in either host', () => {
  it('keeps the entity-link picker open when focus moves into its portaled search', async () => {
    linkSearch.mockResolvedValue({
      summaries: [{ id: 'parent-2', name: 'Other parent', kind: 'sample', archived: false }],
      totalCount: 1,
    });
    const { session } = await setup(undefined, (definition) => {
      definition.record.schema.fields.push({
        key: 'parent',
        label: 'Parent entity',
        type: 'record_relationship',
      });
    });
    const trigger = screen.getByRole('button', { name: 'Choose Parent entity', exact: true });
    trigger.focus();
    fireEvent.click(trigger);
    const search = await screen.findByRole('searchbox', {
      name: 'Search entities for Parent entity',
      exact: true,
    });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'Other' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Other parent sample', exact: true })
    );
    expect(session.getSnapshot().draft?.fields.parent).toEqual({
      origin: 'native',
      destinationEntityId: 'parent-2',
      relationType: 'references',
      label: 'Other parent',
      resolution: 'exact',
    });
    expect(screen.queryByRole('dialog', { name: 'Choose Parent entity' })).not.toBeInTheDocument();
  });

  it('filters shared choices and saves within the same complete panel', async () => {
    const { session } = await setup(undefined, (definition) => {
      definition.record.fields.state = 'Active';
      definition.record.schema.fields.push({
        key: 'state',
        label: 'State',
        type: 'enum',
        enumOptions: ['Active', 'Stored'],
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit State', exact: true }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search state', exact: true }), {
      target: { value: 'stor' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Stored', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Update entity', exact: true }));
    await waitFor(() => expect(session.getSnapshot().saving).toBe(false));
    expect(session.getSnapshot().definition?.record.fields.state).toBe('Stored');
    expect(screen.getByTestId('entity-details-panel')).toBeVisible();
    expect(screen.getByText('Version history')).toBeVisible();
  });

  it('retains a failed save across hosts and keeps the entity name distinct from a schema name field', async () => {
    const { session, definition } = await setup(undefined, (definition) => {
      definition.record.fields.name = 'Source';
      definition.record.schema.fields.push({ key: 'name', label: 'Source name', type: 'text' });
    });
    vi.mocked(definition.save!).mockRejectedValueOnce(new Error('Project is temporarily busy.'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name', exact: true }), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Source name', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Source name', exact: true }), {
      target: { value: 'Changed source' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update entity', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('operation.failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch host' }));
    expect(screen.getByRole('button', { name: 'Edit Source name', exact: true })).toHaveTextContent(
      'Changed source'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update entity', exact: true }));
    await waitFor(() => expect(session.getSnapshot().saving).toBe(false));
    expect(definition.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'Renamed',
        fields: expect.objectContaining({ name: 'Changed source' }),
      })
    );
    expect(session.dirty).toBe(false);
    expect(screen.getByTestId('entity-details-panel')).toBeVisible();
  });

  it('keeps an out-of-range draft invalid and Escape cancels only that field', async () => {
    const { session } = await setup(undefined, (definition) => {
      definition.record.schema.fields[0].maxValue = 10;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Notes', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes', exact: true }), {
      target: { value: 'Retained' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Count', exact: true }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Count', exact: true }), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name', exact: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('10');
    expect(screen.getByRole('button', { name: 'Update entity', exact: true })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name', exact: true }), {
      key: 'Escape',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Count', exact: true }));
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Count', exact: true }), {
      key: 'Escape',
    });
    expect(session.getSnapshot().draft?.fields).toEqual({ count: 3, notes: 'Retained' });
    expect(session.getSnapshot().invalid.size).toBe(0);
  });
  it('transfers the active field and cancels only the current field draft', async () => {
    const { session } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Notes', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes', exact: true }), {
      target: { value: 'Staged notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Count', exact: true }));
    expect(screen.queryByRole('textbox', { name: 'Notes', exact: true })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Count' }), { target: { value: '9' } });
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Count' }), { key: 'Escape' });
    expect(session.getSnapshot().draft?.fields).toEqual({ count: 3, notes: 'Staged notes' });
    expect(screen.getByRole('button', { name: 'Edit Count', exact: true })).toHaveFocus();
    expect(screen.getByText('Version history')).toBeVisible();
  });

  it('keeps invalid text and its recovery controls when the host unmounts', async () => {
    const { session } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Count', exact: true }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Count' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch host' }));
    expect(session.getSnapshot().invalid.has('count')).toBe(true);
    expect(screen.getByRole('button', { name: 'Discard Count', exact: true })).toBeVisible();
    expect(screen.getByTestId('sequence-metadata-save')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Count', exact: true }));
    expect(screen.getByRole('spinbutton', { name: 'Count' })).toHaveValue(null);
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Count' }), { key: 'Escape' });
    expect(session.getSnapshot().invalid.size).toBe(0);
    expect(session.getSnapshot().draft?.fields.count).toBe(3);
    expect(session.dirty).toBe(false);
  });

  it('retains a failed immediate name save across hosts and retries the same name', async () => {
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new Error('Project busy'))
      .mockResolvedValueOnce(undefined);
    const { session } = await setup(rename);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name', exact: true }), {
      target: { value: 'Renamed' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name', exact: true }), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Retry Name', exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Switch host' }));
    expect(screen.getByText('Renamed', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Name', exact: true }));
    await waitFor(() => expect(session.getSnapshot().definition?.record.name).toBe('Renamed'));
    expect(rename.mock.calls).toEqual([['Renamed'], ['Renamed']]);
    expect(session.dirty).toBe(false);
  });
  it('finishes the active field before saving and keeps the pending state visible', async () => {
    const { session, definition } = await setup();
    let release: () => void = () => {};
    vi.mocked(definition.save!).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name', exact: true }), {
      target: { value: 'Pending name' },
    });
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));
    expect(screen.queryByRole('textbox', { name: 'Name', exact: true })).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-metadata-save')).toHaveTextContent('Saving…');
    expect(screen.getByTestId('sequence-metadata-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));
    expect(definition.save).toHaveBeenCalledOnce();
    release();
    await waitFor(() => expect(session.getSnapshot().saving).toBe(false));
  });
});
