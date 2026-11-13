import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AdmittedTextFileReadRequest } from '../../shared/admitted-file-read';
import { HARD_CAP_BYTES, OversizedFileError } from '../../shared/oversized-guard';
import { readFileBoundedFromHandle } from './bounded-file-read';
import { assertAdmittedReadPath } from './path-allowlist';
import { resolveSelectedLocalFilePath } from '../local-indexed-track-authority';

export async function readAdmittedTextFile(input: AdmittedTextFileReadRequest): Promise<string> {
  if (!input || typeof input !== 'object' || typeof input.path !== 'string') {
    throw new Error('[fs:readAdmittedTextFile] A path is required.');
  }
  if (!isAbsolute(input.path)) {
    throw new Error(
      `[fs:readAdmittedTextFile] Path must be absolute, got relative: "${input.path}". ` +
        'Resolve workspace-relative paths before calling IPC.'
    );
  }
  const grantedFiles = Array.isArray(input.grantedFiles) ? input.grantedFiles : [];
  let admittedPath: string;
  try {
    admittedPath = await assertAdmittedReadPath(input.path, {
      projectRoots: Array.isArray(input.projectRoots) ? input.projectRoots : [],
      grantedFiles,
    });
  } catch (error) {
    if (!grantedFiles.includes(input.path)) throw error;
    try {
      admittedPath = resolveSelectedLocalFilePath(input.path);
    } catch {
      throw error;
    }
  }
  if (input.maxBytes !== undefined) {
    return Buffer.from(await readFileBoundedFromHandle(admittedPath, input.maxBytes)).toString(
      'utf-8'
    );
  }
  const size = (await stat(admittedPath)).size;
  if (size > HARD_CAP_BYTES) throw new OversizedFileError(size, admittedPath, true);
  return readFile(admittedPath, 'utf-8');
}
