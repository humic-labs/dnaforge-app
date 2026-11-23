import { userMessage, type UserMessageKey } from '@waypoint/user-messages';
import { z } from 'zod';

export const documentReadFailureCode = z.enum([
  'unknown',
  'malformed',
  'newer-format',
  'unsupported-format',
  'missing',
  'missing-asset',
  'permission',
  'project',
  'too-large',
  'changed',
  'password',
  'runtime',
  'coordinates',
  'scene',
]);
export type DocumentReadFailureCode = z.infer<typeof documentReadFailureCode>;

const messages: Record<DocumentReadFailureCode, UserMessageKey> = {
  unknown: 'document.readUnknown',
  malformed: 'document.readDamaged',
  'newer-format': 'document.readNewer',
  'unsupported-format': 'document.readUnsupported',
  missing: 'file.notFound',
  'missing-asset': 'document.readMissingAsset',
  permission: 'file.permissionDenied',
  project: 'document.readProjectUnavailable',
  'too-large': 'document.readTooLarge',
  changed: 'document.readChanged',
  password: 'document.readPassword',
  runtime: 'document.readRuntimeUnavailable',
  coordinates: 'document.readCoordinates',
  scene: 'document.readScene',
};

export function documentReadReason(code: DocumentReadFailureCode): string {
  return userMessage(messages[code]);
}

export function isDocumentReadReason(message: string): boolean {
  return documentReadFailureCode.options.some((code) => documentReadReason(code) === message);
}

export class DocumentReadError extends Error {
  constructor(
    readonly code: DocumentReadFailureCode,
    readonly recognized = false,
    options?: ErrorOptions & { detail?: string }
  ) {
    super(options?.detail ?? documentReadReason(code), options);
    this.name = 'DocumentReadError';
  }
}

export function documentReadError(error: unknown): DocumentReadError {
  if (error instanceof DocumentReadError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return new DocumentReadError('missing', false, { cause: error });
  if (code === 'EACCES' || code === 'EPERM')
    return new DocumentReadError('permission', false, { cause: error });
  return new DocumentReadError('unknown', false, { cause: error });
}

export function blockedDocument(error: unknown, paths?: string[]) {
  const failure = documentReadError(error);
  return {
    state: 'blocked' as const,
    code: failure.code,
    reason: documentReadReason(failure.code),
    recognized: failure.recognized,
    ...(paths?.length ? { paths } : {}),
  };
}
