import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHostedFileDialog } from './open-file-dialog';

describe('openHostedFileDialog', () => {
  afterEach(() => {
    document.querySelectorAll('[data-testid="hosted-dialog-file-input"]').forEach((input) => {
      input.remove();
    });
  });

  it('persists selected files and returns their hosted paths', async () => {
    const importFiles = vi.fn().mockResolvedValue({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      paths: [
        '/hosted/11111111-1111-4111-8111-111111111111/files/clone-a.fasta',
        '/hosted/11111111-1111-4111-8111-111111111111/files/clone-b.ab1',
      ],
    });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const result = openHostedFileDialog(
      {
        multiple: true,
        filters: [{ name: 'Sequences', extensions: ['fasta', '.ab1'] }],
      },
      importFiles
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="hosted-dialog-file-input"]'
    );
    expect(input).not.toBeNull();
    expect(input?.multiple).toBe(true);
    expect(input?.accept).toBe('.fasta,.ab1');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['query-a'], 'clone-a.fasta'), new File(['query-b'], 'clone-b.ab1')],
    });
    input?.dispatchEvent(new Event('change'));

    await expect(result).resolves.toEqual([
      '/hosted/11111111-1111-4111-8111-111111111111/files/clone-a.fasta',
      '/hosted/11111111-1111-4111-8111-111111111111/files/clone-b.ab1',
    ]);
    expect(importFiles).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="hosted-dialog-file-input"]')).toBeNull();
    click.mockRestore();
  });

  it('returns null when the browser picker is canceled', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const result = openHostedFileDialog({}, vi.fn());
    document
      .querySelector<HTMLInputElement>('[data-testid="hosted-dialog-file-input"]')
      ?.dispatchEvent(new Event('cancel'));

    await expect(result).resolves.toBeNull();
    click.mockRestore();
  });

  it('rejects folder selection instead of fabricating a path', async () => {
    await expect(openHostedFileDialog({ directory: true }, vi.fn())).rejects.toThrow(
      'Folder selection is not available in the hosted app.'
    );
  });
});
