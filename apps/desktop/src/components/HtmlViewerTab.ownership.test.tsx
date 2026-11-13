import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HtmlViewerTab } from './HtmlViewerTab';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../platform', () => ({ platform: () => ({ fs: { readTextFile: mocks.read } }) }));
vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));

it('retires displayed HTML before the replacement file read completes', async () => {
  let finish!: (value: string) => void;
  mocks.read.mockResolvedValueOnce('<p>Old report</p>');
  mocks.read.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  const { rerender } = render(<HtmlViewerTab filePath="/workspace/old.html" />);
  expect(await screen.findByTestId('html-viewer-iframe')).toHaveAttribute(
    'srcdoc',
    '<p>Old report</p>'
  );
  rerender(<HtmlViewerTab filePath="/workspace/current.html" />);
  expect(screen.queryByTestId('html-viewer-iframe')).toBeNull();
  expect(screen.getByText('Loading HTML…')).toBeVisible();
  await act(async () => {
    finish('<p>Current report</p>');
  });
  expect(screen.getByTestId('html-viewer-iframe')).toHaveAttribute(
    'srcdoc',
    '<p>Current report</p>'
  );
  expect(screen.getByText('current.html')).toBeVisible();
});
