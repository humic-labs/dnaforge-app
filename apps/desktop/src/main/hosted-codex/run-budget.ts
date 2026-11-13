export type RunBudgetCode =
  | 'provider_attempts_exhausted'
  | 'tokens_exhausted'
  | 'spend_exhausted'
  | 'tool_calls_exhausted'
  | 'mutations_exhausted'
  | 'parallel_effects_exhausted'
  | 'compactions_exhausted'
  | 'recoveries_exhausted'
  | 'deadline_exceeded'
  | 'clock_went_backwards'
  | 'uncountable_charge'
  | 'invalid_limit'
  | 'run_stopped';

export type RunStopReason = RunBudgetCode | 'user_stopped';

const TERMINAL_CODES: ReadonlySet<RunBudgetCode> = new Set([
  'provider_attempts_exhausted',
  'tokens_exhausted',
  'spend_exhausted',
  'compactions_exhausted',
  'recoveries_exhausted',
  'deadline_exceeded',
  'clock_went_backwards',
  'uncountable_charge',
]);

export class RunBudgetError extends Error {
  constructor(
    readonly code: RunBudgetCode,
    message: string
  ) {
    super(message);
    this.name = 'RunBudgetError';
  }
}

export interface RunBudgetLimits {
  readonly providerAttempts: number;
  readonly totalTokens: number;
  readonly spendMicros: number;
  readonly toolCalls: number;
  readonly mutations: number;
  readonly parallelEffects: number;
  readonly compactions: number;
  readonly recoveries: number;
  readonly deadlineMs: number;
}

export interface RunBudgetSnapshot {
  readonly providerAttempts: number;
  readonly tokens: number;
  readonly spendMicros: number;
  readonly toolCalls: number;
  readonly mutations: number;
  readonly compactions: number;
  readonly recoveries: number;
  readonly effectsInFlight: number;
  readonly stoppedReason: RunStopReason | null;
}

export interface EffectHold {
  release(): void;
}

export interface RunBudget {
  chargeProviderAttempt(): void;
  chargeTokens(amount: number): void;
  chargeSpendMicros(amount: number): void;
  chargeToolCall(): void;
  chargeMutation(): void;
  chargeCompaction(): void;
  chargeRecovery(): void;
  beginEffect(): EffectHold;
  stop(reason: RunStopReason): void;
  snapshot(): RunBudgetSnapshot;
}

export interface RunBudgetOptions {
  readonly limits: RunBudgetLimits;
  readonly now: () => number;
  readonly spent?: Readonly<Record<string, number>>;
}

const LIMIT_KEYS: readonly (keyof RunBudgetLimits)[] = [
  'providerAttempts',
  'totalTokens',
  'spendMicros',
  'toolCalls',
  'mutations',
  'parallelEffects',
  'compactions',
  'recoveries',
  'deadlineMs',
];

export function createRunBudget(options: RunBudgetOptions): RunBudget {
  for (const key of LIMIT_KEYS) {
    const value = options.limits[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RunBudgetError(
        'invalid_limit',
        `the run budget limit "${key}" must be a whole count, not ${String(value)}`
      );
    }
  }

  const limits = options.limits;
  const carried = options.spent ?? {};
  const from = (key: string): number => {
    const value = carried[key];
    return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? (value as number) : 0;
  };
  const counters = {
    providerAttempts: from('providerAttempts'),
    tokens: from('tokens'),
    spendMicros: from('spendMicros'),
    toolCalls: from('toolCalls'),
    mutations: from('mutations'),
    compactions: from('compactions'),
    recoveries: from('recoveries'),
    effectsInFlight: 0,
  };
  const startedAt = options.now();
  let lastSeenAt = startedAt;
  let stoppedReason: RunStopReason | null = null;

  function refuse(code: RunBudgetCode, message: string): never {
    if (TERMINAL_CODES.has(code)) stoppedReason ??= code;
    throw new RunBudgetError(code, message);
  }

  function admit(): void {
    if (stoppedReason !== null) {
      const code: RunBudgetCode = stoppedReason === 'user_stopped' ? 'run_stopped' : stoppedReason;
      refuse(code, `the run already stopped (${stoppedReason})`);
    }
    const at = options.now();
    if (at < lastSeenAt) {
      refuse('clock_went_backwards', 'the run clock moved backwards');
    }
    lastSeenAt = at;
    if (at - startedAt >= limits.deadlineMs) {
      refuse('deadline_exceeded', 'the run exceeded its deadline');
    }
  }

  function countable(amount: number): number {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      refuse(
        'uncountable_charge',
        `a run charge must be a whole non-negative count, not ${String(amount)}`
      );
    }
    return amount;
  }

  function chargeCounter(
    key: 'providerAttempts' | 'toolCalls' | 'mutations' | 'compactions' | 'recoveries',
    limit: number,
    code: RunBudgetCode,
    what: string
  ): void {
    admit();
    if (counters[key] + 1 > limit) refuse(code, `the run exhausted its ${what}`);
    counters[key] += 1;
  }

  function chargeAmount(
    key: 'tokens' | 'spendMicros',
    amount: number,
    limit: number,
    code: RunBudgetCode,
    what: string
  ): void {
    admit();
    const charge = countable(amount);
    const next = counters[key] + charge;
    if (!Number.isSafeInteger(next) || next > limit) {
      refuse(code, `the run exhausted its ${what}`);
    }
    counters[key] = next;
  }

  return {
    chargeProviderAttempt: () =>
      chargeCounter(
        'providerAttempts',
        limits.providerAttempts,
        'provider_attempts_exhausted',
        'provider attempts'
      ),
    chargeTokens: (amount) =>
      chargeAmount('tokens', amount, limits.totalTokens, 'tokens_exhausted', 'token budget'),
    chargeSpendMicros: (amount) =>
      chargeAmount('spendMicros', amount, limits.spendMicros, 'spend_exhausted', 'spend budget'),
    chargeToolCall: () =>
      chargeCounter('toolCalls', limits.toolCalls, 'tool_calls_exhausted', 'tool calls'),
    chargeMutation: () =>
      chargeCounter('mutations', limits.mutations, 'mutations_exhausted', 'mutations'),
    chargeCompaction: () =>
      chargeCounter('compactions', limits.compactions, 'compactions_exhausted', 'compactions'),
    chargeRecovery: () =>
      chargeCounter('recoveries', limits.recoveries, 'recoveries_exhausted', 'recoveries'),

    beginEffect: () => {
      admit();
      if (counters.effectsInFlight + 1 > limits.parallelEffects) {
        refuse('parallel_effects_exhausted', 'the run has too many effects applying at once');
      }
      counters.effectsInFlight += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          counters.effectsInFlight -= 1;
        },
      };
    },

    stop: (reason) => {
      stoppedReason ??= reason;
    },

    snapshot: () => ({ ...counters, stoppedReason }),
  };
}
