import {
  DocumentReadError,
  documentReadError,
  documentReadReason,
  isDocumentReadReason,
} from './document-read-failure';
import { MolecularDocumentCompatibilityError } from './molecular-document-extensions';
import { MolViewSpecSceneError } from './mol-view-spec-scene';
import { MolecularStorageError } from './molecular-storage';

export function molecularDocumentReadMessage(error: unknown) {
  const text = error instanceof Error ? error.message : '';
  const fromElectron = text.match(
    /^Error invoking remote method 'molecularDocuments:read': Error: (.+)$/u
  )?.[1];
  const message = fromElectron ?? text;
  return isDocumentReadReason(message)
    ? message
    : documentReadReason(molecularDocumentReadFailure(error).code);
}

export function molecularDocumentReadFailure(error: unknown): DocumentReadError {
  if (
    error instanceof Error &&
    (error.message === 'PROJECT_ACCESS_DENIED' ||
      error.message.startsWith('PROJECT_ACCESS_DENIED:') ||
      error.message.startsWith('PROJECT_ACCESS_CHANGED:'))
  )
    return new DocumentReadError('project', false, { cause: error });
  if (error instanceof MolecularStorageError)
    return new DocumentReadError('too-large', error.code === 'MVS_VIEW_TOO_LARGE', {
      cause: error,
    });
  if (error instanceof MolecularDocumentCompatibilityError) {
    const code = error.code;
    return new DocumentReadError(
      code === 'MOLECULAR_DOCUMENT_NEWER_FORMAT'
        ? 'newer-format'
        : code === 'MOLECULAR_DOCUMENT_UNSUPPORTED_EXTENSION'
          ? 'unsupported-format'
          : 'malformed',
      true,
      { cause: error }
    );
  }
  if (error instanceof MolViewSpecSceneError) {
    switch (error.code) {
      case 'MVS_UNSUPPORTED_VERSION':
        return new DocumentReadError('newer-format', true, { cause: error });
      case 'MVS_INVALID_COORDINATES':
        return new DocumentReadError('coordinates', true, { cause: error });
      case 'MVS_UNSUPPORTED_RESOURCE':
        return new DocumentReadError(
          error.missingResource ? 'missing-asset' : 'unsupported-format',
          true,
          {
            cause: error,
          }
        );
      case 'MVS_INVALID_SCENE':
      case 'MVS_STORY_STEP_INVALID':
        return new DocumentReadError('scene', true, { cause: error });
    }
  }
  return documentReadError(error);
}
