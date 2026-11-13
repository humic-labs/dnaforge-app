import { useCallback, useState } from 'react';
import { getServiceLogger } from '@/shared/utils/service-logger-instance';
import { createDebugSnapshot, type CaptureResult } from '@/shared/utils/debug-snapshot';
import { platform } from '../platform';

interface UseDebugSnapshotOptions {
  getAppState?: () => Record<string, unknown>;
  onCapture?: (result: CaptureResult) => void;
  onError?: (error: Error) => void;
}

interface UseDebugSnapshotResult {
  capture: (note?: string) => Promise<CaptureResult | null>;
  isCapturing: boolean;
  lastSnapshotPath: string | null;
}

export function useDebugSnapshot(options: UseDebugSnapshotOptions = {}): UseDebugSnapshotResult {
  const { getAppState = () => ({}), onCapture, onError } = options;
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastSnapshotPath, setLastSnapshotPath] = useState<string | null>(null);

  const capture = useCallback(
    async (note?: string): Promise<CaptureResult | null> => {
      if (isCapturing) return null;

      setIsCapturing(true);
      try {
        const appData = await platform().path.appDataDir();
        const snapshotDir = `${appData}/snapshots`;

        try {
          await platform().fs.mkdir(snapshotDir, { recursive: true });
        } catch {}

        const logger = await getServiceLogger();

        const snapshot = createDebugSnapshot({
          snapshotDir,
          fileOps: {
            async writeFile(path: string, content: string): Promise<void> {
              await platform().fs.writeTextFile(path, content);
            },
            async ensureDir(path: string): Promise<void> {
              try {
                await platform().fs.mkdir(path, { recursive: true });
              } catch {}
            },
            async listFiles(dir: string): Promise<string[]> {
              try {
                const entries = await platform().fs.readDir(dir);
                return entries.filter((e) => e.isFile).map((e) => e.name);
              } catch {
                return [];
              }
            },
          },
          getRecentServiceCalls: () => logger.getRecentCalls(10),
          getAppState,
        });

        const result = await snapshot.capture({ note });
        setLastSnapshotPath(result.filePath);
        onCapture?.(result);

        console.log(`[DebugSnapshot] Captured to: ${result.filePath}`);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[DebugSnapshot] Capture failed:', error);
        onError?.(error);
        return null;
      } finally {
        setIsCapturing(false);
      }
    },
    [isCapturing, getAppState, onCapture, onError]
  );

  return {
    capture,
    isCapturing,
    lastSnapshotPath,
  };
}
