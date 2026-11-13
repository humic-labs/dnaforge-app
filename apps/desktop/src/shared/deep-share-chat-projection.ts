import type {
  DeepShareArtifactType,
  PortableChatMessageV1,
  PortableConversationV1,
} from '@waypoint/share-bundle';

export interface PortableChatSourceConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PortableChatSourceMessage {
  id: string;
  turnId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'activity';
  content: string;
  createdAt: number;
}

export interface PortableChatSourceReference {
  artifactId: string;
  artifactType: DeepShareArtifactType;
  label: string;
}

export interface PortableChatIncludedArtifact {
  type: DeepShareArtifactType;
  name: string;
}

export interface ProjectPortableConversationInput {
  conversation: PortableChatSourceConversation;
  messages: readonly PortableChatSourceMessage[];
  referencesByMessageId: ReadonlyMap<string, readonly PortableChatSourceReference[]>;
  includedArtifacts: ReadonlyMap<string, PortableChatIncludedArtifact>;
}

export interface SelectedPortableChatSourceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

const TEXT_ATTACHMENT_SECTION = '\n\nAttached files:\n--- File:';
const FILE_ONLY_PROMPT_PATTERN = /^Please analyze the following (?:file|files):\n\n--- File:/u;
const ANY_REFERENCE_TOKEN_PATTERN = /\[\[ref:[^\]]+\]\]/gu;
const LEGACY_REFERENCE_CAPTION_PATTERN = /\n*[ \t]*Referenced entities:[ \t]*$/iu;

export function projectPortableConversation(
  input: ProjectPortableConversationInput
): PortableConversationV1 {
  const selectedMessages = selectPortableChatMessages(input.messages);
  return {
    id: input.conversation.id,
    title: normalizeTitle(input.conversation.title),
    createdAt: new Date(input.conversation.createdAt).toISOString(),
    updatedAt: new Date(input.conversation.updatedAt).toISOString(),
    messages: selectedMessages.map((message) => ({
      id: message.id,
      role: message.role,
      content: cleanPortableChatContent(message.content),
      createdAt: new Date(message.createdAt).toISOString(),
      references: portableReferencesForMessage({
        messageId: message.id,
        referencesByMessageId: input.referencesByMessageId,
        includedArtifacts: input.includedArtifacts,
      }),
    })),
  };
}

export function selectPortableChatMessages(
  messages: readonly PortableChatSourceMessage[]
): SelectedPortableChatSourceMessage[] {
  const finalAssistantIndexes = collectFinalAssistantIndexes(messages);
  const selected: SelectedPortableChatSourceMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      selected.push({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      });
      return;
    }
    if (message.role === 'assistant' && finalAssistantIndexes.has(index)) {
      selected.push({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      });
    }
  });
  return selected;
}

export function cleanPortableChatContent(content: string): string {
  const withoutTokens = content.replace(ANY_REFERENCE_TOKEN_PATTERN, '');
  const withoutCaption = withoutTokens.replace(LEGACY_REFERENCE_CAPTION_PATTERN, '');
  if (FILE_ONLY_PROMPT_PATTERN.test(withoutCaption)) return '';
  const attachmentSectionIndex = withoutCaption.indexOf(TEXT_ATTACHMENT_SECTION);
  const withoutAttachment =
    attachmentSectionIndex === -1
      ? withoutCaption
      : withoutCaption.slice(0, attachmentSectionIndex);
  return withoutAttachment.replace(/[ \t]+$/gmu, '').replace(/\s+$/u, '');
}

function collectFinalAssistantIndexes(messages: readonly PortableChatSourceMessage[]): Set<number> {
  const scopes = new Map<string, number[]>();
  let legacyScope = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') legacyScope += 1;
    const key = message.turnId ? `turn:${message.turnId}` : `legacy:${legacyScope}`;
    const indices = scopes.get(key) ?? [];
    indices.push(index);
    scopes.set(key, indices);
  });
  const finalIndexes = new Set<number>();
  for (const indices of scopes.values()) {
    const finalAssistant = [...indices]
      .reverse()
      .find((index) => messages[index]?.role === 'assistant');
    if (finalAssistant !== undefined) finalIndexes.add(finalAssistant);
  }
  return finalIndexes;
}

function portableReferencesForMessage(input: {
  messageId: string;
  referencesByMessageId: ReadonlyMap<string, readonly PortableChatSourceReference[]>;
  includedArtifacts: ReadonlyMap<string, PortableChatIncludedArtifact>;
}): PortableChatMessageV1['references'] {
  const seen = new Set<string>();
  return (input.referencesByMessageId.get(input.messageId) ?? []).flatMap((reference) => {
    const artifact = input.includedArtifacts.get(reference.artifactId);
    if (!artifact || seen.has(reference.artifactId)) return [];
    seen.add(reference.artifactId);
    return [
      {
        artifactId: reference.artifactId,
        artifactType: artifact.type,
        label: reference.label.trim() || artifact.name,
      },
    ];
  });
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ') || 'Untitled conversation';
}
