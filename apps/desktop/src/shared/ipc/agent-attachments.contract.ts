import type {
  AgentAttachmentCaptureRequest,
  AgentAttachmentCaptureResult,
  AgentAttachmentReadRequest,
  AgentAttachmentReadResult,
} from '../agent-attachments';
import { defineGroup, invoke } from './contract';

export const agentAttachmentsContract = defineGroup('agentAttachments', {
  capture: invoke<[request: AgentAttachmentCaptureRequest], AgentAttachmentCaptureResult>(),
  read: invoke<[request: AgentAttachmentReadRequest], AgentAttachmentReadResult>(),
});
