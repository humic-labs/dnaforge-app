import { z } from 'zod';

const uuid = z.string().uuid();
const revision = z.number().int().nonnegative();
const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const role = z.enum(['start', 'deadline']);
const inbox = z.enum(['unread', 'read', 'snoozed', 'dismissed']);
export const workReminderCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('consent'),
      expectedRevision: revision,
      inbox: z.boolean(),
      desktop: z.boolean().optional(),
      email: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('rule'),
      ruleId: uuid.optional(),
      taskId: z.string().min(1),
      role,
      offsetMs: revision.max(365 * 86400000),
      dayTime: wallTime.nullish(),
      dayFold: z.enum(['earlier', 'later']).optional(),
      email: z.boolean(),
      desktop: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('retire-rule'), ruleId: uuid, expectedGeneration: revision })
    .strict(),
  z
    .object({
      action: z.literal('inbox'),
      id: uuid,
      expectedRevision: revision,
      state: inbox,
      wakeAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('handoff'),
      expectedEpoch: revision,
      sourceOfferId: uuid.optional(),
    })
    .strict(),
  z.object({ action: z.literal('rearm'), expectedEpoch: revision }).strict(),
  z.object({ action: z.literal('suspend'), expectedEpoch: revision }).strict(),
  z
    .object({
      action: z.literal('calendar-issue'),
      roles: z
        .array(z.enum(['plan', 'deadline']))
        .min(1)
        .max(2),
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({ action: z.literal('calendar-rotate'), id: uuid, expectedGeneration: revision })
    .strict(),
  z
    .object({ action: z.literal('calendar-revoke'), id: uuid, expectedGeneration: revision })
    .strict(),
]);
export type WorkReminderCommand = z.infer<typeof workReminderCommandSchema>;
export type WorkReminderRequest = {
  workspaceRoot: string;
  requestId: string;
  command: WorkReminderCommand;
};
export interface WorkReminderRuleView {
  id: string;
  task_id: string;
  role: 'start' | 'deadline';
  offset_ms: number;
  day_time: string | null;
  day_fold: 'earlier' | 'later';
  generation: number;
  state: 'armed' | 'retired';
  email_enabled: boolean;
  desktop_enabled?: boolean;
}
export interface WorkReminderView {
  authority: 'local' | 'fenced' | 'hosted' | 'unarmed' | 'suspended';
  epoch: number;
  canOfferHandoff?: boolean;
  canAcceptHandoff?: boolean;
  pendingHandoff?: { requestId: string; expectedEpoch: number };
  offers?: { id: string; epoch: number }[];
  scope: 'local' | 'shared';
  available: boolean;
  consent: {
    inbox_enabled: boolean;
    desktop_enabled?: boolean;
    email_enabled: boolean;
    revision: number;
  } | null;
  rules: WorkReminderRuleView[];
  inbox: {
    id: string;
    effect_key: string;
    task_id: string;
    state: 'unread' | 'read' | 'snoozed' | 'dismissed';
    revision: number;
    wake_at: string | null;
    created_at: string;
    sourceCurrent: boolean;
  }[];
  deliveries: {
    effectKey: string;
    state: string;
    suppressionReason: string | null;
    providerId: string | null;
    admittedAt: string | null;
  }[];
  subscriptions: {
    id: string;
    generation: number;
    roles: ('plan' | 'deadline')[];
    state: 'active' | 'revoked';
    expires_at: string;
  }[];
}
export type WorkReminderResult = WorkReminderResponse &
  ({ outcome: 'applied' } | { outcome: 'rejected'; error: string; confirmedRequestId?: string });
export interface WorkReminderResponse {
  id?: string;
  url?: string;
  secretUnavailable?: boolean;
  bearerNotice?: string;
  state?: string;
  revision?: number;
  epoch?: number;
}
