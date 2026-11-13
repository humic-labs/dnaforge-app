import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReviewRoundRequest } from '../shared/protein-experiment-workers';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestSchema = z
  .object({
    runId: id,
    mode: z.enum(['full-round', 'experiment']),
    frozen: z.string().min(1).max(4_000_000),
    slots: z.array(z.string().min(1).max(1000)).min(1).max(1000),
  })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    request: requestSchema,
    previousRunId: id.nullable(),
    reviewState: z.enum(['reviewed', 'explicit-waiver']),
    approvedBy: z.literal('human'),
    approvedAt: z.number().int().positive(),
    approvalText: z.string().trim().min(1),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    currentRunId: id.nullable(),
    rounds: z.record(z.object({ fingerprint: z.string(), claims: z.record(z.string()) })),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const fingerprint = (request: ReviewRoundRequest) =>
  createHash('sha256')
    .update(JSON.stringify([request.runId, request.mode, request.frozen, request.slots]))
    .digest('hex');

export class ReviewRoundAdmission {
  constructor(private readonly directory: string) {}

  private state(): State {
    const file = join(this.directory, 'state.json');
    return existsSync(file)
      ? stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : { version: 1, currentRunId: null, rounds: {} };
  }

  approveAfterHumanConfirmation(raw: ReviewRoundRequest): void {
    const request = requestSchema.parse(raw);
    if (request.mode !== 'full-round') throw new Error('Only full rounds need human advancement.');
    const state = this.state();
    const receipt = receiptSchema.parse({
      version: 1,
      request,
      previousRunId: state.currentRunId,
      reviewState: 'reviewed',
      approvedBy: 'human',
      approvedAt: Date.now(),
      approvalText:
        'Native confirmation: I reviewed the current round and authorize this exact next round.',
    });
    const directory = join(this.directory, 'approvals');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, `${request.runId}.json`),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' }
    );
  }

  check(raw: ReviewRoundRequest): void {
    const request = requestSchema.parse(raw);
    if (new Set(request.slots).size !== request.slots.length)
      throw new Error('ROUND_SCOPE_CHANGED: Duplicate planned slots.');
    const state = this.state();
    const prior = state.rounds[request.runId];
    if (prior && prior.fingerprint !== fingerprint(request))
      throw new Error('ROUND_SCOPE_CHANGED: Frozen source, instructions or scope changed.');
    if (request.mode === 'experiment') {
      if (request.slots.length !== 1)
        throw new Error(
          'ONE_OFF_EXPERIMENT_REQUIRED: Experiments are one unscored author attempt.'
        );
      return;
    }
    const file = join(this.directory, 'approvals', `${request.runId}.json`);
    const receipt = receiptSchema.safeParse(
      existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    );
    if (!receipt.success)
      throw new Error(
        'HUMAN_REVIEW_REQUIRED: Review the current round and explicitly authorize this exact next round. No author was admitted.'
      );
    if (fingerprint(receipt.data.request) !== fingerprint(request))
      throw new Error(
        'ROUND_SCOPE_CHANGED: Human approval belongs to different source, instructions or slots.'
      );
    if (state.currentRunId !== request.runId && receipt.data.previousRunId !== state.currentRunId)
      throw new Error(
        'HUMAN_REVIEW_REQUIRED: Approval does not follow the current retained round.'
      );
  }

  claim(raw: ReviewRoundRequest, slot: string, jobId: string): void {
    this.check(raw);
    const request = requestSchema.parse(raw);
    if (!request.slots.includes(slot))
      throw new Error('ROUND_SCOPE_CHANGED: Unplanned author slot.');
    const state = this.state();
    const round = (state.rounds[request.runId] ??= {
      fingerprint: fingerprint(request),
      claims: {},
    });
    if (round.claims[slot])
      throw new Error(
        'ROUND_SLOT_ALREADY_CLAIMED: Preserve the previous attempt; a repair needs a separately approved round.'
      );
    round.claims[slot] = jobId;
    if (request.mode === 'full-round') state.currentRunId = request.runId;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(this.directory, 'state.json'));
  }
}
