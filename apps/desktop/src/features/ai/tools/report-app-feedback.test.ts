import { describe, expect, it, vi } from 'vitest';
import { agentFeedbackSchema, formatAgentFeedback } from '../../../shared/agent-feedback';
import { createReportAppFeedbackTool } from './report-app-feedback';

const report = vi.fn();
vi.mock('../../../platform', () => ({ platform: () => ({ feedback: { report } }) }));

describe('report_app_feedback', () => {
  it('accepts minimal feedback without a workspace and forwards the receipt', async () => {
    const input = agentFeedbackSchema.parse({
      observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a', kind: 'feedback',
      summary: 'Improve tool errors',
      description: 'Include a useful recovery action.',
    });
    const receipt = { ok: true, reportId: 'receipt', status: 'submitted', duplicate: false };
    report.mockResolvedValue(receipt);
    const tool = createReportAppFeedbackTool();
    expect(await tool.execute!(input, { toolCallId: 'feedback', messages: [] })).toEqual(receipt);
    expect(report).toHaveBeenCalledWith(input);
  });
  it('requires observed and expected behavior for bugs', () => {
    expect(
      agentFeedbackSchema.safeParse({
        observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a', kind: 'bug',
        summary: 'Failed action',
        description: 'Action failed',
      }).success
    ).toBe(false);
  });
  it('bounds the complete report and rejects extra automatic context', () => {
    const input = { observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a', kind: 'feedback', summary: 'Title', description: 'x'.repeat(1200) };
    expect(
      agentFeedbackSchema.safeParse({
        ...input,
        impact: 'x'.repeat(300),
        workaround: 'x'.repeat(300),
        suspectedCause: 'x'.repeat(300),
      }).success
    ).toBe(false);
    expect(
      agentFeedbackSchema.safeParse({ ...input, conversation: 'private conversation' }).success
    ).toBe(false);
  });
  it('keeps hypotheses distinct from observed evidence', () => {
    const input = agentFeedbackSchema.parse({
      observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a', kind: 'bug',
      summary: 'Failed action',
      description: 'Action failed',
      expected: 'Success',
      actual: 'Error',
      suspectedCause: 'Possibly a timeout',
    });
    expect(formatAgentFeedback(input)).toContain(
      'Suspected cause (unconfirmed): Possibly a timeout'
    );
  });
});
