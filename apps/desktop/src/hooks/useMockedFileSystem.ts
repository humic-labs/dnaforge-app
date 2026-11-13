import { platform } from '../platform';

interface FileSystemFunctions {
  readTextFile: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<Uint8Array>;
  readDir: (
    path: string
  ) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  exists: (path: string) => Promise<boolean>;
}

let cachedFs: FileSystemFunctions | null = null;

export async function getFileSystem(): Promise<FileSystemFunctions> {
  if (cachedFs) return cachedFs;

  const p = platform();
  cachedFs = {
    readTextFile: (path) => p.fs.readTextFile(path),
    readFile: (path) => p.fs.readFile(path),
    readDir: (path) => p.fs.readDir(path),
    exists: (path) => p.fs.exists(path),
  };

  return cachedFs;
}
