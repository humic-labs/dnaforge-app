import type { UserMessagePayload } from '@waypoint/user-messages';

export const AGENT_ATTACHMENT_MAX_BYTES = 1024 * 1024;
export const AGENT_ATTACHMENT_MAX_COUNT = 8;
export const AGENT_ATTACHMENT_MAX_TOTAL_BYTES = AGENT_ATTACHMENT_MAX_BYTES * 4;

export interface AgentAttachmentManifest {
  id: string;
  sha256: string;
  name: string;
  kind: 'text';
  mediaType: string;
  size: number;
}

export interface AgentAttachmentCaptureRequest {
  path: string;
}

export type AgentAttachmentCaptureResult =
  | { ok: true; attachment: AgentAttachmentManifest }
  | { ok: false; error: string; userMessagePayload?: UserMessagePayload };

export interface AgentAttachmentReadRequest {
  attachment: AgentAttachmentManifest;
}

export type AgentAttachmentReadResult = { ok: true; text: string } | { ok: false; error: string };

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isAgentAttachmentManifest(value: unknown): value is AgentAttachmentManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.id === 'string' &&
    /^attachment-[a-f0-9]{64}$/.test(input.id) &&
    typeof input.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(input.sha256) &&
    input.id === `attachment-${input.sha256}` &&
    typeof input.name === 'string' &&
    input.name.length > 0 &&
    input.name.length <= 255 &&
    !hasControlCharacter(input.name) &&
    input.kind === 'text' &&
    typeof input.mediaType === 'string' &&
    input.mediaType.length <= 100 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input.mediaType) &&
    typeof input.size === 'number' &&
    Number.isSafeInteger(input.size) &&
    input.size >= 0 &&
    input.size <= AGENT_ATTACHMENT_MAX_BYTES
  );
}
