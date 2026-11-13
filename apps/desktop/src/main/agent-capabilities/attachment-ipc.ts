import { app } from 'electron';
import { join } from 'node:path';
import { userMessagePayloadFromError } from '@waypoint/user-messages';

import type {
  AgentAttachmentCaptureResult,
  AgentAttachmentReadResult,
} from '../../shared/agent-attachments';
import { isAgentAttachmentManifest } from '../../shared/agent-attachments';
import { handleGroup } from '../../shared/ipc-contract';
import { assertSafePath } from '../ipc/path-allowlist';
import { AgentAttachmentStore } from './attachments';
import { agentAttachmentsContract } from '../../shared/ipc/agent-attachments.contract';

let runtimeStore: AgentAttachmentStore | null = null;

export function getRuntimeAgentAttachmentStore(): AgentAttachmentStore {
  runtimeStore ??= new AgentAttachmentStore({
    rootDir: join(app.getPath('userData'), 'agent-attachments'),
  });
  return runtimeStore;
}

export function registerAgentAttachmentHandlers(): void {
  handleGroup(agentAttachmentsContract, {
    capture: async (_event, request) => {
      try {
        if (!request || typeof request.path !== 'string') {
          throw new Error('An absolute attachment path is required.');
        }
        const safePath = await assertSafePath(request.path, {
          requireAbsolute: true,
          errorPrefix: 'agentAttachments:capture',
        });
        const attachment = await getRuntimeAgentAttachmentStore().capture(safePath);
        return { ok: true, attachment } satisfies AgentAttachmentCaptureResult;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          userMessagePayload: userMessagePayloadFromError(error) ?? undefined,
        } satisfies AgentAttachmentCaptureResult;
      }
    },
    read: async (_event, request) => {
      try {
        if (!request || !isAgentAttachmentManifest(request.attachment)) {
          throw new Error('The AI attachment manifest is invalid.');
        }
        const text = await getRuntimeAgentAttachmentStore().readText(request.attachment);
        return { ok: true, text } satisfies AgentAttachmentReadResult;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies AgentAttachmentReadResult;
      }
    },
  });
}
