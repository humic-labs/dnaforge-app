import { platform } from '../../platform';
import type { FileOps } from './service-call-logger';

let logDir: string | null = null;

async function ensureLogDir(): Promise<string> {
  if (logDir) return logDir;

  const appData = await platform().path.appDataDir();
  logDir = `${appData.endsWith('/') ? appData : appData + '/'}logs`;

  try {
    await platform().fs.mkdir(logDir, { recursive: true });
  } catch {}

  return logDir;
}

export async function getLogFilePath(): Promise<string> {
  const dir = await ensureLogDir();
  return `${dir}/service-calls.jsonl`;
}

export const platformFileOps: FileOps = {
  async writeFile(path: string, content: string): Promise<void> {
    await platform().fs.writeTextFile(path, content);
  },

  async readFile(path: string): Promise<string> {
    try {
      return await platform().fs.readTextFile(path);
    } catch {
      return '';
    }
  },
};
