import { isSafeRelativePath } from '@waypoint/share-bundle/shared';

export const HOSTED_RESOURCE_BINDINGS_PATH = '.dnaforge/hosted-resource-bindings.json';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface HostedResourceBinding {
  resourceId: string;
  path: string;
  contentSha256: string;
}

export interface HostedResourceBindings {
  schema: 1;
  remoteWorkspaceId: string;
  remoteVersionId: string;
  resources: HostedResourceBinding[];
}

export function parseHostedResourceBindings(input: string): HostedResourceBindings {
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new Error('Hosted resource bindings are not valid JSON.');
  }
  if (!isRecord(value) || value.schema !== 1) throw invalidBindings();
  if (!isUuid(value.remoteWorkspaceId) || !isUuid(value.remoteVersionId)) {
    throw invalidBindings();
  }
  if (!Array.isArray(value.resources)) throw invalidBindings();

  const paths = new Set<string>();
  const resourceIds = new Set<string>();
  const resources = value.resources.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !isUuid(candidate.resourceId) ||
      typeof candidate.path !== 'string' ||
      !isSafeRelativePath(candidate.path) ||
      typeof candidate.contentSha256 !== 'string' ||
      !SHA256_RE.test(candidate.contentSha256)
    ) {
      throw invalidBindings();
    }
    const path = candidate.path.split('\\').join('/');
    if (paths.has(path) || resourceIds.has(candidate.resourceId)) throw invalidBindings();
    paths.add(path);
    resourceIds.add(candidate.resourceId);
    return {
      resourceId: candidate.resourceId.toLocaleLowerCase('en-US'),
      path,
      contentSha256: candidate.contentSha256,
    };
  });

  resources.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  return {
    schema: 1,
    remoteWorkspaceId: value.remoteWorkspaceId.toLocaleLowerCase('en-US'),
    remoteVersionId: value.remoteVersionId.toLocaleLowerCase('en-US'),
    resources,
  };
}

export function serializeHostedResourceBindings(value: HostedResourceBindings): string {
  const parsed = parseHostedResourceBindings(JSON.stringify(value));
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function invalidBindings(): Error {
  return new Error('Hosted resource bindings are invalid.');
}
