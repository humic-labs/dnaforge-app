import type { HostedAiBridge } from '../../shared/hosted-ai-bridge';
import { hostedBrowserAiBridge } from '../../hosted/ai-bridge';
import { isHostedBrowserRuntime } from '../../utils/environment';

export function hostedAiBridge(): HostedAiBridge | null {
  if (isHostedBrowserRuntime()) return hostedBrowserAiBridge;
  return typeof window === 'undefined'
    ? null
    : ((window as Window & { electronAPI?: { hostedAi?: HostedAiBridge } }).electronAPI?.hostedAi ??
        null);
}

export type HostedContributionSettingsResult =
  | {
      readonly ok: true;
      readonly policy: import('@waypoint/hosted-ai-contract').ContributionPolicy;
    }
  | { readonly ok: false; readonly error: string };

export async function getHostedContributionSettings(
  choice?: 'joined' | 'withdrawn'
): Promise<HostedContributionSettingsResult> {
  const hostedAi = hostedAiBridge();
  if (!hostedAi) return { ok: false, error: 'DNAForge agent is unavailable in this environment.' };
  try {
    const result = await hostedAi.prepareContribution(
      choice ? { surface: 'settings', choice } : { surface: 'settings' }
    );
    return result.ok ? { ok: true, policy: result.policy } : { ok: false, error: result.message };
  } catch {
    return { ok: false, error: 'DNAForge could not load your contribution setting. Try again.' };
  }
}
