import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TerminalFileSearch } from './TerminalFileSearch';
import { parseTerminalFileQuery, terminalFileQueryCandidates } from './terminal-open-file';

vi.mock('../../commands', () => ({
  COMMAND_SCOPES: { modal: 'modal' },
  useCommandScope: () => ({ release: vi.fn() }),
}));
vi.mock('../document-opening/public/open-document', () => ({ openDocument: vi.fn() }));
vi.mock('../canvas/public/store', () => ({ useCanvasStore: {} }));

it('tries literal filenames before upstream sentence and stack-trace alternatives', () => {
  expect(terminalFileQueryCandidates('notes.txt.')).toEqual([
    { query: 'notes.txt.' },
    { query: 'notes.txt' },
  ]);
  expect(terminalFileQueryCandidates('notes.txt:3:2.')).toEqual([
    { query: 'notes.txt:3:2.' },
    { query: 'notes.txt', line: 3, column: 2 },
  ]);
  expect(terminalFileQueryCandidates('source.rb:in')).toEqual([
    { query: 'source.rb:in' },
    { query: 'source.rb' },
  ]);
  expect(terminalFileQueryCandidates('report:final.txt')).toEqual([
    { query: 'report:final.txt' },
    { query: 'report' },
  ]);
  expect(terminalFileQueryCandidates('plain.txt')).toEqual([{ query: 'plain.txt' }]);
});

it('requires a choice for ambiguous or incomplete results and carries the typed query to native search', async () => {
  const onOpen = vi.fn();
  const onQueryChange = vi.fn();
  const props = {
    query: 'notes.txt:3:2',
    loading: false,
    autoOpen: true,
    hasProjects: true,
    result: {
      requestId: 'request',
      paths: ['/project/a/notes.txt', '/project/b/notes.txt'],
      incomplete: false,
      cancelled: false,
    },
    onOpen,
    onQueryChange,
    onClose: vi.fn(),
  };
  const view = render(<TerminalFileSearch {...props} />);
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'report[1].txt:2:3' } });
  expect(onQueryChange).toHaveBeenCalledWith('report[1].txt:2:3');
  expect(parseTerminalFileQuery('report[1].txt:2:3')).toEqual({
    query: 'report[1].txt',
    line: 2,
    column: 3,
  });
  view.rerender(
    <TerminalFileSearch
      {...props}
      result={{ ...props.result, paths: ['/project/a/notes.txt'], incomplete: true }}
    />
  );
  expect(onOpen).not.toHaveBeenCalled();
  view.rerender(
    <TerminalFileSearch {...props} result={{ ...props.result, paths: ['/project/a/notes.txt'] }} />
  );
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('/project/a/notes.txt'));
  view.rerender(
    <TerminalFileSearch {...props} result={{ ...props.result, paths: ['/project/a/notes.txt'] }} />
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('retains literal colon suffixes before applying context normalization', () => {
  expect(parseTerminalFileQuery('report:final.txt')).toEqual({ query: 'report:final.txt' });
});
