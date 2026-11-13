import { z } from 'zod';
import { isSafeWorkspaceRelativePath } from './path-boundary';

const identity = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const path = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      isSafeWorkspaceRelativePath(value) &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !value.includes('\\') &&
      !value
        .split('/')
        .some((part) => ['', '.', '..', '.git', '.forge', '.dnaforge', '.waypoint'].includes(part))
  );

export const projectResourceReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), projectId: identity, entityId: identity }).strict(),
  z
    .object({
      kind: z.literal('path'),
      projectId: identity,
      path,
      resourceKind: z.enum(['file', 'directory']),
    })
    .strict(),
]);

export type ProjectResourceReference = z.infer<typeof projectResourceReferenceSchema>;
export interface ResolvedProjectResourceReference {
  reference: ProjectResourceReference;
  workspaceRoot: string;
  path: string;
  entityType: string;
  label: string;
}
export interface ResolveNotebookResourceReferenceRequest {
  documentId: string;
  reference: string | ProjectResourceReference;
}
export const resolveNotebookResourceReferenceRequestSchema = z
  .object({
    documentId: identity,
    reference: z.union([z.string().min(1).max(8192), projectResourceReferenceSchema]),
  })
  .strict();

const PREFIX = 'dnaforge-chat://project-resource/';
const LEGACY_PREFIX = 'entity://project-resource/';
export const MAX_PROJECT_RESOURCE_REFERENCE_URI_BYTES = 2048;

export function projectResourceReferenceHref(input: ProjectResourceReference): string {
  const reference = projectResourceReferenceSchema.parse(input);
  const owner = encodeURIComponent(reference.projectId);
  const href =
    reference.kind === 'entity'
      ? `${PREFIX}${owner}/entity/${encodeURIComponent(reference.entityId)}`
      : `${PREFIX}${owner}/${reference.resourceKind}/${reference.path.split('/').map(encodeURIComponent).join('/')}`;
  if (new TextEncoder().encode(href).byteLength > MAX_PROJECT_RESOURCE_REFERENCE_URI_BYTES)
    throw new Error('The project resource reference exceeds the supported URI length.');
  return href;
}

export function projectResourceReferenceFromHref(href: string): ProjectResourceReference | null {
  const prefix = href.startsWith(PREFIX)
    ? PREFIX
    : href.startsWith(LEGACY_PREFIX)
      ? LEGACY_PREFIX
      : null;
  if (
    !prefix ||
    new TextEncoder().encode(href).byteLength > MAX_PROJECT_RESOURCE_REFERENCE_URI_BYTES ||
    /[?#\\]/u.test(href)
  )
    return null;
  try {
    const [owner, kind, ...segments] = href.slice(prefix.length).split('/');
    if (!owner || !kind || segments.length === 0 || segments.some((part) => !part)) return null;
    const projectId = decodeURIComponent(owner);
    if (projectId.includes('/') || projectId.includes('\\')) return null;
    const decoded = segments.map(decodeURIComponent);
    const input =
      kind === 'entity' && decoded.length === 1
        ? { kind: 'entity', projectId, entityId: decoded[0] }
        : (kind === 'file' || kind === 'directory') &&
            !decoded.some((part) => part.includes('/') || part.includes('\\'))
          ? { kind: 'path', projectId, path: decoded.join('/'), resourceKind: kind }
          : null;
    const parsed = projectResourceReferenceSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isProjectResourceReferenceHref(href: string): boolean {
  return (
    href.startsWith(PREFIX) ||
    href.startsWith(LEGACY_PREFIX) ||
    href.startsWith('dnaforge-chat://workspace/') ||
    href.startsWith('dnaforge-chat://entity/')
  );
}
