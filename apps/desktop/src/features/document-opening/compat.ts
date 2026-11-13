import { openDocument } from './open-document';
import { presentedTabId } from '../canvas/public/document-presentation';
import type { OpenSequenceFileOptions } from '../sequence/public/openSequenceFile';
import type { OpenStructureFileOptions } from '../structure-files/public/openStructureFile';
import type {
  SequenceDocumentRef,
  ManagedSequenceDocumentRef,
} from '../../shared/managed-sequence-document';

export type { OpenStrategy } from '../canvas/public/document-presentation';

export async function openSequenceFile(options: OpenSequenceFileOptions): Promise<string | null> {
  const { filePath, label, strategy, signal, sourceSurface, ...sequenceOptions } = options;
  return presentedTabId(
    await openDocument({
      target: { kind: 'file', path: filePath, tabType: 'sequence' },
      label,
      placement: strategy,
      signal,
      source: sourceSurface,
      sequenceOptions,
    })
  );
}

export async function openSequenceDocument(
  document: SequenceDocumentRef,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<string | null> {
  const { label, strategy, signal, sourceSurface, ...sequenceOptions } = options;
  return presentedTabId(
    await openDocument({
      target: { kind: 'sequence-document', document },
      label,
      placement: strategy,
      signal,
      source: sourceSurface,
      sequenceOptions,
    })
  );
}

export function openManagedSequenceDocument(
  document: ManagedSequenceDocumentRef,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<string | null> {
  return openSequenceDocument(document, options);
}

export async function openStructureFile(options: OpenStructureFileOptions): Promise<string | null> {
  const { filePath, label, strategy, signal, ...structureOptions } = options;
  return presentedTabId(
    await openDocument({
      target: { kind: 'file', path: filePath, tabType: 'structure' },
      label,
      placement: strategy,
      signal,
      structureOptions,
    })
  );
}
