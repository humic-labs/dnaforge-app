import { documentLifecycle } from '../shared/document-lifecycle';
/** @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TextViewerTab } from './TextViewerTab';
import * as platformModule from '../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../utils/environment';

afterEach(() => {
  cleanup();
});

const mockWriteTextFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      readFile: vi.fn().mockResolvedValue(new Uint8Array()),
      readTextFile: vi.fn().mockResolvedValue(''),
      writeTextFileAtomic: mockWriteTextFile,
      readDir: vi.fn().mockResolvedValue([]),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 0, isFile: true, isDirectory: false, mtime: 0 }),
      exists: vi.fn().mockResolvedValue(false),
      rename: vi.fn().mockResolvedValue(undefined),
    },
  }),
  initPlatform: vi.fn().mockResolvedValue(undefined),
}));

const mockUpdateTabByEntityId = vi.fn();
vi.mock('../features/canvas/store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => {
      const state = {
        updateTabByEntityId: mockUpdateTabByEntityId,
        panels: {},
        focusedPanelId: null,
      };
      return selector(state);
    },
    { getState: () => ({ panels: {} }) }
  ),
}));

interface MockCodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language: string;
  darkMode: boolean;
  showLineNumbers: boolean;
  wordWrap: boolean;
}
function MockCodeEditor({
  value,
  onChange,
  language,
  darkMode,
  showLineNumbers,
  wordWrap,
}: MockCodeEditorProps) {
  return (
    <textarea
      data-testid="text-editor-textarea"
      data-language={language}
      data-dark={String(darkMode)}
      data-line-numbers={String(showLineNumbers)}
      data-word-wrap={String(wordWrap)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
vi.mock('./CodeEditor', () => ({
  __esModule: true,
  default: MockCodeEditor,
  CodeEditor: MockCodeEditor,
}));

vi.mock('../utils/fileTypes', () => ({
  getFilename: (path: string) => path.split('/').pop() ?? path,
  getLanguageForFile: (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'ts' || ext === 'tsx') return 'typescript';
    if (ext === 'js') return 'javascript';
    if (ext === 'py') return 'python';
    if (ext === 'json') return 'json';
    return 'plaintext';
  },
  isBinaryContent: (buffer: Uint8Array) => {
    for (let i = 0; i < Math.min(buffer.length, 100); i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  },
}));

describe('TextViewerTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', webcrypto);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading state', () => {
    it('shows loading spinner initially', () => {
      render(<TextViewerTab filePath="/path/to/file.txt" />);

      expect(screen.getByText('Loading file...')).toBeInTheDocument();
    });
  });

  describe('browser mode (mock content)', () => {
    it('displays mock content in browser mode', async () => {
      render(<TextViewerTab filePath="/path/to/script.js" />);

      await waitFor(
        () => {
          expect(screen.getByText(/Mock content for script.js/)).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('shows filename in header', async () => {
      render(<TextViewerTab filePath="/path/to/myfile.ts" />);

      await waitFor(
        () => {
          expect(screen.getByText('myfile.ts')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('shows language identifier', async () => {
      render(<TextViewerTab filePath="/path/to/script.py" />);

      await waitFor(
        () => {
          expect(screen.getByText('python')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });
  });

  it('loads hosted UTF-8 notes without native document subscriptions', async () => {
    const previousRuntime = document.documentElement.getAttribute('data-dnaforge-runtime');
    const hostedPlatform = platformModule.platform();
    const platformSpy = vi.spyOn(platformModule, 'platform');
    const content = '\uFEFFα-factor: preserve these UTF-8 notes.\n';
    const bytes = new TextEncoder().encode(content);
    const subscribeFileDocuments = vi.fn(() => {
      throw new Error('Native document subscriptions are unavailable in the hosted browser');
    });
    platformSpy.mockReturnValue({
      ...hostedPlatform,
      fs: {
        ...hostedPlatform.fs,
        readFile: vi.fn().mockResolvedValue(bytes),
        stat: vi.fn().mockResolvedValue({
          size: bytes.byteLength,
          isFile: true,
          isDirectory: false,
          mtime: 0,
        }),
        subscribeFileDocuments,
      },
    });
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';

    try {
      expect(isHostedBrowserRuntime()).toBe(true);
      expect(isBrowserOnly()).toBe(false);
      render(<TextViewerTab filePath="/project/notes.txt" />);

      expect(await screen.findByTestId('text-editor-textarea')).toHaveValue(content);
      expect(subscribeFileDocuments).not.toHaveBeenCalled();
    } finally {
      cleanup();
      platformSpy.mockRestore();
      if (previousRuntime === null) {
        document.documentElement.removeAttribute('data-dnaforge-runtime');
      } else {
        document.documentElement.setAttribute('data-dnaforge-runtime', previousRuntime);
      }
    }
  });

  describe('controls', () => {
    it('has copy path button', async () => {
      render(<TextViewerTab filePath="/path/to/file.txt" />);

      await waitFor(
        () => {
          expect(screen.getByText('Copy Path')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('has line numbers toggle button', async () => {
      render(<TextViewerTab filePath="/path/to/file.txt" />);

      await waitFor(
        () => {
          expect(screen.getByTitle('Toggle line numbers')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('has word wrap toggle button', async () => {
      render(<TextViewerTab filePath="/path/to/file.txt" />);

      await waitFor(
        () => {
          expect(screen.getByTitle('Toggle word wrap')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('toggles line numbers when button clicked', async () => {
      render(<TextViewerTab filePath="/path/to/file.txt" />);

      await waitFor(
        () => {
          expect(screen.getByTitle('Toggle line numbers')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const toggleButton = screen.getByTitle('Toggle line numbers');

      expect(toggleButton).toHaveClass('bg-accent/10');

      fireEvent.click(toggleButton);

      expect(toggleButton).not.toHaveClass('bg-accent/10');

      fireEvent.click(toggleButton);

      expect(toggleButton).toHaveClass('bg-accent/10');
    });

    it('toggles word wrap when button clicked', async () => {
      render(<TextViewerTab filePath="/path/to/file.txt" />);

      await waitFor(
        () => {
          expect(screen.getByTitle('Toggle word wrap')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const toggleButton = screen.getByTitle('Toggle word wrap');

      expect(toggleButton).toHaveClass('bg-accent/10');

      fireEvent.click(toggleButton);

      expect(toggleButton).not.toHaveClass('bg-accent/10');
    });
  });

  describe('copy path functionality', () => {
    it('copies path to clipboard when copy button clicked', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      render(<TextViewerTab filePath="/path/to/myfile.txt" />);

      await waitFor(
        () => {
          expect(screen.getByText('Copy Path')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      fireEvent.click(screen.getByText('Copy Path'));

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('/path/to/myfile.txt');
      });
    });

    it('shows "Copied!" feedback after copying', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      render(<TextViewerTab filePath="/path/to/myfile.txt" />);

      await waitFor(
        () => {
          expect(screen.getByText('Copy Path')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      fireEvent.click(screen.getByText('Copy Path'));

      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument();
      });
    });
  });

  describe('line numbers', () => {
    it('shows line count in the status bar for loaded content', async () => {
      render(<TextViewerTab filePath="/path/to/file.js" />);

      await waitFor(
        () => {
          expect(screen.getByText('7 lines')).toBeInTheDocument();
          expect(screen.getByText('Ln 1')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('passes the line-number toggle state down to the editor', async () => {
      render(<TextViewerTab filePath="/path/to/file.js" />);

      const editor = await screen.findByTestId('text-editor-textarea', undefined, {
        timeout: 1000,
      });
      expect(editor).toHaveAttribute('data-line-numbers', 'true');

      fireEvent.click(screen.getByTitle('Toggle line numbers'));
      expect(editor).toHaveAttribute('data-line-numbers', 'false');
    });
  });

  describe('language-aware editor surface', () => {
    it('passes the detected language id down to the code editor', async () => {
      render(<TextViewerTab filePath="/path/to/script.py" />);

      const editor = await screen.findByTestId('text-editor-textarea', undefined, {
        timeout: 1000,
      });
      expect(editor).toHaveAttribute('data-language', 'python');
    });

    it('uses the JS/TS language id for TypeScript files', async () => {
      render(<TextViewerTab filePath="/path/to/module.ts" />);

      const editor = await screen.findByTestId('text-editor-textarea', undefined, {
        timeout: 1000,
      });
      expect(editor).toHaveAttribute('data-language', 'typescript');
    });

    it('falls back to plaintext for unknown extensions', async () => {
      render(<TextViewerTab filePath="/path/to/notes.txt" />);

      const editor = await screen.findByTestId('text-editor-textarea', undefined, {
        timeout: 1000,
      });
      expect(editor).toHaveAttribute('data-language', 'plaintext');
    });

    it('passes the word-wrap toggle state down to the editor', async () => {
      render(<TextViewerTab filePath="/path/to/file.js" />);

      const editor = await screen.findByTestId('text-editor-textarea', undefined, {
        timeout: 1000,
      });
      expect(editor).toHaveAttribute('data-word-wrap', 'true');

      fireEvent.click(screen.getByTitle('Toggle word wrap'));
      expect(editor).toHaveAttribute('data-word-wrap', 'false');
    });
  });

  describe('editing functionality', () => {
    it('allows editing text content', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeInTheDocument();

      fireEvent.change(textarea, { target: { value: 'new content' } });
      expect(textarea).toHaveValue('new content');
    });

    it('shows Modified indicator when content changes', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Modified')).toBeInTheDocument();
      });
    });

    it('updates tab dirty state via store', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(documentLifecycle.dirty({ kind: 'file', filePath: '/path/to/file.ts' })).toBe(true);
      });
    });

    it('shows Save button when content is modified', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
      });
    });

    it('shows Discard button when content is modified', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
      });
    });
  });

  describe('save functionality', () => {
    it('saves file when Save button is clicked', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
      });

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.getByText('Saved!')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('clears dirty state after save', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
      });

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Modified')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Modified')).not.toBeInTheDocument();
      });

      vi.useRealTimers();
    });
  });

  describe('discard functionality', () => {
    it('reverts content when Discard is clicked', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const textarea = screen.getByRole('textbox');
      const originalValue = (textarea as HTMLTextAreaElement).value;

      fireEvent.change(textarea, { target: { value: 'modified content' } });
      expect(textarea).toHaveValue('modified content');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /discard/i }));

      expect(textarea).toHaveValue(originalValue);
    });

    it('clears dirty state after discard', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Modified')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /discard/i }));

      await waitFor(() => {
        expect(screen.queryByText('Modified')).not.toBeInTheDocument();
      });
    });
  });

  describe('registered save command', () => {
    it('saves the current file through its registered owner', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
      });

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Modified')).toBeInTheDocument();
      });

      void documentLifecycle.save({ kind: 'file', filePath: '/path/to/file.ts' });

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.getByText('Saved!')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('uses the same owner for another save caller', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
      });

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Modified')).toBeInTheDocument();
      });

      void documentLifecycle.save({ kind: 'file', filePath: '/path/to/file.ts' });

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.getByText('Saved!')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });
  });

  describe('registered save target selection', () => {
    it('responds to a matching file save target', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
      });

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Modified')).toBeInTheDocument();
      });

      const saved = documentLifecycle.save({ kind: 'file', filePath: '/path/to/file.ts' });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(await saved).toBe(true);
      vi.useRealTimers();
    });

    it('ignores a save target for a different file', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
      });

      expect(
        await documentLifecycle.save({ kind: 'file', filePath: '/different/path/other.ts' })
      ).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('status bar', () => {
    it('shows UTF-8 encoding', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      expect(screen.getByText('UTF-8')).toBeInTheDocument();
    });

    it('shows Unsaved indicator when dirty', async () => {
      render(<TextViewerTab filePath="/path/to/file.ts" />);

      await waitFor(
        () => {
          expect(screen.queryByText('Loading file...')).not.toBeInTheDocument();
        },
        { timeout: 1000 }
      );

      expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'modified content' } });

      await waitFor(() => {
        expect(screen.getByText('Unsaved')).toBeInTheDocument();
      });
    });
  });
});
