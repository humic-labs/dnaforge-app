import type { DocumentSaved } from '@waypoint/api-client';
import type { NativeAnnotationDocumentSaveOutcome } from './managed-annotation-document-command';

type NativeSavedOutcome = Extract<NativeAnnotationDocumentSaveOutcome, { checkpoint: unknown }>;
type UndeclaredBySidecar = Exclude<keyof NativeSavedOutcome, keyof DocumentSaved>;

export const nativeSavedOutcomeFieldsAreDeclaredBySidecar: [UndeclaredBySidecar] extends [never]
  ? true
  : UndeclaredBySidecar = true;
