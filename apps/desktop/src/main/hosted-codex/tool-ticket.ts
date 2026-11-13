import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { HostedSignedToolTicket } from '@waypoint/hosted-ai-contract';

export const DEFAULT_TICKET_TTL_MS = 15 * 60_000;

export type ToolTicketRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_call'
  | 'wrong_tool';

export class ToolTicketError extends Error {
  constructor(
    readonly code: ToolTicketRejection,
    message: string
  ) {
    super(message);
    this.name = 'ToolTicketError';
  }
}

interface TicketPayload {
  readonly c: string;
  readonly t: string;
  readonly a: boolean;
  readonly x: number;
}

function base64url(value: Buffer): string {
  return value.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
}

export interface ToolTicketMinter {
  mint(options: {
    readonly providerCallId: string;
    readonly toolName: string;
    readonly requiresUserApproval: boolean;
    readonly ttlMs?: number;
  }): HostedSignedToolTicket;
  verify(token: string, expect: { providerCallId: string; toolName: string }): void;
}

export function createToolTicketMinter(options?: {
  readonly secret?: Buffer;
  readonly now?: () => number;
}): ToolTicketMinter {
  const secret = options?.secret ?? randomBytes(32);
  const now = options?.now ?? ((): number => Date.now());

  const sign = (payload: string): string =>
    base64url(createHmac('sha256', secret).update(payload).digest());

  return {
    mint(mintOptions) {
      const expiresAtMs = now() + (mintOptions.ttlMs ?? DEFAULT_TICKET_TTL_MS);
      const payload: TicketPayload = {
        c: mintOptions.providerCallId,
        t: mintOptions.toolName,
        a: mintOptions.requiresUserApproval,
        x: expiresAtMs,
      };
      const encoded = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
      return {
        token: `${encoded}.${sign(encoded)}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
        providerCallId: mintOptions.providerCallId,
        toolName: mintOptions.toolName,
        requiresUserApproval: mintOptions.requiresUserApproval,
      };
    },

    verify(token, expect) {
      const parts = token.split('.');
      if (parts.length !== 2) {
        throw new ToolTicketError('malformed', 'a ticket is one payload and one signature');
      }
      const [encoded, presented] = parts;
      const expected = sign(encoded);
      const a = Buffer.from(presented, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new ToolTicketError('bad_signature', 'the ticket was not signed by this run');
      }

      let payload: TicketPayload;
      try {
        payload = JSON.parse(fromBase64url(encoded).toString('utf8')) as TicketPayload;
      } catch {
        throw new ToolTicketError('malformed', 'the ticket payload is not readable');
      }

      if (payload.c !== expect.providerCallId) {
        throw new ToolTicketError('wrong_call', 'the ticket was minted for a different call');
      }
      if (payload.t !== expect.toolName) {
        throw new ToolTicketError('wrong_tool', 'the ticket was minted for a different tool');
      }
      if (typeof payload.x !== 'number' || now() > payload.x) {
        throw new ToolTicketError('expired', 'the ticket is no longer presentable');
      }
    },
  };
}
