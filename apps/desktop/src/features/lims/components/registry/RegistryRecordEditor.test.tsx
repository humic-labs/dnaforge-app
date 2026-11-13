/** @vitest-environment jsdom */
import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  LimsEntity,
  LimsUpdateEntityInput,
  LimsRecordRelationshipTargetPage,
} from '../../../../shared/lims';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../../../shared/entity-schema';
import { RegistryRecordEditor } from './RegistryRecordEditor';
import { getWorkspaceRootById } from '../../../../db/workspace-catalog';
vi.mock('../../../../db/workspace-catalog', () => ({
  getWorkspaceRootById: vi.fn(async () => null),
}));
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
} from '../../../../services/workspace-editor-mutation-state';
import { queryLimsRecordRelationshipTargets } from '../../operations';
vi.mock('../../operations', () => ({ queryLimsRecordRelationshipTargets: vi.fn() }));

const schema: ProjectableEntitySchemaRevisionSnapshot = {
  schemaId: 'reagent',
  schemaRevisionId: 'reagent-v1',
  version: 1,
  name: 'reagent',
  displayName: 'Reagent',
  baseKind: 'record',
  fields: [
    { key: 'amount', label: 'Amount', type: 'number', required: true },
    { key: 'verified', label: 'Verified', type: 'boolean' },
    { key: 'notes', label: 'Notes', type: 'long_text' },
    { key: 'tags', label: 'Tags', type: 'string_array' },
    { key: 'parent', label: 'Parent', type: 'record_relationship' },
  ],
};
const entity: LimsEntity = {
  id: 'record-a',
  name: 'Reagent A',
  kind: 'reagent',
  schemaId: 'reagent',
  schemaRevisionId: 'reagent-v1',
  registryId: 'r1',
  fields: {
    amount: 12,
    verified: true,
    notes: '',
    tags: ['one', 'two'],
    parent: {
      sourceTargetId: 'bfi_PARENT',
      destinationEntityId: null,
      relationType: 'parent',
      label: 'Parent reagent',
      resolution: 'source_broken',
    },
  },
  registrationStatus: 'unresolved',
  domainStatus: null,
  workspaceId: 1,
  eventSeq: 9,
  actor: null,
  tombstone: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe('native registry field editor', () => {
  it('keeps missing optional metadata clean after its inputs are edited and cleared', () => {
    const onSave = vi.fn(async () => {});
    render(
      <RegistryRecordEditor entity={{ ...entity, fields: {} }} schema={schema} onSave={onSave} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    const save = screen.getByRole('button', { name: 'Save changes' });
    for (const [label, value] of [
      ['Notes', 'Draft'],
      ['Amount', '42'],
      ['Verified', 'true'],
      ['Tags', 'one'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(save).toBeEnabled();
      fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
      expect(save).toBeDisabled();
    }
    fireEvent.submit(screen.getByRole('form'));
    expect(onSave).not.toHaveBeenCalled();
  });
  it('disables unchanged saves and becomes clean again when fields are reverted', async () => {
    const onSave = vi.fn(async () => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    fireEvent.submit(screen.getByRole('form'));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New name' } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  });

  it('captures accepted strain authority with the draft and retains it across refresh and an unchanged pending retry', async () => {
    const captured = {
      workspaceRoot: '/workspace/strain-project',
      workspaceId: 1,
      artifactPath: '/workspace/strain-project/stock.entity.json',
      revision: {
        kind: 'accepted-object' as const,
        resourceId: entity.id,
        resourceRevisionId: `rr_${'a'.repeat(64)}`,
        workspaceVersionId: `wv_${'b'.repeat(64)}`,
        contentSha256: 'c'.repeat(64),
        sequenceEditParentEventId: null,
      },
    };
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput, _authority?: unknown) => {});
    onSave.mockRejectedValueOnce(new Error('Save accepted; file delivery remains pending.'));
    const view = render(
      <RegistryRecordEditor
        entity={entity}
        schema={schema}
        onSave={onSave}
        scientificAuthority={captured}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    view.rerender(
      <RegistryRecordEditor
        entity={{ ...entity, name: 'Later projection', eventSeq: 12 }}
        schema={schema}
        onSave={onSave}
        scientificAuthority={{
          ...captured,
          revision: { ...captured.revision, resourceRevisionId: `rr_${'d'.repeat(64)}` },
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.the-record-could-not-be-saved-your-draft-is-still-here')
    );
    expect(screen.getByLabelText('Amount')).toHaveValue(42);
    expect(onSave.mock.calls[0][0]).toMatchObject({ expectedEventSeq: 9, name: entity.name });
    expect(onSave.mock.calls[0][1]).toEqual(captured);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(onSave.mock.calls[1]).toEqual(onSave.mock.calls[0]);
  });

  it('saves a record from its exact owner while a different workspace is frozen', async () => {
    vi.mocked(getWorkspaceRootById).mockResolvedValueOnce('/workspace/b');
    const onSave = vi.fn(async () => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    const mutation = { workspaceRoot: '/workspace/a', affectedEntityIds: ['another-record'] };
    const release = freezeWorkspaceEditorWrites(mutation);
    try {
      expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    } finally {
      release();
    }
  });
  const mutation = { workspaceRoot: '/managed/workspace', affectedEntityIds: [entity.id] };
  it('blocks a workspace mutation until the registry draft is saved or cancelled', () => {
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={async () => {}} />);
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/unsaved changes/);
    expect(screen.getByRole('form')).toHaveAttribute(
      'data-workspace-mutation-entity-id',
      entity.id
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
  });
  it('keeps an in-flight registry save registered after its editor unmounts', async () => {
    const pending = Promise.withResolvers<void>();
    const view = render(
      <RegistryRecordEditor entity={entity} schema={schema} onSave={() => pending.promise} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    view.unmount();
    expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/still saving/);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
  });
  it('refuses to start a registry write during a workspace mutation', async () => {
    const onSave = vi.fn(async () => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    const release = freezeWorkspaceEditorWrites(mutation);
    try {
      fireEvent.submit(screen.getByRole('form'));
      expect(onSave).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent('project update is in progress');
    } finally {
      release();
    }
  });
  it('prevents Enter in relationship search from implicitly submitting the record form', async () => {
    vi.mocked(queryLimsRecordRelationshipTargets).mockResolvedValue({
      targets: [],
      hasMore: false,
    });
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Parent' }));
    const search = screen.getByRole('textbox', { name: 'Search Parent targets' });
    expect(fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', cancelable: true })).toBe(
      false
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveValue(42);
  });

  it('selects an exact target and sends its ID without copying renderer-authored provenance', async () => {
    vi.mocked(queryLimsRecordRelationshipTargets).mockResolvedValue({
      targets: [
        { id: 'target-b', name: 'Same name', registryId: 'rea000002', kind: 'reagent' },
        { id: 'target-c', name: 'Same name', registryId: 'rea000003', kind: 'reagent' },
      ],
      hasMore: false,
    });
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change Parent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Same name rea000003' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].relationshipTargets).toEqual({ parent: 'target-c' });
    expect(onSave.mock.calls[0][0].fields).not.toHaveProperty('parent');
    expect(onSave.mock.calls[0][0].fields).toMatchObject({ amount: 12, verified: true });
  });

  it('clears a broken source relationship explicitly without erasing it before save', async () => {
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Parent' }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].relationshipTargets).toEqual({ parent: null });
    expect(onSave.mock.calls[0][0].fields).not.toHaveProperty('parent');
  });

  it('keeps the existing field when a lookup fails and allows a retry', async () => {
    vi.mocked(queryLimsRecordRelationshipTargets)
      .mockRejectedValueOnce(new Error('Catalog changed. Try again.'))
      .mockResolvedValue({ targets: [], hasMore: false });
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Parent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.could-not-load-records-try-again')
    );
    expect(screen.getByText('Parent reagent')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No matching records in this project.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('relationshipTargets');
    expect(onSave.mock.calls[0][0].fields?.parent).toEqual(entity.fields.parent);
  });

  it('ignores an older search response after a new query has returned', async () => {
    let resolveFirst: (page: LimsRecordRelationshipTargetPage) => void = () => {
      throw new Error('Lookup did not start.');
    };
    const first = new Promise<LimsRecordRelationshipTargetPage>((resolve) => {
      resolveFirst = resolve;
    });
    const query = vi.mocked(queryLimsRecordRelationshipTargets).mockReset();
    query.mockReturnValueOnce(first).mockResolvedValue({
      targets: [{ id: 'new', name: 'Newest record', registryId: 'rea9', kind: 'reagent' }],
      hasMore: false,
    });
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change Parent' }));
    await waitFor(() => expect(query).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Parent targets' }), {
      target: { value: 'Newest' },
    });
    expect(await screen.findByRole('button', { name: 'Newest record rea9' })).toBeVisible();
    await act(async () =>
      resolveFirst({
        targets: [{ id: 'old', name: 'Old response', registryId: 'rea1', kind: 'reagent' }],
        hasMore: false,
      })
    );
    expect(screen.queryByRole('button', { name: 'Old response rea1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newest record rea9' })).toBeVisible();
  });

  it('keeps imported provenance when the same exact target is selected again', async () => {
    const original = {
      ...entity,
      fields: {
        ...entity.fields,
        parent: {
          sourceTargetId: 'bfi_TARGET',
          destinationEntityId: 'target-b',
          relationType: 'parent',
          label: 'Target',
          resolution: 'exact',
        },
      },
    };
    vi.mocked(queryLimsRecordRelationshipTargets).mockResolvedValue({
      targets: [{ id: 'target-b', name: 'Target', registryId: 'rea2', kind: 'reagent' }],
      hasMore: false,
    });
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    render(<RegistryRecordEditor entity={original} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Parent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Target rea2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('relationshipTargets');
    expect(onSave.mock.calls[0][0].fields?.parent).toEqual(original.fields.parent);
  });

  it('saves explicit zero and false with the original version and preserves unedited fields', async () => {
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited reagent' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Verified'), { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      id: entity.id,
      name: 'Edited reagent',
      expectedEventSeq: 9,
      operationId: expect.any(String),
      fields: { ...entity.fields, amount: 0, verified: false },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit fields' })).toBeVisible());
  });

  it('cancels without saving or changing displayed data', () => {
    const onSave = vi.fn(async () => {});
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('12')).toBeVisible();
  });

  it('keeps drafts after failure and retries the identical operation', async () => {
    const onSave = vi
      .fn<(input: LimsUpdateEntityInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Disk is full'))
      .mockResolvedValueOnce();
    render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.the-record-could-not-be-saved-your-draft-is-still-here')
    );
    expect(screen.getByLabelText('Amount')).toHaveValue(42);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toEqual(onSave.mock.calls[0][0]);
  });

  it('does not silently adopt a newer version while a draft is open', async () => {
    const onSave = vi.fn(async (_input: LimsUpdateEntityInput) => {});
    const view = render(<RegistryRecordEditor entity={entity} schema={schema} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit fields' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '42' } });
    view.rerender(
      <RegistryRecordEditor entity={{ ...entity, eventSeq: 10 }} schema={schema} onSave={onSave} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].expectedEventSeq).toBe(9);
  });
});
