import { createHash } from 'node:crypto';

import {
  GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE,
  genomeSourceCredentialSummary,
  parseGenomeSourceAuthRef,
  parseGenomeSourceCredential,
  type GenomeSourceCredentialInput,
  type GenomeSourceCredentialRemovalResult,
  type GenomeSourceCredentialStatus,
  type GenomeSourceCredentialSummary,
} from '../shared/genome-source-credentials';
import { handleGroup } from '../shared/ipc-contract';
import type { SidecarFetch } from './sidecar-request-auth';
import { deleteCredential, hasCredential, readCredential, writeCredential } from './ipc/keyring';
import { genomeCredentialsContract } from '../shared/ipc/genome-credentials.contract';

interface GenomeSourceCredentialHandlerDeps {
  readonly sidecarFetch: SidecarFetch;
  readonly hasStored?: typeof hasCredential;
  readonly readStored?: typeof readCredential;
  readonly writeStored?: typeof writeCredential;
  readonly deleteStored?: typeof deleteCredential;
}

function credentialAccount(authRef: string): string {
  return `source-${createHash('sha256').update(authRef, 'utf8').digest('hex')}`;
}

function registrationWire(credential: GenomeSourceCredentialInput): {
  readonly auth_ref: string;
  readonly kind: GenomeSourceCredentialInput['kind'];
  readonly material: Readonly<Record<string, string>>;
} {
  switch (credential.kind) {
    case 'http-bearer':
      return {
        auth_ref: credential.authRef,
        kind: credential.kind,
        material: { token: credential.token },
      };
    case 'http-basic':
      return {
        auth_ref: credential.authRef,
        kind: credential.kind,
        material: { username: credential.username, password: credential.password },
      };
    case 'http-header':
      return {
        auth_ref: credential.authRef,
        kind: credential.kind,
        material: { name: credential.headerName, value: credential.headerValue },
      };
    case 'aws-sigv4':
      return {
        auth_ref: credential.authRef,
        kind: credential.kind,
        material: {
          access_key_id: credential.accessKeyId,
          secret_access_key: credential.secretAccessKey,
          ...(credential.sessionToken ? { session_token: credential.sessionToken } : {}),
        },
      };
    case 'gcs-oauth':
      return {
        auth_ref: credential.authRef,
        kind: credential.kind,
        material: { access_token: credential.accessToken },
      };
  }
}

export function createGenomeSourceCredentialHandlers(deps: GenomeSourceCredentialHandlerDeps) {
  const hasStored = deps.hasStored ?? hasCredential;
  const readStored = deps.readStored ?? readCredential;
  const writeStored = deps.writeStored ?? writeCredential;
  const deleteStored = deps.deleteStored ?? deleteCredential;

  async function save(value: unknown): Promise<GenomeSourceCredentialSummary> {
    const credential = parseGenomeSourceCredential(value);
    await writeStored(
      GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE,
      credentialAccount(credential.authRef),
      JSON.stringify(credential)
    );
    return genomeSourceCredentialSummary(credential);
  }

  async function status(authRefValue: unknown): Promise<GenomeSourceCredentialStatus> {
    const authRef = parseGenomeSourceAuthRef(authRefValue);
    return {
      authRef,
      connected: await hasStored(
        GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE,
        credentialAccount(authRef)
      ),
    };
  }

  async function prepare(authRefValue: unknown): Promise<GenomeSourceCredentialSummary> {
    const authRef = parseGenomeSourceAuthRef(authRefValue);
    const serialized = await readStored(
      GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE,
      credentialAccount(authRef)
    );
    if (!serialized) throw new Error(`No credential is stored for ${authRef}.`);
    let raw: unknown;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new Error(`The stored credential for ${authRef} is unreadable.`);
    }
    const credential = parseGenomeSourceCredential(raw);
    if (credential.authRef !== authRef) {
      throw new Error(`The stored credential for ${authRef} has the wrong identity.`);
    }
    const response = await deps.sidecarFetch('/external/credential-broker/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationWire(credential)),
    });
    if (!response.ok) {
      throw new Error(`Could not prepare ${authRef} (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { auth_ref?: unknown; kind?: unknown };
    if (body.auth_ref !== authRef || body.kind !== credential.kind) {
      throw new Error(`The credential broker returned an invalid receipt for ${authRef}.`);
    }
    return genomeSourceCredentialSummary(credential);
  }

  async function remove(authRefValue: unknown): Promise<GenomeSourceCredentialRemovalResult> {
    const authRef = parseGenomeSourceAuthRef(authRefValue);
    const account = credentialAccount(authRef);
    const existed = await hasStored(GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE, account);
    try {
      await deps.sidecarFetch('/external/credential-broker/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_ref: authRef }),
      });
    } catch {}
    await deleteStored(GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE, account);
    return { authRef, removed: existed };
  }

  return { save, status, prepare, remove };
}

export function registerGenomeSourceCredentialHandlers(
  deps: GenomeSourceCredentialHandlerDeps
): void {
  const handlers = createGenomeSourceCredentialHandlers(deps);
  handleGroup(genomeCredentialsContract, {
    save: (_event, input: GenomeSourceCredentialInput) => handlers.save(input),
    status: (_event, authRef: string) => handlers.status(authRef),
    prepare: (_event, authRef: string) => handlers.prepare(authRef),
    remove: (_event, authRef: string) => handlers.remove(authRef),
  });
}
