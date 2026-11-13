import {
  classifyInternalOperator,
  type AnalyticsIdentityContext,
} from '@waypoint/analytics-policy';
import type { DesktopAuthState } from '../shared/auth-types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnalyticsOperatorTraits = Readonly<{
  internal_operator?: NonNullable<ReturnType<typeof classifyInternalOperator>>;
}>;

export interface RendererAnalyticsIdentitySdk {
  getDistinctId(): string;
  getSessionId(): string;
  identify(accountId: string, traits?: AnalyticsOperatorTraits): void;
  reset(resetDeviceId: boolean): void;
  optIn(): void;
}

export interface RendererAnalyticsIdentityCoordinatorOptions {
  sdk: RendererAnalyticsIdentitySdk;
  syncContext(
    context: AnalyticsIdentityContext
  ): Promise<{ accepted: boolean }> | { accepted: boolean };
  isConsentEnabled?: () => boolean;
  rendererInstanceId?: string;
  initialAccountId?: string | null;
  onAccountIdentified?: (accountId: string) => void;
  onIdentityCleared?: () => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  identifyTimeoutMs?: number;
  identifyPollMs?: number;
  onTransitionStarted?: (generation: number) => void;
}

export class RendererAnalyticsIdentityCoordinator {
  private readonly sdk: RendererAnalyticsIdentitySdk;
  private readonly sync: RendererAnalyticsIdentityCoordinatorOptions['syncContext'];
  private readonly isConsentEnabled: () => boolean;
  private readonly rendererInstanceId: string;
  private readonly onAccountIdentified: (accountId: string) => void;
  private readonly onIdentityCleared: () => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly identifyTimeoutMs: number;
  private readonly identifyPollMs: number;
  private generation = 0;
  private transitionEpoch = 0;
  private currentKind: AnalyticsIdentityContext['kind'] | null = null;
  private currentAccountId: string | null = null;
  private pendingAccountId: string | null = null;
  private readonly onTransitionStarted?: (generation: number) => void;

  constructor(options: RendererAnalyticsIdentityCoordinatorOptions) {
    this.sdk = options.sdk;
    this.sync = options.syncContext;
    this.isConsentEnabled = options.isConsentEnabled ?? (() => true);
    this.rendererInstanceId = options.rendererInstanceId ?? crypto.randomUUID();
    this.onAccountIdentified = options.onAccountIdentified ?? (() => {});
    this.onIdentityCleared = options.onIdentityCleared ?? (() => {});
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.identifyTimeoutMs = options.identifyTimeoutMs ?? 5_000;
    this.identifyPollMs = options.identifyPollMs ?? 25;
    this.onTransitionStarted = options.onTransitionStarted;
    if (isUuid(options.initialAccountId)) {
      this.currentKind = 'identified';
      this.currentAccountId = options.initialAccountId;
    }
  }

  async applyAuthState(state: DesktopAuthState): Promise<boolean> {
    const epoch = ++this.transitionEpoch;
    this.onTransitionStarted?.(epoch);

    if (state.status === 'signed-in') {
      const accountId = state.session.accountId;
      if (!isUuid(accountId)) return false;

      if (this.currentAccountId && this.currentAccountId !== accountId) {
        this.rotateAnonymousIdentity();
      }

      this.pendingAccountId = accountId;
      if (
        this.currentAccountId !== accountId ||
        this.currentKind !== 'identified' ||
        this.sdk.getDistinctId() !== accountId
      ) {
        const operator = classifyInternalOperator(state.session.email);
        this.sdk.identify(accountId, operator ? { internal_operator: operator } : {});
      }
      if (this.sdk.getDistinctId() !== accountId) {
        const bound = await this.waitUntilDistinctId(accountId, epoch);
        if (!bound) {
          if (this.pendingAccountId === accountId) this.pendingAccountId = null;
          return false;
        }
      }
      this.pendingAccountId = null;
      this.currentAccountId = accountId;
      this.currentKind = 'identified';
      this.onAccountIdentified(accountId);
      return this.publish('identified', epoch);
    }

    if (!isHydrationTerminal(state)) return false;

    if (
      this.currentKind === 'identified' ||
      this.currentAccountId !== null ||
      this.pendingAccountId !== null
    ) {
      this.rotateAnonymousIdentity();
    }
    this.pendingAccountId = null;
    this.currentAccountId = null;
    this.currentKind = 'anonymous';
    this.onIdentityCleared();
    return this.publish('anonymous', epoch);
  }

  private rotateAnonymousIdentity(): void {
    this.sdk.reset(true);
    if (this.isConsentEnabled()) this.sdk.optIn();
  }

  private async waitUntilDistinctId(accountId: string, epoch: number): Promise<boolean> {
    const deadline = this.now() + this.identifyTimeoutMs;
    while (epoch === this.transitionEpoch) {
      if (this.sdk.getDistinctId() === accountId) return true;
      if (this.now() >= deadline) return false;
      await this.wait(this.identifyPollMs);
    }
    return false;
  }

  private async publish(kind: 'anonymous' | 'identified', epoch: number): Promise<boolean> {
    const distinctId = this.sdk.getDistinctId();
    const sessionId = this.sdk.getSessionId();
    if (!isUuid(distinctId) || !isUuid(sessionId)) return false;

    const context: AnalyticsIdentityContext = {
      distinctId,
      sessionId,
      kind,
      generation: ++this.generation,
      rendererInstanceId: this.rendererInstanceId,
    };

    if (epoch !== this.transitionEpoch) return false;
    return (await this.sync(context)).accepted;
  }
}

function isHydrationTerminal(state: DesktopAuthState): boolean {
  return (
    state.status === 'signed-out' || state.status === 'error' || state.status === 'unavailable'
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
