type ReleaseActivity = () => void;
type AcquireActivity = () => ReleaseActivity;

let acquireActivity: AcquireActivity | undefined;

export function setActiveFilesystemWorkGuard(acquire: AcquireActivity | undefined): void {
  acquireActivity = acquire;
}

export async function withActiveFilesystemWork<T>(work: () => Promise<T>): Promise<T> {
  const release = acquireActivity?.();
  try {
    return await work();
  } finally {
    release?.();
  }
}
