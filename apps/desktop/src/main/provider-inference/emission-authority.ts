import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface Emission {
  run<T>(effect: () => T): T;
}

export type EmissionAdmission =
  | { readonly kind: 'admitted'; readonly emission: Emission }
  | {
      readonly kind: 'refused';
      readonly code: 'invalid-request' | 'duplicate' | 'exhausted' | 'closed';
    };

export interface OrdinaryEmissionAuthority {
  readonly kind: 'ordinary';
  admit(input: { readonly requestId: string }): EmissionAdmission;
  close(): void;
}

export interface BoundedEmissionAuthority {
  readonly kind: 'bounded';
  admit(input: { readonly requestId: string; readonly maximumMicrousd: number }): EmissionAdmission;
  close(): void;
}

export interface ReservedInferenceTranche {
  readonly reservationId: string;
  readonly heldMicrousd: number;
  readonly sourceBinding: string;
  readonly runtimeBinding: string;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function positiveMicrousd(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validBinding(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function createAdmissionOwner(initial: number | null) {
  let remaining = initial;
  let closed = false;
  const requests = new Set<string>();

  return {
    admit(requestId: string, maximumMicrousd: number): EmissionAdmission {
      if (closed) return { kind: 'refused', code: 'closed' };
      if (!validId(requestId) || (remaining !== null && !positiveMicrousd(maximumMicrousd))) {
        return { kind: 'refused', code: 'invalid-request' };
      }
      if (requests.has(requestId)) return { kind: 'refused', code: 'duplicate' };
      requests.add(requestId);
      if (remaining !== null) {
        if (maximumMicrousd > remaining) return { kind: 'refused', code: 'exhausted' };
        remaining -= maximumMicrousd;
      }
      let consumed = false;
      const emission: Emission = Object.freeze({
        run<T>(effect: () => T): T {
          if (closed || consumed) throw new Error('Emission is no longer available');
          consumed = true;
          return effect();
        },
      });
      return { kind: 'admitted', emission };
    },
    close(): void {
      closed = true;
    },
  };
}

export function createOrdinaryEmissionAuthority(): OrdinaryEmissionAuthority {
  const owner = createAdmissionOwner(null);
  return Object.freeze({
    kind: 'ordinary',
    admit: ({ requestId }: { readonly requestId: string }) => owner.admit(requestId, 0),
    close: owner.close,
  });
}

export async function activateBoundedEmissionAuthority(input: {
  readonly storeRoot: string;
  readonly grant: ReservedInferenceTranche;
}): Promise<BoundedEmissionAuthority> {
  const { storeRoot } = input;
  const grant: ReservedInferenceTranche = {
    reservationId: input.grant.reservationId,
    heldMicrousd: input.grant.heldMicrousd,
    sourceBinding: input.grant.sourceBinding,
    runtimeBinding: input.grant.runtimeBinding,
  };
  if (
    !validId(grant.reservationId) ||
    !positiveMicrousd(grant.heldMicrousd) ||
    !validBinding(grant.sourceBinding) ||
    !validBinding(grant.runtimeBinding)
  ) {
    throw new Error('Invalid reserved inference tranche');
  }
  if (
    typeof storeRoot !== 'string' ||
    !isAbsolute(storeRoot) ||
    resolve(storeRoot) !== storeRoot ||
    typeof process.getuid !== 'function'
  ) {
    throw new Error('A canonical private POSIX authority store is required');
  }
  const root = await lstat(storeRoot);
  if (
    !root.isDirectory() ||
    root.uid !== process.getuid() ||
    (root.mode & 0o077) !== 0 ||
    (await realpath(storeRoot)) !== storeRoot
  ) {
    throw new Error('Untrusted inference authority store');
  }
  const directory = await open(
    storeRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const digest = createHash('sha256').update(grant.reservationId).digest('hex');
    const marker = await open(
      join(storeRoot, `${digest}.json`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await marker.writeFile(`${JSON.stringify({ schemaVersion: 1, ...grant })}\n`, 'utf8');
      await marker.sync();
    } finally {
      await marker.close();
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
  const owner = createAdmissionOwner(grant.heldMicrousd);
  return Object.freeze({
    kind: 'bounded',
    admit: ({
      requestId,
      maximumMicrousd,
    }: {
      readonly requestId: string;
      readonly maximumMicrousd: number;
    }) => owner.admit(requestId, maximumMicrousd),
    close: owner.close,
  });
}
