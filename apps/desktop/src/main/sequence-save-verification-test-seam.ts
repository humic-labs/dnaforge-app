type Observer = (documentId: string) => void;

let observer: Observer | undefined;

export function setSequenceSaveVerificationForTest(next: Observer | undefined): void {
  observer = next;
}

export function observeSequenceSaveVerificationForTest(documentId: string): void {
  observer?.(documentId);
}
