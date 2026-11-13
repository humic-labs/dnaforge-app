import { sanitizePrimerArtifactStem, sha256Hex } from './primers/primer-artifact';

export type LegacyPrimerLibraryRecoveryResult =
  | { status: 'empty' }
  | {
      status: 'complete' | 'pending';
      operationId: string;
      workspaceRoot: string;
      workspaceUuid: string;
      recovered: number;
      total: number;
      errors: Array<{ primerId: string; message: string }>;
    };

export async function legacyPrimerRecoveryArtifactStem(name: string, id: string): Promise<string> {
  let title = Array.from(sanitizePrimerArtifactStem(name)).slice(0, 80).join('');
  while (new TextEncoder().encode(title).length > 80)
    title = Array.from(title).slice(0, -1).join('');
  const identity =
    id.length <= 128 &&
    new TextEncoder().encode(id).length <= 128 &&
    sanitizePrimerArtifactStem(id) === id
      ? id
      : await sha256Hex(id);
  return `${title}-${identity}`;
}
