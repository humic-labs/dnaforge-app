import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LoadingTab } from './LoadingTab';
import { DeferredSequenceTab } from './DeferredSequenceTab';
import { MissingFileTab } from './MissingFileTab';
import { ErrorFileTab } from './ErrorFileTab';

afterEach(() => {
  cleanup();
});

describe('LoadingTab', () => {
  it('renders with role=status (live region)', () => {
    render(<LoadingTab />);
    const node = screen.getByTestId('canvas-loading-tab');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.getAttribute('aria-live')).toBe('polite');
  });
});

describe('DeferredSequenceTab', () => {
  it('shows file basename + size + load + close buttons', () => {
    const onLoad = vi.fn();
    const onClose = vi.fn();
    render(
      <DeferredSequenceTab
        documentLabel="giant-genome.gb"
        fileSizeBytes={300 * 1024 * 1024}
        onLoadRequest={onLoad}
        onClose={onClose}
      />
    );
    expect(screen.getByText(/giant-genome\.gb/)).toBeTruthy();
    expect(screen.getByText(/300\.0 MB/)).toBeTruthy();
    expect(screen.getByTestId('deferred-sequence-tab-load')).toBeTruthy();
    expect(screen.getByTestId('deferred-sequence-tab-close')).toBeTruthy();
  });

  it('falls back to "large file" when size is missing', () => {
    render(
      <DeferredSequenceTab documentLabel="x.gb" onLoadRequest={() => {}} onClose={() => {}} />
    );
    expect(screen.getByText(/large file/)).toBeTruthy();
  });

  it('invokes onLoadRequest on Load anyway click', () => {
    const onLoad = vi.fn();
    render(
      <DeferredSequenceTab
        documentLabel="x.gb"
        fileSizeBytes={1024}
        onLoadRequest={onLoad}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('deferred-sequence-tab-load'));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose on Close tab click', () => {
    const onClose = vi.fn();
    render(
      <DeferredSequenceTab
        documentLabel="x.gb"
        fileSizeBytes={1024}
        onLoadRequest={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByTestId('deferred-sequence-tab-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MissingFileTab', () => {
  it('renders close + retry buttons (reveal optional)', () => {
    render(<MissingFileTab filePath="/tmp/gone.gb" onClose={() => {}} onRetry={() => {}} />);
    expect(screen.getByTestId('missing-file-tab-close')).toBeTruthy();
    expect(screen.getByTestId('missing-file-tab-retry')).toBeTruthy();
    expect(screen.queryByTestId('missing-file-tab-reveal')).toBeNull();
  });

  it('shows reveal button when onReveal supplied', () => {
    const onReveal = vi.fn();
    render(
      <MissingFileTab
        filePath="/tmp/gone.gb"
        onReveal={onReveal}
        onClose={() => {}}
        onRetry={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('missing-file-tab-reveal'));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry on Retry click', () => {
    const onRetry = vi.fn();
    render(<MissingFileTab filePath="/x.gb" onClose={() => {}} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('missing-file-tab-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorFileTab', () => {
  it('invokes onRetry / onClose', () => {
    const onClose = vi.fn();
    const onRetry = vi.fn();
    render(<ErrorFileTab filePath="/x.gb" onClose={onClose} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('error-file-tab-close'));
    fireEvent.click(screen.getByTestId('error-file-tab-retry'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
