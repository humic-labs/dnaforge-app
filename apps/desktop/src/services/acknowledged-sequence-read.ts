type SavedSequenceReadProof = (sourcePath: string) => Promise<boolean>;

let proveSavedSequenceRead: SavedSequenceReadProof | undefined;

export function registerAcknowledgedSequenceReadProof(prove: SavedSequenceReadProof): void {
  proveSavedSequenceRead = prove;
}

export async function canReadAcknowledgedSequence(sourcePath: string): Promise<boolean> {
  try {
    return (await proveSavedSequenceRead?.(sourcePath)) === true;
  } catch {
    return false;
  }
}
