import type { PlatformBridge } from '../platform/types';
import { importHostedSequenceFiles } from './import-files';

type OpenDialogOptions = Parameters<PlatformBridge['dialog']['open']>[0];
type ImportFiles = typeof importHostedSequenceFiles;

export function openHostedFileDialog(
  options: OpenDialogOptions,
  importFiles: ImportFiles = importHostedSequenceFiles
): Promise<string | string[] | null> {
  if (options.directory || options.fileOrDirectory) {
    return Promise.reject(new Error('Folder selection is not available in the hosted app.'));
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple === true;
    input.accept = acceptValue(options.filters);
    input.hidden = true;
    input.dataset.testid = 'hosted-dialog-file-input';

    let settled = false;
    const finish = (value: string | string[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      reject(error);
    };

    input.addEventListener(
      'change',
      () => {
        const files = [...(input.files ?? [])];
        if (files.length === 0) {
          finish(null);
          return;
        }
        void importFiles(files).then(
          ({ paths }) => finish(options.multiple ? paths : (paths[0] ?? null)),
          fail
        );
      },
      { once: true }
    );
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

function acceptValue(filters: OpenDialogOptions['filters']): string {
  const extensions = new Set<string>();
  for (const filter of filters ?? []) {
    for (const extension of filter.extensions) {
      const normalized = extension.trim().replace(/^\.+/u, '');
      if (normalized) extensions.add(`.${normalized}`);
    }
  }
  return [...extensions].join(',');
}
