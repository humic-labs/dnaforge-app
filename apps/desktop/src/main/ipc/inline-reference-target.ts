import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { sequencePackagePaths } from '../../db/sequence-package';
import { isPathInsideBoundary, isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import type {
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../../shared/inline-reference-ipc';
import {
  getStructureFileFormat,
  isSupportedSequencePath,
} from '../../shared/scientific-file-types';
import { handleGroup } from '../../shared/ipc-contract';
import { fsInlineReferenceTargetContract } from '../../shared/ipc/fs-inline-reference-target.contract';

const MAX_ROOTS = 64;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_BYTES = 255;
const textEncoder = new TextEncoder();

function invalidSegment(segment: string): boolean {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    textEncoder.encode(segment).byteLength > MAX_SEGMENT_BYTES ||
    Array.from(segment).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return true;
  }

  return false;
}

function fileSystemFailure(error: unknown): 'target-not-found' | 'target-unavailable' {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    ? 'target-not-found'
    : 'target-unavailable';
}

async function classifyTarget(
  request: ResolveInlineReferenceTargetRequest,
  lexicalTarget: string,
  canonicalTarget: string
): Promise<'file' | 'directory' | 'sequence-package' | null> {
  const targetStat = await stat(canonicalTarget);

  if (request.targetKind === 'workspace') {
    if (targetStat.isFile()) return 'file';
    if (targetStat.isDirectory()) {
      const markerPath = sequencePackagePaths(canonicalTarget).metaPath;
      try {
        const markerStat = await stat(markerPath);
        if (markerStat.isFile()) return 'sequence-package';
      } catch {}
      return 'directory';
    }
    return null;
  }

  if (request.targetKind === 'structure') {
    return targetStat.isFile() && getStructureFileFormat(lexicalTarget) ? 'file' : null;
  }

  if (targetStat.isFile()) {
    return isSupportedSequencePath(lexicalTarget) ? 'file' : null;
  }
  if (!targetStat.isDirectory()) return null;

  const markerPath = sequencePackagePaths(canonicalTarget).metaPath;
  try {
    const markerStat = await stat(markerPath);
    return markerStat.isFile() ? 'sequence-package' : null;
  } catch {
    return null;
  }
}

export async function resolveInlineReferenceTarget(
  request: ResolveInlineReferenceTargetRequest
): Promise<ResolveInlineReferenceTargetResult> {
  if (
    !request ||
    !Array.isArray(request.roots) ||
    request.roots.length === 0 ||
    request.roots.length > MAX_ROOTS ||
    typeof request.root !== 'string' ||
    !request.root ||
    !Array.isArray(request.segments) ||
    request.segments.length === 0 ||
    request.segments.length > MAX_SEGMENTS ||
    !['workspace', 'sequence', 'structure'].includes(request.targetKind) ||
    request.segments.some((segment) => typeof segment !== 'string' || invalidSegment(segment))
  ) {
    return { ok: false, code: 'invalid-input' };
  }

  const matches = request.roots.filter((root) => root.name === request.root);
  if (matches.length === 0) return { ok: false, code: 'root-not-found' };
  if (matches.length !== 1) return { ok: false, code: 'root-ambiguous' };

  const mountedRoot = matches[0];
  if (typeof mountedRoot.path !== 'string' || !mountedRoot.path || !isAbsolute(mountedRoot.path)) {
    return { ok: false, code: 'invalid-input' };
  }

  const relativePath = request.segments.join('/');
  if (!isSafeWorkspaceRelativePath(relativePath)) {
    return { ok: false, code: 'invalid-input' };
  }

  const lexicalTarget = resolve(mountedRoot.path, ...request.segments);
  if (!isPathInsideBoundary(lexicalTarget, mountedRoot.path)) {
    return { ok: false, code: 'outside-root' };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(mountedRoot.path);
  } catch {
    return { ok: false, code: 'root-unavailable' };
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(lexicalTarget);
  } catch (error) {
    return { ok: false, code: fileSystemFailure(error) };
  }

  if (!isPathInsideBoundary(canonicalTarget, canonicalRoot)) {
    return { ok: false, code: 'outside-root' };
  }

  try {
    const targetType = await classifyTarget(request, lexicalTarget, canonicalTarget);
    if (!targetType) return { ok: false, code: 'wrong-kind' };
    return {
      ok: true,
      path: lexicalTarget,
      rootPath: mountedRoot.path,
      canonicalPath: canonicalTarget,
      canonicalRootPath: canonicalRoot,
      relativePath,
      targetType,
    };
  } catch (error) {
    return { ok: false, code: fileSystemFailure(error) };
  }
}

export function registerInlineReferenceTargetHandlers(): void {
  handleGroup(fsInlineReferenceTargetContract, {
    resolveInlineReferenceTarget: (_event, request) => resolveInlineReferenceTarget(request),
  });
}
