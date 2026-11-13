import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GitHistoryDrawer } from './GitHistoryDrawer';
import type { GitLogEntry } from '../../workspace/git';

function makeEntry(overrides: Partial<GitLogEntry> = {}): GitLogEntry {
  return {
    hash: 'abc123',
    message: 'Initial commit',
    date: '2026-03-20T12:00:00Z',
    relativeDate: '1 hour ago',
    ...overrides,
  };
}

const defaultProps = {
  log: [] as GitLogEntry[],
  isLoading: false,
  isGitRepo: true,
  selectedCommitHash: null,
  hasUncommittedChanges: false,
  onSelectCommit: vi.fn(),
  onCommit: vi.fn().mockResolvedValue(undefined),
  onRevert: vi.fn().mockResolvedValue(undefined),
};

function renderDrawer(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  if (!overrides.onSelectCommit) props.onSelectCommit = vi.fn();
  if (!overrides.onCommit) props.onCommit = vi.fn().mockResolvedValue(undefined);
  if (!overrides.onRevert) props.onRevert = vi.fn().mockResolvedValue(undefined);
  return { ...render(<GitHistoryDrawer {...props} />), props };
}

describe('GitHistoryDrawer', () => {
  describe('rendering', () => {
    it('shows "Git History" header', () => {
      renderDrawer();
      expect(screen.getByText('Git History')).toBeInTheDocument();
    });

    it('shows commit log entries with message and relative date', () => {
      const entries = [
        makeEntry({ hash: 'a1', message: 'Add feature X', relativeDate: '2 hours ago' }),
        makeEntry({ hash: 'b2', message: 'Fix bug Y', relativeDate: '3 days ago' }),
      ];
      renderDrawer({ log: entries });

      expect(screen.getByText('Add feature X')).toBeInTheDocument();
      expect(screen.getByText('2 hours ago')).toBeInTheDocument();
      expect(screen.getByText('Fix bug Y')).toBeInTheDocument();
      expect(screen.getByText('3 days ago')).toBeInTheDocument();
    });

    it('shows "Loading..." when isLoading=true', () => {
      renderDrawer({ isLoading: true });
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('shows "No commits yet" when log is empty and not loading', () => {
      renderDrawer({ log: [], isLoading: false });
      expect(screen.getByText('No commits yet')).toBeInTheDocument();
    });

    it('does not show "No commits yet" while loading', () => {
      renderDrawer({ log: [], isLoading: true });
      expect(screen.queryByText('No commits yet')).not.toBeInTheDocument();
    });

    it('shows "Diff" button on each commit entry', () => {
      const entries = [makeEntry({ hash: 'a1' }), makeEntry({ hash: 'b2' })];
      renderDrawer({ log: entries });
      const diffButtons = screen.getAllByText('Diff');
      expect(diffButtons).toHaveLength(2);
    });

    it('shows "Hide diff" when a commit is selected', () => {
      const entries = [makeEntry({ hash: 'a1' })];
      renderDrawer({ log: entries, selectedCommitHash: 'a1' });
      expect(screen.getByText('Hide diff')).toBeInTheDocument();
      expect(screen.queryByText('Diff')).not.toBeInTheDocument();
    });
  });

  describe('commit form', () => {
    it('commit input is enabled when hasUncommittedChanges=true', () => {
      renderDrawer({ hasUncommittedChanges: true });
      const input = screen.getByPlaceholderText('Describe your changes...');
      expect(input).not.toBeDisabled();
    });

    it('commit input is disabled when hasUncommittedChanges=false', () => {
      renderDrawer({ hasUncommittedChanges: false });
      const input = screen.getByPlaceholderText('Describe your changes...');
      expect(input).toBeDisabled();
    });

    it('commit button is disabled when message is empty', () => {
      renderDrawer({ hasUncommittedChanges: true });
      const button = screen.getByText('Commit this file');
      expect(button).toBeDisabled();
    });

    it('commit button is disabled when hasUncommittedChanges=false even with message', () => {
      renderDrawer({ hasUncommittedChanges: false });
      const input = screen.getByPlaceholderText('Describe your changes...');
      const button = screen.getByText('Commit this file');
      expect(button).toBeDisabled();
    });

    it('typing a message and clicking commit calls onCommit with trimmed message', async () => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      renderDrawer({ hasUncommittedChanges: true, onCommit });

      const input = screen.getByPlaceholderText('Describe your changes...');
      fireEvent.change(input, { target: { value: '  Add new feature  ' } });
      fireEvent.click(screen.getByText('Commit this file'));

      await waitFor(() => {
        expect(onCommit).toHaveBeenCalledWith('Add new feature');
      });
    });

    it('pressing Enter in the input triggers commit', async () => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      renderDrawer({ hasUncommittedChanges: true, onCommit });

      const input = screen.getByPlaceholderText('Describe your changes...');
      fireEvent.change(input, { target: { value: 'Fix typo' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(onCommit).toHaveBeenCalledWith('Fix typo');
      });
    });

    it('commit message clears after successful commit', async () => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      renderDrawer({ hasUncommittedChanges: true, onCommit });

      const input = screen.getByPlaceholderText('Describe your changes...');
      fireEvent.change(input, { target: { value: 'Add tests' } });
      fireEvent.click(screen.getByText('Commit this file'));

      await waitFor(() => {
        expect(input).toHaveValue('');
      });
    });

    it('commit button shows "Committing..." during operation', async () => {
      let resolveCommit!: () => void;
      const onCommit = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveCommit = resolve;
          })
      );
      renderDrawer({ hasUncommittedChanges: true, onCommit });

      const input = screen.getByPlaceholderText('Describe your changes...');
      fireEvent.change(input, { target: { value: 'Add tests' } });
      fireEvent.click(screen.getByText('Commit this file'));

      await waitFor(() => {
        expect(screen.getByText('Committing...')).toBeInTheDocument();
      });

      resolveCommit();
      await waitFor(() => {
        expect(screen.getByText('Commit this file')).toBeInTheDocument();
      });
    });
  });

  describe('revert', () => {
    it('revert button is enabled when hasUncommittedChanges=true and log has entries', () => {
      renderDrawer({ hasUncommittedChanges: true, log: [makeEntry()] });
      const button = screen.getByText('Discard changes');
      expect(button).not.toBeDisabled();
    });

    it('discard button is enabled even when log is empty (staged files can be reverted)', () => {
      renderDrawer({ hasUncommittedChanges: true, log: [] });
      const button = screen.getByText('Discard changes');
      expect(button).not.toBeDisabled();
    });

    it('revert button is disabled when hasUncommittedChanges=false', () => {
      renderDrawer({ hasUncommittedChanges: false });
      const button = screen.getByText('Discard changes');
      expect(button).toBeDisabled();
    });

    it('clicking revert calls onRevert', async () => {
      const onRevert = vi.fn().mockResolvedValue(undefined);
      renderDrawer({ hasUncommittedChanges: true, log: [makeEntry()], onRevert });

      fireEvent.click(screen.getByText('Discard changes'));

      await waitFor(() => {
        expect(onRevert).toHaveBeenCalledTimes(1);
      });
    });

    it('revert button shows "Reverting..." during operation', async () => {
      let resolveRevert!: () => void;
      const onRevert = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveRevert = resolve;
          })
      );
      renderDrawer({ hasUncommittedChanges: true, log: [makeEntry()], onRevert });

      fireEvent.click(screen.getByText('Discard changes'));

      await waitFor(() => {
        expect(screen.getByText('Reverting...')).toBeInTheDocument();
      });

      resolveRevert();
      await waitFor(() => {
        expect(screen.getByText('Discard changes')).toBeInTheDocument();
      });
    });
  });

  describe('diff toggle', () => {
    it('clicking "Diff" calls onSelectCommit with the commit hash', () => {
      const onSelectCommit = vi.fn();
      const entries = [makeEntry({ hash: 'deadbeef' })];
      renderDrawer({ log: entries, onSelectCommit });

      fireEvent.click(screen.getByText('Diff'));
      expect(onSelectCommit).toHaveBeenCalledWith('deadbeef');
    });

    it('clicking "Hide diff" on a selected commit calls onSelectCommit with the hash', () => {
      const onSelectCommit = vi.fn();
      const entries = [makeEntry({ hash: 'deadbeef' })];
      renderDrawer({ log: entries, selectedCommitHash: 'deadbeef', onSelectCommit });

      fireEvent.click(screen.getByText('Hide diff'));
      expect(onSelectCommit).toHaveBeenCalledWith('deadbeef');
    });
  });

  describe('edge cases', () => {
    it('does not call onCommit when message is only whitespace', () => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      renderDrawer({ hasUncommittedChanges: true, onCommit });

      const input = screen.getByPlaceholderText('Describe your changes...');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.click(screen.getByText('Commit this file'));

      expect(onCommit).not.toHaveBeenCalled();
    });
  });

  describe('not a git repo', () => {
    it('shows "not in a git repository" message when isGitRepo=false', () => {
      renderDrawer({ isGitRepo: false });
      expect(screen.getByText(/not in a git repository/i)).toBeInTheDocument();
    });

    it('shows git init instruction when isGitRepo=false', () => {
      renderDrawer({ isGitRepo: false });
      expect(screen.getByText('git init')).toBeInTheDocument();
    });

    it('does not show commit form when isGitRepo=false', () => {
      renderDrawer({ isGitRepo: false });
      expect(screen.queryByPlaceholderText('Describe your changes...')).not.toBeInTheDocument();
    });

    it('does not show history section when isGitRepo=false', () => {
      renderDrawer({ isGitRepo: false });
      expect(screen.queryByText('History')).not.toBeInTheDocument();
    });

    it('still shows header when isGitRepo=false', () => {
      renderDrawer({ isGitRepo: false });
      expect(screen.getByText('Git History')).toBeInTheDocument();
    });
  });
});
