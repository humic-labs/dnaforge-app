interface NativeLibrary {
  func(signature: string): (...args: Array<number | Buffer>) => number;
}

interface NativeLibraryLoader {
  load(path: string): NativeLibrary;
}

export interface NoninteractiveKeychainPolicy {
  pid: number;
  userInteractionAllowed: false;
  setStatus: number;
  getStatus: number;
}

export function disableKeychainInteraction(options?: {
  platform?: NodeJS.Platform;
  enabled?: boolean;
  loadNative?: (name: string) => NativeLibraryLoader;
}): NoninteractiveKeychainPolicy | null;
