import { userMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntitySchemaFieldSnapshot } from '../../../../shared/entity-schema';
import { RegistryInlineFieldEditor } from './RegistryInlineFieldEditor';

const targets = vi.hoisted(() => ({ query: vi.fn(), open: vi.fn() }));
vi.mock('../../operations', () => ({ queryLimsRegistrySummaries: targets.query }));
vi.mock('../../open-entity', () => ({
  openLimsEntity: targets.open,
  isLimsEntityOpened: (result: { status: string }) => result.status === 'opened_record',
}));

const description: EntitySchemaFieldSnapshot = {
  key: 'description',
  label: 'Description',
  type: 'long_text',
};

describe('Registry inline edit lifecycle', () => {
  it('isolates a pending link edit from a newly selected record', async () => {
    targets.query.mockResolvedValue({
      summaries: [{ id: 'target-a', name: 'Old pending target', kind: 'strain', archived: false }],
      totalCount: 1,
    });
    let finish!: () => void;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const field = { key: 'parent', label: 'Parent entity', type: 'record_relationship' };
    const view = render(
      <RegistryInlineFieldEditor
        field={field}
        value={null}
        sourceEntityId="source-a"
        onCommit={onCommit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose Parent entity' }));
    fireEvent.click(await screen.findByRole('button', { name: /Old pending target/ }));
    view.rerender(
      <RegistryInlineFieldEditor
        field={field}
        value={{
          origin: 'native',
          destinationEntityId: 'target-b',
          relationType: 'references',
          label: 'New record target',
          resolution: 'exact',
        }}
        sourceEntityId="source-b"
        onCommit={onCommit}
      />
    );
    expect(screen.getByTestId('entity-reference-chip-label')).toHaveTextContent(
      'New record target'
    );
    await act(async () => finish());
    expect(screen.getByTestId('entity-reference-chip-label')).toHaveTextContent(
      'New record target'
    );
    expect(screen.queryByText('Old pending target')).not.toBeInTheDocument();
  });

  it('chooses a real entity link, excludes itself, and clears without entering raw IDs', async () => {
    targets.query.mockResolvedValue({
      summaries: [
        {
          id: 'source-record',
          name: 'This record',
          kind: 'strain',
          registryId: 's001',
          archived: false,
        },
        {
          id: 'parent-record',
          name: 'Parent strain',
          kind: 'strain',
          registryId: 's002',
          archived: false,
        },
      ],
      totalCount: 2,
    });
    const field = { key: 'parent', label: 'Parent entity', type: 'record_relationship' };
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <RegistryInlineFieldEditor
        field={field}
        value={null}
        sourceEntityId="source-record"
        onCommit={onCommit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose Parent entity' }));
    expect(await screen.findByRole('button', { name: /Parent strain/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /This record/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Parent strain/ }));
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith({
        origin: 'native',
        destinationEntityId: 'parent-record',
        relationType: 'references',
        label: 'Parent strain',
        resolution: 'exact',
      })
    );
    view.rerender(
      <RegistryInlineFieldEditor
        field={field}
        value={onCommit.mock.calls[0][0]}
        sourceEntityId="source-record"
        onCommit={onCommit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear Parent entity' }));
    await waitFor(() => expect(onCommit).toHaveBeenLastCalledWith(null));
  });

  it('retains a failed entity selection for retry and shows a target-query error', async () => {
    targets.query.mockRejectedValueOnce(new Error('Registry is unavailable')).mockResolvedValue({
      summaries: [{ id: 'target', name: 'Retained target', kind: 'strain', archived: false }],
      totalCount: 1,
    });
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Save is unavailable'))
      .mockResolvedValue(undefined);
    render(
      <RegistryInlineFieldEditor
        field={{ key: 'parent', label: 'Parent entity', type: 'record_relationship' }}
        value={null}
        sourceEntityId="source-record"
        onCommit={onCommit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose Parent entity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.entity-search-could-not-load')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    fireEvent.click(await screen.findByRole('button', { name: /Retained target/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.the-entity-link-could-not-be-saved')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry Parent entity' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit.mock.calls[1][0]).toEqual(onCommit.mock.calls[0][0]);
  });

  it.each([undefined, null, ''])(
    'leaves untouched empty text (%s) without a save',
    async (value) => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      render(<RegistryInlineFieldEditor field={description} value={value} onCommit={onCommit} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
      fireEvent.blur(screen.getByRole('textbox', { name: 'Description' }));
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  );

  it.each([
    { key: 'count', label: 'Count', type: 'number' },
    { key: 'tags', label: 'Tags', type: 'string_array' },
    { key: 'active', label: 'Active', type: 'boolean' },
  ] satisfies EntitySchemaFieldSnapshot[])(
    'does not materialize an absent $type value on blur',
    async (field) => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      render(<RegistryInlineFieldEditor field={field} value={undefined} onCommit={onCommit} />);
      fireEvent.click(screen.getByRole('button', { name: `Edit ${field.label}` }));
      fireEvent.blur(
        screen.getByRole(
          field.type === 'boolean'
            ? 'combobox'
            : field.type === 'number'
              ? 'spinbutton'
              : 'textbox',
          { name: field.label, exact: true }
        )
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: `Edit ${field.label}` })).toBeVisible()
      );
      expect(onCommit).not.toHaveBeenCalled();
    }
  );

  it('releases Description on blur while its changed value is still saving', async () => {
    let finish!: () => void;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    render(
      <>
        <RegistryInlineFieldEditor field={description} value={undefined} onCommit={onCommit} />
        <RegistryInlineFieldEditor
          field={{ key: 'name', label: 'Name', type: 'text' }}
          value="pDEMO421"
          onCommit={vi.fn()}
        />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const input = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(input, { target: { value: 'A real description' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name' }));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('A real description');
    await act(async () => finish());
  });

  it('keeps a failed draft available for retry outside edit mode', async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error('The project is temporarily busy.'))
      .mockResolvedValueOnce(undefined);
    render(
      <RegistryInlineFieldEditor field={description} value="Saved text" onCommit={onCommit} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const input = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(input, { target: { value: 'Keep my draft' } });
    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('metadata.saveFailed'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Description' })).toHaveTextContent(
      'Keep my draft'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry Description' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenNthCalledWith(2, 'Keep my draft');
  });

  it('Escape restores the saved value without saving', () => {
    const onCommit = vi.fn();
    render(
      <RegistryInlineFieldEditor field={description} value="Saved text" onCommit={onCommit} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const input = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(input, { target: { value: 'Canceled text' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Description' })).toHaveTextContent(
      'Saved text'
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit Description' })).toHaveFocus();
  });

  it('finishes an unchanged field when a non-focusable outside value is clicked', () => {
    const onCommit = vi.fn();
    render(
      <>
        <RegistryInlineFieldEditor field={description} value="Saved text" onCommit={onCommit} />
        <span>Registry identifier</span>
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.pointerDown(screen.getByText('Registry identifier'));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('leaves editing when a disabled outside control cannot receive a click', () => {
    const onCommit = vi.fn();
    render(
      <>
        <RegistryInlineFieldEditor field={description} value="Saved text" onCommit={onCommit} />
        <button disabled>Unavailable field</button>
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Unavailable field' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not submit an unfinished input-method composition when Enter is pressed', () => {
    const onCommit = vi.fn();
    render(
      <RegistryInlineFieldEditor
        field={{ key: 'label', label: 'Label', type: 'text' }}
        value="Original"
        onCommit={onCommit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Label' }));
    const input = screen.getByRole('textbox', { name: 'Label' });
    fireEvent.change(input, { target: { value: 'Composing' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(input).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('retains changed text if editing becomes unavailable before blur', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <RegistryInlineFieldEditor field={description} value="Saved text" onCommit={onCommit} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Draft to keep' },
    });
    view.rerender(<RegistryInlineFieldEditor field={description} value="Saved text" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('project becomes editable');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Draft to keep')).toBeVisible();
    expect(onCommit).not.toHaveBeenCalled();
    view.rerender(
      <RegistryInlineFieldEditor field={description} value="Saved text" onCommit={onCommit} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry Description' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('Draft to keep'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
