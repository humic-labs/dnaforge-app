import { isAbsolute, resolve } from 'node:path';

export * from '../../shared/portable-reference/reference-preparation-validation';

export function resolveInputPath(path: string, manifestDir: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(manifestDir, path);
}
