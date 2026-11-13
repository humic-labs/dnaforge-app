export interface ServiceCallEntry {
  timestamp: string;
  service: string;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export interface FileOps {
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
}

export interface ServiceCallLoggerConfig {
  logFilePath: string;
  maxEntries: number;
  fileOps: FileOps;
}

export interface ServiceCallLogger {
  log: (entry: Omit<ServiceCallEntry, 'timestamp'>) => Promise<void>;
  getRecentCalls: (count: number) => Promise<ServiceCallEntry[]>;
}

export function createServiceCallLogger(config: ServiceCallLoggerConfig): ServiceCallLogger {
  const { logFilePath, maxEntries, fileOps } = config;

  async function readEntries(): Promise<ServiceCallEntry[]> {
    try {
      const content = await fileOps.readFile(logFilePath);
      if (!content.trim()) {
        return [];
      }
      return content
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ServiceCallEntry);
    } catch {
      return [];
    }
  }

  async function writeEntries(entries: ServiceCallEntry[]): Promise<void> {
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fileOps.writeFile(logFilePath, content);
  }

  return {
    async log(entry: Omit<ServiceCallEntry, 'timestamp'>): Promise<void> {
      const fullEntry: ServiceCallEntry = {
        ...entry,
        timestamp: new Date().toISOString(),
      };

      const entries = await readEntries();
      entries.push(fullEntry);

      const truncated = entries.slice(-maxEntries);

      await writeEntries(truncated);
    },

    async getRecentCalls(count: number): Promise<ServiceCallEntry[]> {
      const entries = await readEntries();
      return entries.slice(-count);
    },
  };
}
