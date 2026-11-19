import { toUserMessage, type UserMessageKey } from '@waypoint/user-messages';
import { ZodError } from 'zod';

export function molecularDocumentReadMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const fromElectron = text.match(
    /^Error invoking remote method 'molecularDocuments:read': Error: (.+)$/u
  )?.[1];
  return toUserMessage(fromElectron ?? text, molecularDocumentReadFailure(error));
}

export function molecularDocumentReadFailure(error: unknown): UserMessageKey {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const message = `${code ?? ''} ${error instanceof Error ? error.message : String(error)}`;
  if (code === 'ENOENT' || /\bENOENT\b/u.test(message)) return 'file.notFound';
  if (code === 'EACCES' || code === 'EPERM' || /\b(?:EACCES|EPERM)\b/u.test(message))
    return 'file.permissionDenied';
  if (/PROJECT_ACCESS_|owning workspace|project identity|symbolic links/u.test(message))
    return 'document.readProjectUnavailable';
  if (/changed during capture|shortened during capture/u.test(message))
    return 'document.readChanged';
  if (
    /MOLECULAR_DOCUMENT_(?:NEWER_FORMAT|UNSUPPORTED_EXTENSION)|MVS_UNSUPPORTED_VERSION/u.test(
      message
    )
  )
    return 'document.readNewer';
  if (error instanceof ZodError && error.issues.some((issue) => issue.code === 'too_big'))
    return 'document.readTooLarge';
  if (/file (?:size )?limit|snapshot size limit|bounded regular file/u.test(message))
    return 'document.readTooLarge';
  if (/MVS_INVALID_COORDINATES|coordinate digest|binary coordinates/u.test(message))
    return 'document.readCoordinates';
  if (/MVS_UNSUPPORTED_RESOURCE|not pinned|coordinate asset is missing/u.test(message))
    return 'document.readMissingAsset';
  if (/MVS_INVALID_SCENE|MVS_STORY_STEP_INVALID/u.test(message)) return 'document.readScene';
  return 'document.readDamaged';
}
