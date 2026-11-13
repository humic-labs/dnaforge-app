import { create } from 'zustand';
import { parseContributionPolicy, type ContributionPolicy } from '@waypoint/hosted-ai-contract';
import { getHostedContributionSettings } from '../features/ai/hosted-contribution-client';
import type { DesktopPublicSession } from '../shared/auth-types';

const CACHE_KEY = 'dnaforge.hosted-research-preference.v1';
const contributing = (policy: ContributionPolicy) =>
  policy.account_plan_setting === 'research_contribution';

function cachedPolicy(accountId: string): ContributionPolicy | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    return cached?.accountId === accountId ? parseContributionPolicy(cached.policy) : null;
  } catch {
    return null;
  }
}
function remember(accountId: string, policy: ContributionPolicy) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ accountId, policy }));
  } catch {}
}

interface HostedContributionStore {
  sessionKey: string | null;
  policy: ContributionPolicy | null;
  enabled: boolean | null;
  saving: boolean;
  error: string | null;
  failedEnabled: boolean | null;
  setSession: (
    session: Pick<DesktopPublicSession, 'accountId' | 'desktopSessionId'> | null
  ) => void;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  retry: () => void;
  waitForSave: () => Promise<string | null>;
}

export const useHostedContributionStore = create<HostedContributionStore>((set, get) => {
  let sessionVersion = 0;
  let editVersion = 0;
  let accountId: string | null = null;
  let reading: Promise<void> | null = null;
  let writing: Promise<void> | null = null;

  const request = async (choice?: 'joined' | 'withdrawn') => {
    try {
      return await (choice
        ? getHostedContributionSettings(choice)
        : getHostedContributionSettings());
    } catch {
      return { ok: false as const, error: 'Could not update your research preference. Try again.' };
    }
  };

  const save = async () => {
    const version = sessionVersion;
    set({ saving: true });
    while (version === sessionVersion && accountId) {
      const { enabled, policy } = get();
      if (enabled === null || !policy || enabled === contributing(policy)) break;
      const result = await request(enabled ? 'joined' : 'withdrawn');
      if (version !== sessionVersion) return;
      if (!result.ok) {
        const latest = get().enabled;
        const confirmed = contributing(policy);
        set({
          enabled: confirmed,
          saving: false,
          error: latest === confirmed ? null : result.error,
          failedEnabled: latest === confirmed ? null : latest,
        });
        return;
      }
      remember(accountId, result.policy);
      set({ policy: result.policy });
      if (contributing(result.policy) !== enabled) {
        set({
          enabled: contributing(result.policy),
          saving: false,
          failedEnabled: enabled,
          error: result.policy.choice_offered
            ? 'Could not save this change. Try again.'
            : 'Your account plan manages this setting.',
        });
        return;
      }
    }
    if (version === sessionVersion) set({ saving: false });
  };

  return {
    sessionKey: null,
    policy: null,
    enabled: null,
    saving: false,
    error: null,
    failedEnabled: null,
    setSession: (session) => {
      const key = session ? `${session.accountId}:${session.desktopSessionId}` : null;
      if (key === get().sessionKey) return;
      ++sessionVersion;
      ++editVersion;
      reading = null;
      writing = null;
      accountId = session?.accountId ?? null;
      const policy = accountId ? cachedPolicy(accountId) : null;
      if (!session) {
        try {
          localStorage.removeItem(CACHE_KEY);
        } catch {}
      }
      set({
        sessionKey: key,
        policy,
        enabled: policy ? contributing(policy) : null,
        saving: false,
        error: null,
        failedEnabled: null,
      });
      if (session) void get().refresh();
    },
    refresh: () => {
      const currentAccount = accountId;
      if (!currentAccount || get().saving) return Promise.resolve();
      if (reading) return reading;
      const version = sessionVersion;
      const edit = editVersion;
      const operation = (async () => {
        const result = await request();
        if (version !== sessionVersion || edit !== editVersion || get().saving) return;
        if (result.ok) {
          remember(currentAccount, result.policy);
          const failed = get().failedEnabled;
          const unresolved = failed !== null && failed !== contributing(result.policy);
          set({
            policy: result.policy,
            enabled: contributing(result.policy),
            error: unresolved ? get().error : null,
            failedEnabled: unresolved ? failed : null,
          });
        } else if (!get().policy) set({ error: result.error });
      })().finally(() => {
        if (reading === operation) reading = null;
      });
      reading = operation;
      return operation;
    },
    setEnabled: (enabled) => {
      if (!get().policy?.choice_offered || !accountId) return;
      ++editVersion;
      set({ enabled, error: null, failedEnabled: null });
      if (!get().saving) {
        const operation = save().finally(() => {
          if (writing === operation) writing = null;
        });
        writing = operation;
      }
    },
    waitForSave: async () => {
      while (writing) await writing;
      return get().failedEnabled === null ? null : get().error;
    },
    retry: () => {
      const enabled = get().failedEnabled;
      if (enabled !== null) get().setEnabled(enabled);
      else void get().refresh();
    },
  };
});
