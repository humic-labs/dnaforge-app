import type { SequenceModelCommand } from './sequence-document-model';
interface SequenceClientPort {
  command(command: SequenceModelCommand): void;
  isInputPending(documentId: string): boolean;
  assertInput(documentId: string, purpose?: 'discard'): void;
}
let port: SequenceClientPort | undefined;
const readOnlyPreviews = new Set<string>();
export function registerReadOnlySequencePreview(documentId: string): void {
  readOnlyPreviews.add(documentId);
}
export function isReadOnlySequencePreview(documentId: string): boolean {
  return readOnlyPreviews.has(documentId);
}
export function setSequenceClientPort(next: SequenceClientPort): () => void {
  port = next;
  return () => {
    if (port === next) port = undefined;
  };
}
export function notifySequenceModelCommand(command: SequenceModelCommand): void {
  port?.command(command);
}
export function assertNativeSequenceClientInputCurrent(
  documentId: string,
  purpose?: 'discard'
): void {
  port?.assertInput(documentId, purpose);
}
export function isNativeSequenceClientInputPending(documentId: string): boolean {
  return port?.isInputPending(documentId) ?? false;
}
