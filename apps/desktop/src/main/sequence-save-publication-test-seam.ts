export interface SequenceSaveProductCheckpoint {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  operationId: string;
}

type Observer = (checkpoint: SequenceSaveProductCheckpoint) => Promise<void>;

let observer: Observer | undefined;

export function setSequenceSaveAfterProductForTest(next: Observer | undefined): void {
  observer = next;
}

export function observeSequenceSaveAfterProductForTest(
  checkpoint: SequenceSaveProductCheckpoint
): Promise<void> | undefined {
  return observer?.(checkpoint);
}
