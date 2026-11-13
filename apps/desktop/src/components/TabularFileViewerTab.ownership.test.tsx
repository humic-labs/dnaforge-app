import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TabularFileViewerTab } from './TabularFileViewerTab';
import type { FileDocumentSnapshot } from '../shared/file-document';

const ports = vi.hoisted(() => ({ inspect: vi.fn(), commit: vi.fn() }));
vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      stat: vi.fn().mockResolvedValue({ size: 21 }),
      readTextFile: vi.fn(
        async (path: string) => `sample,value\n${path.includes('old') ? 'OLD' : 'CURRENT'},7\n`
      ),
      subscribeFileDocuments: vi.fn(),
      fileDocument: ports.inspect,
    },
  }),
}));
vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));
vi.mock('../lib/readable-content-telemetry', async (original) => ({
  ...(await original<typeof import('../lib/readable-content-telemetry')>()),
  commitReadableContent: ports.commit,
}));

function snapshot(path: string): FileDocumentSnapshot {
  return {
    documentId: path,
    path,
    revision: '1',
    ready: false,
    dirty: false,
    content: null,
    persistedContent: null,
    diskContent: null,
  } as FileDocumentSnapshot;
}

it('retires native document inspection before a replacement table can publish', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  let finishOld!: (snapshot: FileDocumentSnapshot) => void;
  ports.inspect.mockImplementation(({ target }) =>
    target.path.includes('old')
      ? new Promise<FileDocumentSnapshot>((resolve) => {
          finishOld = resolve;
        })
      : Promise.resolve(snapshot(target.path))
  );
  const { rerender } = render(<TabularFileViewerTab filePath="/workspace/old-ownership.csv" />);
  await waitFor(() => expect(ports.inspect).toHaveBeenCalledTimes(1));
  rerender(<TabularFileViewerTab filePath="/workspace/current-ownership.csv" />);
  expect(await screen.findByText('CURRENT')).toBeVisible();
  await act(async () => {
    finishOld(snapshot('/workspace/old-ownership.csv'));
  });
  expect(screen.getByText('CURRENT')).toBeVisible();
  expect(screen.queryByText('OLD')).toBeNull();
  expect(ports.commit).not.toHaveBeenCalledWith('/workspace/old-ownership.csv');
});
