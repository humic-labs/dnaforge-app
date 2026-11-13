import { getChatTurns, getMessages } from '../../db';
import { readMolecularPromptTrial } from './molecular-prompt-trials';

export function assertFreshMolecularTrialConversation(input: {
  question: string;
  content: string;
  policyVersion?: number;
  existingMessages: number;
  existingTurns: number;
  references: number;
  attachments: number;
}): void {
  if (input.policyVersion !== 1)
    throw new Error(
      'Historical protein trials are read-only. Start a new independent coordinate-only attempt.'
    );
  if (input.existingMessages || input.existingTurns)
    throw new Error(
      'Protein trials require a fresh conversation; previous messages and turns cannot initialize an attempt.'
    );
  if (input.content.trim() !== input.question || input.references || input.attachments)
    throw new Error(
      'Protein trials accept only their fixed question and clean pinned coordinates, without prior output references or attachments.'
    );
}

export async function requireFreshMolecularTrialConversation(
  conversationId: string,
  content: string,
  references: number,
  attachments: number,
  inMemoryMessages: number,
  inMemoryTurns: number
): Promise<void> {
  const trial = readMolecularPromptTrial(conversationId);
  if (!trial) return;
  const [messages, turns] = await Promise.all([
    getMessages(conversationId),
    getChatTurns(conversationId),
  ]);
  assertFreshMolecularTrialConversation({
    question: trial.question,
    content,
    policyVersion: trial.execution?.startPolicyVersion,
    existingMessages: Math.max(messages.length, inMemoryMessages),
    existingTurns: Math.max(turns.length, inMemoryTurns),
    references,
    attachments,
  });
}
