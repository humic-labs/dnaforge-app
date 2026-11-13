import type { ServiceCallEntry } from './service-call-logger';

export interface SnapshotFileOps {
  writeFile: (path: string, content: string) => Promise<void>;
  ensureDir: (path: string) => Promise<void>;
  listFiles?: (dir: string) => Promise<string[]>;
}

export interface DebugSnapshotConfig {
  snapshotDir: string;
  fileOps: SnapshotFileOps;
  getRecentServiceCalls: () => Promise<ServiceCallEntry[]>;
  getAppState: () => Record<string, unknown>;
}

export interface DebugSnapshotData {
  metadata: {
    capturedAt: string;
    version: string;
    note?: string;
  };
  serviceCalls: ServiceCallEntry[];
  appState: Record<string, unknown>;
}

export interface CaptureOptions {
  note?: string;
}

export interface CaptureResult {
  filePath: string;
}

export interface DebugSnapshot {
  capture: (options?: CaptureOptions) => Promise<CaptureResult>;
  getLatestSnapshotPath: () => Promise<string | null>;
}

export function createDebugSnapshot(config: DebugSnapshotConfig): DebugSnapshot {
  const { snapshotDir, fileOps, getRecentServiceCalls, getAppState } = config;

  return {
    async capture(options?: CaptureOptions): Promise<CaptureResult> {
      const now = new Date();
      const timestamp = now.toISOString();
      const filename = `debug-${timestamp.replace(/:/g, '-')}.json`;
      const filePath = `${snapshotDir}/${filename}`;

      await fileOps.ensureDir(snapshotDir);

      const serviceCalls = await getRecentServiceCalls();
      const appState = getAppState();

      const snapshot: DebugSnapshotData = {
        metadata: {
          capturedAt: timestamp,
          version: '1.0',
          ...(options?.note && { note: options.note }),
        },
        serviceCalls,
        appState,
      };

      await fileOps.writeFile(filePath, JSON.stringify(snapshot, null, 2));

      return { filePath };
    },

    async getLatestSnapshotPath(): Promise<string | null> {
      if (!fileOps.listFiles) {
        return null;
      }

      const files = await fileOps.listFiles(snapshotDir);
      const snapshotFiles = files
        .filter((f) => f.startsWith('debug-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (snapshotFiles.length === 0) {
        return null;
      }

      return `${snapshotDir}/${snapshotFiles[0]}`;
    },
  };
}
