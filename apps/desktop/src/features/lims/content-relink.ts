import { isSupportedContentHash } from '../../shared/lims';

export interface RelinkAppearedFile {
  path: string;
  fileContentHash?: string | null;
}

export interface RelinkMissingEntity {
  id: string;
  oldPath: string;
  fileContentHash?: string | null;
}

export interface ContentRelinkPair {
  entityId: string;
  oldPath: string;
  newPath: string;
  contentHash: string;
}

export interface ContentRelinkAmbiguity {
  contentHash: string;
  entityIds: string[];
  paths: string[];
}

export interface ContentRelinkResult {
  relinks: ContentRelinkPair[];
  ambiguous: ContentRelinkAmbiguity[];
}

function canonicalHash(hash: string | null | undefined): string | null {
  if (!isSupportedContentHash(hash)) {
    return null;
  }
  const sep = hash.indexOf(':');
  const prefix = hash.slice(0, sep);
  const hex = hash.slice(sep + 1).toLowerCase();
  return `${prefix}:${hex}`;
}

export function relinkByFileContentHash(
  missing: readonly RelinkMissingEntity[],
  appeared: readonly RelinkAppearedFile[]
): ContentRelinkResult {
  const missingByHash = new Map<string, RelinkMissingEntity[]>();
  for (const entity of missing) {
    const key = canonicalHash(entity.fileContentHash);
    if (!key) {
      continue;
    }
    const bucket = missingByHash.get(key);
    if (bucket) {
      bucket.push(entity);
    } else {
      missingByHash.set(key, [entity]);
    }
  }

  const appearedByHash = new Map<string, RelinkAppearedFile[]>();
  for (const file of appeared) {
    const key = canonicalHash(file.fileContentHash);
    if (!key) {
      continue;
    }
    const bucket = appearedByHash.get(key);
    if (bucket) {
      bucket.push(file);
    } else {
      appearedByHash.set(key, [file]);
    }
  }

  const relinks: ContentRelinkPair[] = [];
  const ambiguous: ContentRelinkAmbiguity[] = [];

  for (const [hash, entities] of missingByHash) {
    const files = appearedByHash.get(hash);
    if (!files || files.length === 0) {
      continue;
    }
    if (entities.length > 1 || files.length > 1) {
      ambiguous.push({
        contentHash: hash,
        entityIds: entities.map((e) => e.id),
        paths: files.map((f) => f.path),
      });
      continue;
    }
    const entity = entities[0];
    const file = files[0];
    if (entity.oldPath === file.path) {
      continue;
    }
    relinks.push({
      entityId: entity.id,
      oldPath: entity.oldPath,
      newPath: file.path,
      contentHash: hash,
    });
  }

  return { relinks, ambiguous };
}
