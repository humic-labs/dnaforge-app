import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function operationRuntimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DNAFORGE_OPERATION_RUNTIME_DIR?.trim();
  return configured || join(homedir(), '.dnaforge', 'operations');
}

export function retireOperationConnectionReceipt(
  sessionToken: string,
  directory: string = operationRuntimeDirectory()
): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.connection.json')) continue;
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 16_384) continue;
      const receipt = JSON.parse(readFileSync(path, 'utf8')) as { session_token?: unknown };
      if (receipt.session_token === sessionToken) unlinkSync(path);
    } catch {
      continue;
    }
  }
}
