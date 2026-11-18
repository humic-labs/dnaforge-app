// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplorerAddPicker } from './ExplorerAddPicker';

afterEach(cleanup);
const base = {
  open: true,
  anchorPoint: { x: 20, y: 100 },
  hasWorkspace: true,
  onRequestClose: vi.fn(),
};
const labels = ['Import a project', 'Import with agent', 'Migrate from Benchling'];

it('keeps global actions out of folder destinations while retaining typed create and import intents', () => {
  const create = vi.fn(),
    imported = vi.fn(),
    project = vi.fn();
  const view = render(
    <ExplorerAddPicker
      {...base}
      launchSource="context-menu"
      destinationPath="/project/selected"
      destinationLabel="selected"
      onCreateEntity={create}
      onImportEntity={imported}
      onImportProject={project}
      onImportProjectWithAgent={project}
      onMigrateFromBenchling={project}
    />
  );
  const picker = screen.getByTestId('explorer-add-picker');
  for (const name of labels) expect(within(picker).queryByRole('menuitem', { name })).toBeNull();
  fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
  fireEvent.click(
    within(screen.getByRole('menu', { name: 'DNA sequences actions' })).getByRole('menuitem', {
      name: 'Create',
    })
  );
  expect(create).toHaveBeenCalledWith({
    entityType: 'dna-sequences',
    destinationPath: '/project/selected',
  });
  view.unmount();
  render(
    <ExplorerAddPicker
      {...base}
      launchSource="context-menu"
      destinationPath="/project/selected"
      onImportEntity={imported}
    />
  );
  const reopened = screen.getByTestId('explorer-add-picker');
  fireEvent.click(within(reopened).getByRole('menuitem', { name: 'DNA sequences' }));
  fireEvent.click(
    within(screen.getByRole('menu', { name: 'DNA sequences actions' })).getByRole('menuitem', {
      name: 'Import',
    })
  );
  expect(imported).toHaveBeenCalledWith({
    entityType: 'dna-sequences',
    destination: { kind: 'explicit', path: '/project/selected' },
  });
  expect(project).not.toHaveBeenCalled();
});

it('omits the global section when no global action is available', () => {
  render(<ExplorerAddPicker {...base} launchSource="registry" />);
  expect(screen.queryByText('Project-scale actions')).toBeNull();
  for (const name of labels) expect(screen.queryByRole('menuitem', { name })).toBeNull();
});

it.each(labels)(
  'preserves the available global %s callback and omits unavailable rows',
  (label) => {
    const action = vi.fn(),
      close = vi.fn(),
      committed = vi.fn();
    render(
      <ExplorerAddPicker
        {...base}
        launchSource="registry"
        onRequestClose={close}
        onCommitAction={committed}
        onImportProject={label === labels[0] ? action : undefined}
        onImportProjectWithAgent={label === labels[1] ? action : undefined}
        onMigrateFromBenchling={label === labels[2] ? action : undefined}
      />
    );
    for (const other of labels.filter((name) => name !== label))
      expect(screen.queryByRole('menuitem', { name: other })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(action).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledOnce();
  }
);
