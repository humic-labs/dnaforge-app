import { z } from 'zod';
const text = z.string(),
  integer = z.number().int().nonnegative();
export const workRemoteAck = z.object({
  id: text.optional(),
  url: text.url().optional(),
  secretUnavailable: z.boolean().optional(),
  bearerNotice: text.optional(),
  state: text.optional(),
  revision: integer.optional(),
  epoch: integer.optional(),
});

export const workRemoteView = z.object({
  canManage: z.boolean().optional(),
  canWrite: z.boolean().optional(),
  dispatch: z
    .object({
      state: z.enum(['unarmed', 'hosted', 'suspended']),
      epoch: integer,
      source_account_id: text.nullable(),
      source_kind: z.enum(['local', 'hosted']).nullable(),
      source_desktop_session_id: text.nullable(),
      source_installation_id: text.nullable(),
      local_fence_id: text.nullable(),
    })
    .nullable(),
  handoffOffers: z.array(z.object({ id: text, epoch: integer })).optional(),
  consent: z
    .object({ inbox_enabled: z.boolean(), email_enabled: z.boolean(), revision: integer })
    .nullable(),
  rules: z.array(
    z.object({
      id: text,
      task_id: text,
      role: z.enum(['start', 'deadline']),
      offset_ms: integer,
      day_time: text.nullable(),
      day_fold: z.enum(['earlier', 'later']),
      generation: integer,
      state: z.enum(['armed', 'retired']),
      email_enabled: z.boolean(),
    })
  ),
  inbox: z.array(
    z.object({
      id: text,
      effect_key: text,
      task_id: text,
      state: z.enum(['unread', 'read', 'snoozed', 'dismissed']),
      revision: integer,
      wake_at: text.nullable(),
      created_at: text,
      sourceCurrent: z.boolean(),
    })
  ),
  deliveries: z.array(
    z.object({
      effectKey: text,
      state: text,
      suppressionReason: text.nullable(),
      providerId: text.nullable(),
      admittedAt: text.nullable(),
    })
  ),
  subscriptions: z.array(
    z.object({
      id: text,
      generation: integer,
      roles: z.array(z.enum(['plan', 'deadline'])),
      state: z.enum(['active', 'revoked']),
      expires_at: text,
    })
  ),
});
