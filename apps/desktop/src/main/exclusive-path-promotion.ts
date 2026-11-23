import { createRequire } from 'node:module';
import { join, toNamespacedPath } from 'node:path';
import { getSystemErrorName } from 'node:util';

type Promote = (source: string, destination: string) => void;
let loaded: Promote | undefined;
const MOVEFILE_WRITE_THROUGH = 0x8;
const RENAME_EXCL = 0x4;
const RENAME_NOREPLACE = 1;
const AT_FDCWD = -100;

function loadPromotion(): Promote {
  const native = createRequire(join(__dirname, 'exclusive-path-promotion.cjs'))(
    'koffi'
  ) as typeof import('koffi');
  if (process.platform === 'win32') {
    const kernel = native.load('kernel32.dll');
    const move = kernel.func(
      'int __stdcall MoveFileExW(const char16_t *source, const char16_t *destination, unsigned int flags)'
    );
    return (source, destination) => {
      if (!move(toNamespacedPath(source), toNamespacedPath(destination), MOVEFILE_WRITE_THROUGH))
        throw new Error('The destination could not be claimed for exclusive publication.');
    };
  }
  const libc = native.load(null);
  let move: (source: string, destination: string) => number;
  if (process.platform === 'darwin') {
    const renameExclusive = libc.func(
      'int renamex_np(const char *source, const char *destination, unsigned int flags)'
    );
    move = (source, destination) => renameExclusive(source, destination, RENAME_EXCL);
  } else if (process.platform === 'linux') {
    const renameExclusive = libc.func(
      'int renameat2(int olddirfd, const char *source, int newdirfd, const char *destination, unsigned int flags)'
    );
    move = (source, destination) =>
      renameExclusive(AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE);
  } else {
    throw new Error('Exclusive directory publication is unavailable on this operating system.');
  }
  return (source, destination) => {
    if (move(source, destination) !== 0) {
      const errno = native.errno();
      const code = errno > 0 ? getSystemErrorName(-errno) : 'NATIVE_RENAME_FAILED';
      throw Object.assign(
        new Error(`The restoration destination could not be claimed (${code}).`),
        { code }
      );
    }
  };
}

export function promotePathExclusively(source: string, destination: string): void {
  loaded ??= loadPromotion();
  loaded(source, destination);
}
