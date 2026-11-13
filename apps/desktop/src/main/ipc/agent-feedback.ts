import { app } from 'electron';
import { createHash } from 'node:crypto';
import { handleGroup } from '../../shared/ipc-contract';
import { agentFeedbackContract } from '../../shared/ipc/agent-feedback.contract';
import {
  agentFeedbackSchema,
  formatAgentFeedback,
  type AgentFeedbackInput,
  type AgentFeedbackResult,
} from '../../shared/agent-feedback';
import { getInstallId } from './feedback';

function reportIdFor(installId: string, observationId: string): string {
  const bytes = createHash('sha256')
    .update(`dnaforge-agent-feedback-v2\0${installId}\0${observationId.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x80;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sendAgentFeedback(
  input: AgentFeedbackInput,
  url: string,
  profile: string,
  version: string
): Promise<AgentFeedbackResult> {
  const parsed = agentFeedbackSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      code: 'INVALID_FEEDBACK',
      error: parsed.error.message,
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    };
  const message = formatAgentFeedback(parsed.data);
  const installId = getInstallId(profile);
  const reportId = reportIdFor(installId, parsed.data.observationId);
  const failure = (
    code: string,
    error: string,
    retriable: boolean,
    stateChanged: boolean | 'unknown',
    retryAfterSeconds?: number
  ): AgentFeedbackResult => ({
    ok: false,
    code,
    error,
    retriable,
    stateChanged,
    partialEffects: [],
    details: { reportId, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
  });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        message,
        report_id: reportId,
        install_id: installId,
        app_version: version,
        platform_info: `${process.platform} ${process.arch}`,
        user_agent: `DNAForge/${version} Agent`,
      }),
    });
    if (!response.ok) {
      const retry = Number(response.headers.get('Retry-After'));
      if (response.status === 429)
        return failure(
          'FEEDBACK_RATE_LIMITED',
          'Feedback intake is rate limited. Wait before retrying the same report.',
          true,
          false,
          Number.isFinite(retry) && retry > 0 ? retry : undefined
        );
      return failure(
        'FEEDBACK_REJECTED',
        `Feedback intake returned HTTP ${response.status}. No confirmed receipt was received.`,
        response.status >= 500 || response.status === 408,
        response.status >= 500 || response.status === 408 ? 'unknown' : false
      );
    }

    const invalidReceipt = () =>
      failure(
        'FEEDBACK_RECEIPT_INVALID',
        'The intake did not confirm this report ID. Delivery is unknown; do not repeat automatically. The intake must support report receipts.',
        false,
        'unknown'
      );
    let receipt: unknown;
    try {
      receipt = await response.json();
    } catch {
      return invalidReceipt();
    }
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      !('ok' in receipt) ||
      receipt.ok !== true ||
      !('report_id' in receipt) ||
      receipt.report_id !== reportId
    ) {
      return invalidReceipt();
    }
    return {
      ok: true,
      reportId,
      status: 'submitted',
      duplicate: 'duplicate' in receipt && receipt.duplicate === true,
    };
  } catch {
    return failure(
      'FEEDBACK_DELIVERY_FAILED',
      'No confirmed feedback receipt was received. Delivery may have occurred; retry the same observationId and evidence to avoid duplicates.',
      true,
      'unknown'
    );
  }
}

export function registerAgentFeedbackHandlers(): void {
  handleGroup(agentFeedbackContract, {
    report: async (_event, input) =>
      sendAgentFeedback(
        input,
        process.env['FEEDBACK_URL'] || 'https://dnaforge.com/api/feedback',
        app.getPath('userData'),
        app.getVersion()
      ),
  });
}
