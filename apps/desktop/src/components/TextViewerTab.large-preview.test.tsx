// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TextViewerTab } from './TextViewerTab';

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  writeTextFile: vi.fn(),
  updateTabByEntityId: vi.fn(),
}));

vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));

vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      stat: mocks.stat,
      readFile: mocks.readFile,
      readTextFile: vi.fn(),
      writeTextFile: mocks.writeTextFile,
    },
  }),
}));

vi.mock('../features/canvas/store', () => {
  const state = { panels: {}, updateTabByEntityId: mocks.updateTabByEntityId };
  return {
    useCanvasStore: Object.assign((selector: (state: unknown) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

vi.mock('./CodeEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="code-editor-mounted" />,
}));

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('TextViewerTab large preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a roughly 10 MB FASTQ-like file as a non-editing preview instead of failing', async () => {
    const content = '@read_000001\nACGTACGTACGT\n+\nIIIIIIIIIIII\n';
    mocks.stat.mockResolvedValue({
      size: 10 * 1024 * 1024,
      isFile: true,
      isDirectory: false,
      mtime: 0,
    });
    mocks.readFile.mockResolvedValue(encode(content));

    render(<TextViewerTab filePath="/ws/reads.fastq" />);

    expect(await screen.findByTestId('large-text-preview')).toBeInTheDocument();
    expect(screen.getByText('reads.fastq')).toBeInTheDocument();
    expect(screen.getByText('10.0 MB')).toBeInTheDocument();
    expect(screen.getByText(/showing the first/i)).toBeInTheDocument();
    expect(screen.getByText(/@read_000001/)).toBeInTheDocument();
    expect(screen.queryByText('Failed to load file')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-editor-mounted')).not.toBeInTheDocument();
  });

  it('does not read very large files when only a summary can be shown', async () => {
    mocks.stat.mockResolvedValue({
      size: 80 * 1024 * 1024,
      isFile: true,
      isDirectory: false,
      mtime: 0,
    });

    render(<TextViewerTab filePath="/ws/huge.fastq" />);

    expect(await screen.findByTestId('large-text-preview')).toBeInTheDocument();
    expect(screen.getByText('80.0 MB')).toBeInTheDocument();
    expect(screen.getByText(/Preview is skipped/i)).toBeInTheDocument();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('code-editor-mounted')).not.toBeInTheDocument();
  });
});
