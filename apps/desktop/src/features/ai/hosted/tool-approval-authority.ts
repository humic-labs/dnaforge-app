export interface HostedToolApprovalRegistration {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly ticket: string;
  readonly requiresUserApproval: boolean;
  readonly expiresAt: string;
}

export interface HostedToolApprovalDecision {
  readonly requiresUserApproval: boolean;
  assertUsable(input: unknown): Promise<void>;
  claimMutation(approvalReceiptRef: string): Promise<{ readonly claimId: string }>;
  completeMutation(effectReceiptRef: string): Promise<void>;
  cancelMutation(
    reason: 'stopped_before_effect' | 'user_declined_before_effect' | 'pre_effect_failure'
  ): Promise<void>;
  recordObservation(observationPayload: Record<string, unknown>): Promise<void>;
}

export interface HostedToolApprovalAuthorityOptions {
  readonly now?: () => number;
  readonly normalizeInput?: (toolName: string, input: unknown) => unknown;
  readonly assertTurnBinding?: () => Promise<void>;
  readonly recordObservation?: (
    registration: HostedToolApprovalRegistration,
    observationPayload: Record<string, unknown>,
    claimId?: string
  ) => Promise<{ readonly providerCallId: string; readonly toolName: string }>;
  readonly claimMutation?: (
    registration: HostedToolApprovalRegistration,
    approvalReceiptRef: string,
    idempotencyKey: string
  ) => Promise<{
    readonly claimId: string;
    readonly status: 'claimed' | 'completed' | 'canceled' | 'expired';
    readonly toolName: string;
    readonly alreadyApplied: boolean;
  }>;
  readonly completeMutation?: (
    registration: HostedToolApprovalRegistration,
    claimId: string,
    idempotencyKey: string,
    effectReceiptRef: string
  ) => Promise<{ readonly status: 'claimed' | 'completed' | 'canceled' | 'expired' }>;
  readonly cancelMutation?: (
    registration: HostedToolApprovalRegistration,
    claimId: string,
    idempotencyKey: string,
    reason: 'stopped_before_effect' | 'user_declined_before_effect' | 'pre_effect_failure'
  ) => Promise<{ readonly status: 'claimed' | 'completed' | 'canceled' | 'expired' }>;
}

export interface HostedToolApprovalAuthority {
  acceptCatalogVersion(catalogVersion: string): void;
  register(registration: HostedToolApprovalRegistration): void;
  consume(toolCallId: string, toolName: string, input: unknown): HostedToolApprovalDecision;
  completedMutationClaimId(toolCallId: string): string | undefined;
}

function canonicalJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Hosted tool arguments are not valid JSON.');
  }
  if (typeof serialized !== 'string') {
    throw new Error('Hosted tool arguments are not valid JSON.');
  }
  const parsed: unknown = JSON.parse(serialized);
  const stable = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`;
    if (item !== null && typeof item === 'object') {
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return stable(parsed);
}

export function createHostedToolApprovalAuthority({
  now = Date.now,
  normalizeInput = (_toolName, input) => input,
  assertTurnBinding = async () => {},
  recordObservation: submitObservation = async () => {
    throw new Error('Hosted tool observation transport is unavailable.');
  },
  claimMutation: submitClaim = async () => {
    throw new Error('Hosted mutation claim transport is unavailable.');
  },
  completeMutation: submitCompletion = async () => {
    throw new Error('Hosted mutation completion transport is unavailable.');
  },
  cancelMutation: submitCancellation = async () => {
    throw new Error('Hosted mutation cancellation transport is unavailable.');
  },
}: HostedToolApprovalAuthorityOptions = {}): HostedToolApprovalAuthority {
  const pending = new Map<
    string,
    {
      readonly registration: HostedToolApprovalRegistration;
      readonly canonicalInput: string;
    }
  >();
  const seenToolCallIds = new Set<string>();
  const completedMutationClaims = new Map<string, string>();
  let acceptedCatalogVersion: string | undefined;

  return {
    acceptCatalogVersion(catalogVersion) {
      if (acceptedCatalogVersion === undefined) {
        acceptedCatalogVersion = catalogVersion;
        return;
      }
      if (acceptedCatalogVersion !== catalogVersion) {
        throw new Error('The Hosted gateway catalog changed during this turn.');
      }
    },

    register(registration) {
      const expiresAt = Date.parse(registration.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        throw new Error(`Invalid Hosted tool approval ticket expiry: ${registration.toolCallId}.`);
      }
      if (expiresAt <= now()) {
        throw new Error(`Hosted tool approval ticket has expired: ${registration.toolCallId}.`);
      }
      if (seenToolCallIds.has(registration.toolCallId)) {
        throw new Error(`Duplicate Hosted tool approval ticket: ${registration.toolCallId}.`);
      }
      if (!registration.ticket || registration.ticket.length > 4096) {
        throw new Error(`Invalid Hosted tool approval ticket: ${registration.toolCallId}.`);
      }
      const canonicalInput = canonicalJson(
        normalizeInput(registration.toolName, registration.input)
      );
      seenToolCallIds.add(registration.toolCallId);
      pending.set(registration.toolCallId, {
        registration: { ...registration },
        canonicalInput,
      });
    },

    consume(toolCallId, toolName, input) {
      const pendingApproval = pending.get(toolCallId);
      if (!pendingApproval) {
        throw new Error(`Missing Hosted tool approval ticket: ${toolCallId}.`);
      }
      pending.delete(toolCallId);
      const { registration, canonicalInput: registeredInput } = pendingApproval;
      if (registration.toolName !== toolName) {
        throw new Error(`Hosted tool approval ticket ${toolCallId} does not match ${toolName}.`);
      }
      let recordedObservation: string | undefined;
      let recordPromise: Promise<void> | undefined;
      const mutationIdempotencyKey = `tool-claim:${toolCallId}`;
      let mutationClaimId: string | undefined;
      const assertUsable = async (candidateInput: unknown) => {
        if (
          canonicalJson(normalizeInput(registration.toolName, candidateInput)) !== registeredInput
        ) {
          throw new Error(`Hosted tool approval ticket ${toolCallId} arguments do not match.`);
        }
        if (Date.parse(registration.expiresAt) <= now()) {
          throw new Error(`Hosted tool approval ticket has expired: ${toolCallId}.`);
        }
        await assertTurnBinding();
      };
      if (canonicalJson(normalizeInput(registration.toolName, input)) !== registeredInput) {
        throw new Error(`Hosted tool approval ticket ${toolCallId} arguments do not match.`);
      }
      if (Date.parse(registration.expiresAt) <= now()) {
        throw new Error(`Hosted tool approval ticket has expired: ${toolCallId}.`);
      }
      return {
        requiresUserApproval: registration.requiresUserApproval,
        assertUsable,
        async claimMutation(approvalReceiptRef) {
          await assertUsable(input);
          if (!approvalReceiptRef.trim() || approvalReceiptRef.length > 256) {
            throw new Error(`Hosted mutation approval receipt ${toolCallId} is invalid.`);
          }
          const claim = await submitClaim(registration, approvalReceiptRef, mutationIdempotencyKey);
          if (
            claim.toolName !== registration.toolName ||
            claim.status !== 'claimed' ||
            claim.alreadyApplied
          ) {
            throw new Error(`Hosted mutation claim ${toolCallId} does not authorize execution.`);
          }
          mutationClaimId = claim.claimId;
          return { claimId: claim.claimId };
        },
        async completeMutation(effectReceiptRef) {
          if (!mutationClaimId) throw new Error(`Hosted mutation claim ${toolCallId} is missing.`);
          if (!effectReceiptRef.trim() || effectReceiptRef.length > 256) {
            throw new Error(`Hosted mutation effect receipt ${toolCallId} is invalid.`);
          }
          const completed = await submitCompletion(
            registration,
            mutationClaimId,
            mutationIdempotencyKey,
            effectReceiptRef
          );
          if (completed.status !== 'completed') {
            throw new Error(`Hosted mutation claim ${toolCallId} did not complete.`);
          }
          completedMutationClaims.set(toolCallId, mutationClaimId);
        },
        async cancelMutation(reason) {
          if (!mutationClaimId) return;
          const canceled = await submitCancellation(
            registration,
            mutationClaimId,
            mutationIdempotencyKey,
            reason
          );
          if (canceled.status !== 'canceled') {
            throw new Error(`Hosted mutation claim ${toolCallId} could not be canceled safely.`);
          }
          mutationClaimId = undefined;
        },
        recordObservation(observationPayload) {
          const canonicalObservation = canonicalJson(observationPayload);
          if (recordedObservation !== undefined && recordedObservation !== canonicalObservation) {
            return Promise.reject(
              new Error(`Hosted tool observation ${toolCallId} does not match its first receipt.`)
            );
          }
          recordedObservation = canonicalObservation;
          if (recordPromise) return recordPromise;
          recordPromise = (
            mutationClaimId
              ? submitObservation(registration, observationPayload, mutationClaimId)
              : submitObservation(registration, observationPayload)
          )
            .then((receipt) => {
              if (
                receipt.providerCallId !== registration.toolCallId ||
                receipt.toolName !== registration.toolName
              ) {
                throw new Error(`Hosted tool observation receipt ${toolCallId} does not match.`);
              }
            })
            .catch((error) => {
              recordPromise = undefined;
              throw error;
            });
          return recordPromise;
        },
      };
    },
    completedMutationClaimId(toolCallId) {
      return completedMutationClaims.get(toolCallId);
    },
  };
}
