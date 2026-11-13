export type StorageCapacity = {
  destinationPath: string;
  availableBytes: number;
  freeBytes: number;
  importantBytes: number | null;
  opportunisticBytes: number | null;
  totalBytes: number | null;
  source: 'filesystem-available' | 'macos-important-usage' | 'macos-opportunistic-usage';
  purpose: 'important' | 'opportunistic';
};

export function readStorageCapacitySync(
  targetPath: string,
  options?: { purpose?: 'important' | 'opportunistic' }
): StorageCapacity;

export function readStorageCapacity(
  targetPath: string,
  options?: { purpose?: 'important' | 'opportunistic' }
): Promise<StorageCapacity>;
