import type { HostedContributionRefusalCode } from '../shared/hosted-ai-gateway-ipc';
import {
  projectHostedCodexError,
  type HostedCodexVisibleErrorCode,
} from './hosted-codex/user-visible-projection';

export const CONTRIBUTION_REFUSAL_PRESENTATIONS = {
  legal_acceptance_missing: 'HOSTED_LEGAL_ACCEPTANCE_REQUIRED',
  contribution_policy_stale: 'HOSTED_CONTRIBUTION_POLICY_CHANGED',
  contribution_choice_rejected: 'HOSTED_CONTRIBUTION_CHOICE_REJECTED',
} satisfies Record<HostedContributionRefusalCode, HostedCodexVisibleErrorCode>;

export class HostedContributionRefusal extends Error {
  constructor(readonly code: HostedContributionRefusalCode) {
    super(projectHostedCodexError(CONTRIBUTION_REFUSAL_PRESENTATIONS[code]).message);
    this.name = 'HostedContributionRefusal';
  }
}

export function contributionRefusalFromBody(body: unknown): HostedContributionRefusal {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    if (body.error === 'legal_acceptance_missing' || body.error === 'contribution_policy_stale') {
      return new HostedContributionRefusal(body.error);
    }
  }
  return new HostedContributionRefusal('contribution_choice_rejected');
}
