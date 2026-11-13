import { randomUUID } from 'node:crypto';
import type { ContributionPolicy, ContributionReceipt } from '@waypoint/hosted-ai-contract';
import type {
  HostedAiContributionGateRequest,
  HostedAiContributionGateResult,
} from '../shared/hosted-ai-gateway-ipc';
import type { HostedAiTurnIdentity } from './hosted-ai-turn-authority';
import { HostedContributionRefusal } from './hosted-contribution-error';

interface ContributionChallenge {
  readonly terms_version_id: string;
  readonly terms_content_sha256: string;
  readonly privacy_version_id: string;
  readonly privacy_content_sha256: string;
  readonly contribution_policy_generation: string;
}

interface HostedContributionSession {
  readonly accountId: string;
  readonly desktopSessionId: string;
}

interface HostedAiContributionGateDependencies {
  readonly getSession: () => Promise<HostedContributionSession | null>;
  readonly getPolicy: (session: HostedContributionSession) => Promise<ContributionPolicy>;
  readonly recordChoice: (
    session: HostedContributionSession,
    choice: 'joined' | 'withdrawn',
    idempotencyKey: string,
    challenge: ContributionChallenge
  ) => Promise<ContributionReceipt>;
  readonly idGenerator?: () => string;
  readonly issueTurnBinding?: (
    webContentsId: number,
    session: HostedContributionSession,
    identity: HostedAiTurnIdentity,
    workspacePath: string | null
  ) => string | Promise<string>;
  readonly revokeTurnBindings?: (session: HostedContributionSession) => void;
}

function remoteChallenge(policy: ContributionPolicy): ContributionChallenge {
  return {
    terms_version_id: policy.legal_challenge.terms_version_id,
    terms_content_sha256: policy.legal_challenge.terms_content_sha256,
    privacy_version_id: policy.legal_challenge.privacy_version_id,
    privacy_content_sha256: policy.legal_challenge.privacy_content_sha256,
    contribution_policy_generation: policy.contribution_policy_generation,
  };
}

function isGateRequest(value: unknown): value is HostedAiContributionGateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.surface === 'settings') {
    return (
      (Object.keys(candidate).length === 1 && candidate.choice === undefined) ||
      (Object.keys(candidate).length === 2 &&
        (candidate.choice === 'joined' || candidate.choice === 'withdrawn'))
    );
  }
  const validId = (item: unknown) =>
    typeof item === 'string' && item.length > 0 && item.length <= 256;
  return (
    candidate.surface === 'first_hosted_attempt' &&
    Object.keys(candidate).length === 5 &&
    validId(candidate.workflowId) &&
    validId(candidate.runId) &&
    validId(candidate.turnId) &&
    (candidate.workspacePath === null ||
      (typeof candidate.workspacePath === 'string' && candidate.workspacePath.length <= 4096))
  );
}

export class HostedAiContributionGate {
  private readonly pending = new Map<string, Promise<HostedAiContributionGateResult>>();

  private readonly settingsWrites = new Map<number, Promise<HostedAiContributionGateResult>>();

  constructor(private readonly deps: HostedAiContributionGateDependencies) {}

  async prepare(
    webContentsId: number,
    rawRequest: unknown
  ): Promise<HostedAiContributionGateResult> {
    if (!isGateRequest(rawRequest) || !Number.isSafeInteger(webContentsId) || webContentsId < 1) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted AI contribution request was invalid.',
      };
    }
    if (rawRequest.surface === 'settings' && rawRequest.choice) {
      const previous = this.settingsWrites.get(webContentsId);
      const operation = (async () => {
        if (previous) await previous;
        return this.prepareForSession(webContentsId, rawRequest);
      })().finally(() => {
        if (this.settingsWrites.get(webContentsId) === operation)
          this.settingsWrites.delete(webContentsId);
      });
      this.settingsWrites.set(webContentsId, operation);
      return operation;
    }
    if (rawRequest.surface === 'first_hosted_attempt') {
      const change = this.settingsWrites.get(webContentsId);
      if (change) {
        const result = await change;
        if (!result.ok) return result;
      }
    }
    return this.prepareForSession(webContentsId, rawRequest);
  }

  private async prepareForSession(
    webContentsId: number,
    rawRequest: HostedAiContributionGateRequest
  ): Promise<HostedAiContributionGateResult> {
    const session = await this.deps.getSession().catch(() => null);
    if (!session) {
      return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
    }
    const key =
      rawRequest.surface === 'first_hosted_attempt'
        ? `${webContentsId}:${session.accountId}:${session.desktopSessionId}:${rawRequest.surface}:${rawRequest.workflowId}:${rawRequest.runId}:${rawRequest.turnId}:${rawRequest.workspacePath ?? ''}`
        : `${webContentsId}:${session.accountId}:${session.desktopSessionId}:${rawRequest.surface}:${rawRequest.choice ?? 'read'}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.prepareOnce(webContentsId, session, rawRequest).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, operation);
    return operation;
  }

  private async prepareOnce(
    webContentsId: number,
    session: HostedContributionSession,
    request: HostedAiContributionGateRequest
  ): Promise<HostedAiContributionGateResult> {
    let policy: ContributionPolicy;
    try {
      policy = await this.readPolicyWithOneRetry(session);
    } catch {
      if (!(await this.sessionIsStillActive(session))) return this.accountChanged();
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI could not load the current contribution policy.',
      };
    }
    if (!(await this.sessionIsStillActive(session))) return this.accountChanged();
    if (request.surface === 'settings' && request.choice === undefined) {
      return { ok: true, started: false, policy, receipt: null, turnBindingToken: null };
    }
    if (request.surface === 'first_hosted_attempt') {
      if (policy.hosted_authorized) {
        return this.started(webContentsId, session, request, policy, null);
      }
      if (policy.hosted_unauthorized_reason === 'legal_acceptance_missing') {
        const refusal = new HostedContributionRefusal('legal_acceptance_missing');
        return { ok: false, code: refusal.code, message: refusal.message };
      }
      return {
        ok: false,
        code: 'gateway_unavailable',
        message:
          'DNAForge agent is unavailable for this account. Try again or choose another host.',
      };
    }
    const choice = request.choice;
    if (!choice)
      return { ok: false, code: 'invalid_request', message: 'Choose a contribution setting.' };
    if (choice === 'joined' && policy.hosted_unauthorized_reason === 'legal_acceptance_missing') {
      const refusal = new HostedContributionRefusal('legal_acceptance_missing');
      return { ok: false, code: refusal.code, message: refusal.message };
    }
    if (!policy.choice_offered) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Your account plan manages this setting.',
      };
    }
    if (
      policy.contribution_choice === choice &&
      (policy.account_plan_setting === 'research_contribution') === (choice === 'joined')
    ) {
      return { ok: true, started: false, policy, receipt: null, turnBindingToken: null };
    }
    try {
      const receipt = await this.deps.recordChoice(
        session,
        choice,
        this.deps.idGenerator?.() ?? randomUUID(),
        remoteChallenge(policy)
      );
      if (
        receipt.receipt_choice !== choice ||
        receipt.current_contribution_choice !== choice ||
        receipt.contribution_policy_generation !== policy.contribution_policy_generation ||
        receipt.contribution_choice_policy_generation !== policy.contribution_policy_generation
      )
        throw new Error('invalid_contribution_receipt');
      if (!(await this.sessionIsStillActive(session))) return this.accountChanged();
      if (choice === 'withdrawn') this.deps.revokeTurnBindings?.(session);
      const currentPolicy = await this.readPolicyWithOneRetry(session);
      if (!(await this.sessionIsStillActive(session))) return this.accountChanged();
      if (currentPolicy.contribution_choice !== choice)
        throw new Error('contribution_choice_changed');
      return { ok: true, started: false, policy: currentPolicy, receipt, turnBindingToken: null };
    } catch (error) {
      if (error instanceof HostedContributionRefusal) {
        return { ok: false, code: error.code, message: error.message };
      }
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge could not save your contribution setting. Try again.',
      };
    }
  }

  private async started(
    webContentsId: number,
    session: HostedContributionSession,
    request: Extract<HostedAiContributionGateRequest, { surface: 'first_hosted_attempt' }>,
    policy: ContributionPolicy,
    receipt: ContributionReceipt | null
  ): Promise<HostedAiContributionGateResult> {
    let turnBindingToken: string | undefined;
    try {
      turnBindingToken = await this.deps.issueTurnBinding?.(
        webContentsId,
        session,
        {
          workflowId: request.workflowId,
          runId: request.runId,
          turnId: request.turnId,
        },
        request.workspacePath
      );
    } catch {
      turnBindingToken = undefined;
    }
    if (!turnBindingToken) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI could not bind this turn to the signed-in session.',
      };
    }
    if (!(await this.sessionIsStillActive(session))) {
      this.deps.revokeTurnBindings?.(session);
      return this.accountChanged();
    }
    return { ok: true, started: true, policy, receipt, turnBindingToken };
  }

  private async sessionIsStillActive(expected: HostedContributionSession): Promise<boolean> {
    const active = await this.deps.getSession().catch(() => null);
    return (
      active?.accountId === expected.accountId &&
      active.desktopSessionId === expected.desktopSessionId
    );
  }

  private async readPolicyWithOneRetry(
    session: HostedContributionSession
  ): Promise<ContributionPolicy> {
    try {
      return await this.deps.getPolicy(session);
    } catch (firstError) {
      if (!(await this.sessionIsStillActive(session))) throw firstError;
      return this.deps.getPolicy(session);
    }
  }

  private accountChanged(): HostedAiContributionGateResult {
    return {
      ok: false,
      code: 'signed_out',
      message: 'The signed-in account changed before the contribution choice was recorded.',
    };
  }
}
