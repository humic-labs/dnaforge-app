import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandScopeProvider } from '../../../../commands/CommandScopeProvider';
import { getMountedCommandRegistry } from '../../../../commands/mounted-command-registry';
import { COMMAND_IDS } from '../../../../commands/types';
import { useCanvasStore } from '../../../canvas/public/store';
import { useWorkspaceViewerFindCommands } from '../useWorkspaceViewerFindCommands';

type SurfaceProps = Parameters<typeof useWorkspaceViewerFindCommands>[0];

function Surface(props: SurfaceProps) {
  const { sequenceScope, sequenceCommandIsActive } = useWorkspaceViewerFindCommands(props);
  return (
    <button {...sequenceScope.eventHandlers} data-testid={props.commandEntityId}>
      {String(sequenceCommandIsActive)}
    </button>
  );
}

function search() {
  return { isOpen: false, mode: 'nucleotide' as const, openInMode: vi.fn() };
}

function openTab(type: 'sequence' | 'design', entityId: string) {
  useCanvasStore.getState().openTab('main', {
    type,
    entityId,
    label: entityId,
    sequenceDocument: type === 'sequence' ? { kind: 'catalog-sequence', entityId } : undefined,
  });
}

beforeEach(() => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});

afterEach(cleanup);

it.each(['MacIntel', 'Win32'])('opens Find in the owning assembly via %s keyboard', (platform) => {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  openTab('design', 'assembly');
  const controller = search();
  render(
    <CommandScopeProvider>
      <Surface surface="assembly" commandEntityId="assembly" isGapped={false} search={controller} />
    </CommandScopeProvider>
  );
  expect(screen.getByTestId('assembly')).toHaveTextContent('false');
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        code: 'KeyF',
        metaKey: platform === 'MacIntel',
        ctrlKey: platform === 'Win32',
        bubbles: true,
      })
    );
  });
  expect(controller.openInMode).toHaveBeenCalledTimes(1);
  expect(controller.openInMode).toHaveBeenCalledWith('nucleotide');
});

it('routes amino-acid Find to the active assembly without enabling sequence editing', () => {
  openTab('design', 'assembly');
  const controller = search();
  render(
    <CommandScopeProvider>
      <Surface surface="assembly" commandEntityId="assembly" isGapped={false} search={controller} />
    </CommandScopeProvider>
  );
  let handled = false;
  act(() => {
    handled = getMountedCommandRegistry()!.dispatchCommand(
      COMMAND_IDS.sequenceFindAminoAcid
    ).handled;
  });
  expect(handled).toBe(true);
  expect(controller.openInMode).toHaveBeenCalledTimes(1);
  expect(controller.openInMode).toHaveBeenCalledWith('aminoAcid');
  expect(screen.getByTestId('assembly')).toHaveTextContent('false');
});

it('keeps an inactive assembly from intercepting the visible sequence', () => {
  openTab('design', 'assembly');
  openTab('sequence', 'sequence');
  const assembly = search();
  const sequence = search();
  render(
    <CommandScopeProvider>
      <Surface surface="sequence" commandEntityId="sequence" isGapped={false} search={sequence} />
      <Surface surface="assembly" commandEntityId="assembly" isGapped={false} search={assembly} />
    </CommandScopeProvider>
  );
  act(() => {
    getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.sequenceFind);
  });
  expect(sequence.openInMode).toHaveBeenCalledTimes(1);
  expect(sequence.openInMode).toHaveBeenCalledWith('nucleotide');
  expect(assembly.openInMode).not.toHaveBeenCalled();
  expect(screen.getByTestId('sequence')).toHaveTextContent('true');
  expect(screen.getByTestId('assembly')).toHaveTextContent('false');
});

it('opens nucleotide and amino acid Find on a gapped sequence', () => {
  openTab('sequence', 'aligned-reference');
  const controller = search();
  render(
    <CommandScopeProvider>
      <Surface
        surface="sequence"
        commandEntityId="aligned-reference"
        isGapped
        search={controller}
      />
    </CommandScopeProvider>
  );
  act(() => {
    getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.sequenceFind);
    getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.sequenceFindAminoAcid);
  });
  expect(controller.openInMode.mock.calls).toEqual([['nucleotide'], ['aminoAcid']]);
});

it('does not open Find on a gapped assembly', () => {
  openTab('design', 'assembly');
  const controller = search();
  render(
    <CommandScopeProvider>
      <Surface surface="assembly" commandEntityId="assembly" isGapped search={controller} />
    </CommandScopeProvider>
  );
  let handled = true;
  act(() => {
    handled = getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.sequenceFind).handled;
  });
  expect(handled).toBe(false);
  expect(controller.openInMode).not.toHaveBeenCalled();
});

it('retains the existing DNA-to-amino-acid toggle in the active sequence', () => {
  openTab('sequence', 'sequence');
  const controller = { ...search(), isOpen: true };
  render(
    <CommandScopeProvider>
      <Surface surface="sequence" commandEntityId="sequence" isGapped={false} search={controller} />
    </CommandScopeProvider>
  );
  act(() => {
    getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.sequenceFind);
  });
  expect(controller.openInMode).toHaveBeenCalledTimes(1);
  expect(controller.openInMode).toHaveBeenCalledWith('aminoAcid');
  expect(screen.getByTestId('sequence')).toHaveTextContent('true');
});
