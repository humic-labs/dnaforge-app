import type { MentionAttrs } from '../components/MentionMenu';

export type { MentionAttrs };

export interface MentionOpenIntent {
  entityType: MentionAttrs['entityType'];
  entityId: string | null;
  label: string;
  path: string | null;
  contentHash: string | null;
  objectUuid: string | null;
  projectId?: string | null;
}

export interface MentionReferenceRecord {
  path: string | null;
  contentHash: string | null;
  objectUuid?: string | null;
}

export interface MentionOptions {
  onMentionClick: ((intent: MentionOpenIntent) => void) | null;
  onCreatePage: ((title: string) => Promise<string>) | null;
  referenceWorkspaceRoot: (() => string | null) | null;
  referenceNotebookPageId: (() => string | null) | null;
  resolveReferenceRecord:
    | ((item: {
        entityType: string;
        entityId: string | null;
        label: string;
      }) => Promise<MentionReferenceRecord>)
    | null;
  HTMLAttributes: Record<string, unknown>;
}
