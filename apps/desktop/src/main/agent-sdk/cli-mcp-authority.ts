import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SidecarSessionAuthority } from '../sidecar-session-authority';

function removeOwnedAuthority(path: string, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    console.error('[CliMcp] Could not remove the owning compute authority receipt.');
  }
}

export function createCliMcpAuthorityReceipt(options: {
  directory: string;
  authority: SidecarSessionAuthority;
  getApiUrl: () => string;
}): { path: string; ownerId: string; dispose: () => void } {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(options.directory, 'host-'));
  const path = join(directory, 'session.json');
  const ownerId = randomUUID();
  const detach = options.authority.subscribe((snapshot) => {
    const temporary = join(directory, 'session.next');
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          version: 1,
          ownerId,
          apiUrl: options.getApiUrl(),
          generation: snapshot.generation,
          state: snapshot.state,
          sessionToken: snapshot.state === 'ready' ? snapshot.token : '',
        }),
        { mode: 0o600 }
      );
      renameSync(temporary, path);
    } catch {
      removeOwnedAuthority(path);
      console.error('[CliMcp] Could not publish the owning compute authority.');
    }
  });
  return {
    path,
    ownerId,
    dispose: () => {
      detach();
      removeOwnedAuthority(directory, true);
    },
  };
}
