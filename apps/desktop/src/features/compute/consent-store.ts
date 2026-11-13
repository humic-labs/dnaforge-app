import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { create } from 'zustand';

export interface ComputeSessionBudget {
  maxJobs: number;
  maxCost: number;
}

export const DEFAULT_COMPUTE_SESSION_BUDGET: ComputeSessionBudget = { maxJobs: 10, maxCost: 10 };

interface ProviderSpend {
  confirmed: boolean;
  jobs: number;
  cost: number;
  confirmedAtJobs: number;
  confirmedAtCost: number;
}

export interface ComputeConsentState {
  budget: ComputeSessionBudget;
  spend: Record<string, ProviderSpend>;
  needsConfirmation(providerId: string, cost: number | null): boolean;
  recordConfirmation(providerId: string): void;
  recordSubmit(providerId: string, cost: number | null): void;
  setBudget(budget: ComputeSessionBudget): void;
  resetForTests(): void;
}

function emptySpend(): ProviderSpend {
  return { confirmed: false, jobs: 0, cost: 0, confirmedAtJobs: 0, confirmedAtCost: 0 };
}

export const useComputeConsentStore = create<ComputeConsentState>((set, get) => ({
  budget: DEFAULT_COMPUTE_SESSION_BUDGET,
  spend: {},

  needsConfirmation(providerId, cost) {
    const { budget } = get();
    const spend = get().spend[providerId] ?? emptySpend();
    if (!spend.confirmed) return true;
    const jobsSinceConfirm = spend.jobs - spend.confirmedAtJobs;
    const costSinceConfirm = spend.cost - spend.confirmedAtCost + (cost ?? 0);
    return jobsSinceConfirm >= budget.maxJobs || costSinceConfirm > budget.maxCost;
  },

  recordConfirmation(providerId) {
    set((state) => {
      const prev = state.spend[providerId] ?? emptySpend();
      return {
        spend: {
          ...state.spend,
          [providerId]: {
            ...prev,
            confirmed: true,
            confirmedAtJobs: prev.jobs,
            confirmedAtCost: prev.cost,
          },
        },
      };
    });
  },

  recordSubmit(providerId, cost) {
    set((state) => {
      const prev = state.spend[providerId] ?? emptySpend();
      return {
        spend: {
          ...state.spend,
          [providerId]: { ...prev, jobs: prev.jobs + 1, cost: prev.cost + (cost ?? 0) },
        },
      };
    });
  },

  setBudget(budget) {
    set({ budget });
  },

  resetForTests() {
    set({ budget: DEFAULT_COMPUTE_SESSION_BUDGET, spend: {} });
  },
}));

export function describeSubmission(
  settings: Record<string, unknown>,
  files: Record<string, string>
): UserMessage {
  let residues = 0;
  let sequenceFields = 0;
  const isSequenceKey = (key: string) => /seq|fasta|chain/i.test(key) && !/ids?$/i.test(key);
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (isSequenceKey(key)) {
        sequenceFields += 1;
        residues += value.replace(/[^A-Za-z]/g, '').length;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (
        typeof record.value === 'string' &&
        /^(protein|dna|rna)$/i.test(String(record.type ?? ''))
      ) {
        sequenceFields += 1;
        residues += record.value.replace(/[^A-Za-z]/g, '').length;
      }
      for (const [k, v] of Object.entries(record)) visit(v, k, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(settings)) visit(value, key, 0);
  return userMessageWithValues('compute.submissionSummary', {
    sequences: userMessageValue(sequenceFields),
    residues: userMessageValue(residues.toLocaleString()),
    files: userMessageValue(Object.keys(files).length),
    bytes: userMessageValue(
      Object.values(files)
        .reduce((n, text) => n + text.length, 0)
        .toLocaleString()
    ),
    settings: userMessageValue(Object.keys(settings).filter((key) => !isSequenceKey(key)).length),
  });
}

export function describeCost(amount: number | null, unit: string): UserMessage {
  if (amount === null) return userMessage('compute.costUnknown');
  const label =
    unit === 'weighted_hours'
      ? 'weighted hours'
      : unit === 'credits'
        ? 'credits'
        : unit === 'USD' || unit === 'usd'
          ? 'USD'
          : 'billing units';
  return userMessageWithValues('compute.costEstimate', {
    amount: userMessageValue(amount),
    unit: userMessageValue(label),
  });
}
