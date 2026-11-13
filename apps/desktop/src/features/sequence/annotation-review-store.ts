import type { UserMessage } from '@waypoint/user-messages';
import { create } from 'zustand';
import type { DraftAnnotation } from './types';
import type { AnnotationOutputSource } from './annotation-output-import';
import type {
  NativeAnnotationReviewInspection,
  NativeAnnotationReviewResult,
} from './annotation-review-types';

export interface AnnotationOutputReview {
  source: AnnotationOutputSource;
  format: 'json' | 'gff3';
  outputSha256: string;
  targetDocumentRevision: string;
}

export interface HighlightRequest {
  start: number;
  end: number;
  wraps: boolean;
  timestamp: number;
}

export interface ReviewSession {
  drafts: DraftAnnotation[];
  selectedId: string | null;
  highlightRequest: HighlightRequest | null;
  runVersion: number;
  operationId?: string;
  documentId?: string;
  inputRevision?: string;
  disposition?: 'in-review' | 'applied' | 'dismissed';
  blockedReason?: UserMessage;
  outputImport?: AnnotationOutputReview;
  nativeInspection?: NativeAnnotationReviewInspection;
  nativeApplyPending?: boolean;
  nativeApplyResult?: NativeAnnotationReviewResult;
}

export interface AnnotationReviewOperation {
  operationId: string;
  inputRevision: string;
}

interface AnnotationReviewState {
  sessions: Record<string, ReviewSession>;
  presentedByDocument: Record<string, string>;

  enterReviewMode: (
    drafts: DraftAnnotation[],
    filePath: string,
    runVersion?: number,
    operation?: AnnotationReviewOperation
  ) => void;
  enterOutputReview: (
    drafts: DraftAnnotation[],
    documentId: string,
    runVersion: number,
    outputImport: AnnotationOutputReview
  ) => void;
  setOutputReviewRetryRevision: (documentId: string, revision: string, runVersion?: number) => void;
  presentOperationReview: (operationId: string) => void;
  setOperationDisposition: (
    operationId: string,
    disposition: 'in-review' | 'applied' | 'dismissed'
  ) => void;
  setOperationBlockedReason: (operationId: string, reason?: UserMessage) => void;
  exitReviewMode: (filePath: string) => void;
  selectDraft: (filePath: string, id: string) => void;
  toggleDraftAccepted: (filePath: string, id: string) => void;
  acceptDraft: (filePath: string, id: string) => void;
  acceptRange: (filePath: string, ids: string[]) => void;
  setRangeAccepted: (filePath: string, ids: string[], accepted: boolean) => void;
  rejectDraft: (filePath: string, id: string) => void;
  acceptAll: (filePath: string) => void;
  rejectAll: (filePath: string) => void;

  getSession: (filePath: string) => ReviewSession | undefined;
  isActive: (filePath: string) => boolean;
  getAcceptedDrafts: (filePath: string) => DraftAnnotation[];
  getSelectedDraft: (filePath: string) => DraftAnnotation | undefined;

  reset: () => void;
}

function updateSession(
  state: AnnotationReviewState,
  filePath: string,
  updater: (session: ReviewSession) => ReviewSession
): Record<string, ReviewSession> {
  const key = state.presentedByDocument[filePath] ?? filePath;
  const session = state.sessions[key];
  if (!session || (session.disposition && session.disposition !== 'in-review'))
    return state.sessions;
  return { ...state.sessions, [key]: updater(session) };
}

function currentSession(
  state: AnnotationReviewState,
  documentId: string
): ReviewSession | undefined {
  return state.sessions[state.presentedByDocument[documentId] ?? documentId];
}

export const useAnnotationReviewStore = create<AnnotationReviewState>((set, get) => ({
  sessions: {},
  presentedByDocument: {},

  enterOutputReview: (drafts, documentId, runVersion, outputImport) => {
    set((state) => ({
      presentedByDocument: { ...state.presentedByDocument, [documentId]: documentId },
      sessions: {
        ...state.sessions,
        [documentId]: {
          drafts,
          selectedId: drafts[0]?.id ?? null,
          highlightRequest: null,
          runVersion,
          documentId,
          outputImport,
        },
      },
    }));
  },

  setOutputReviewRetryRevision: (documentId, revision, runVersion) => {
    set((state) => ({
      sessions: updateSession(state, documentId, (session) =>
        session.outputImport
          ? {
              ...session,
              runVersion: runVersion ?? session.runVersion,
              outputImport: { ...session.outputImport, targetDocumentRevision: revision },
            }
          : session
      ),
    }));
  },

  enterReviewMode: (drafts, filePath, runVersion = 0, operation) => {
    set((state) => {
      const key = operation?.operationId ?? filePath;
      const previous = operation ? state.sessions[key] : undefined;
      if (previous?.disposition === 'applied' || previous?.disposition === 'dismissed')
        return state;
      return {
        presentedByDocument: { ...state.presentedByDocument, [filePath]: key },
        sessions: {
          ...state.sessions,
          [key]: previous ?? {
            drafts,
            selectedId: drafts.length > 0 ? drafts[0].id : null,
            highlightRequest: null,
            runVersion,
            ...(operation
              ? { ...operation, documentId: filePath, disposition: 'in-review' as const }
              : {}),
          },
        },
      };
    });
  },

  presentOperationReview: (operationId) => {
    const session = get().sessions[operationId];
    if (!session?.documentId) return;
    set((state) => ({
      presentedByDocument: { ...state.presentedByDocument, [session.documentId!]: operationId },
    }));
  },

  setOperationDisposition: (operationId, disposition) => {
    set((state) => {
      const session = state.sessions[operationId];
      if (!session?.operationId) return state;
      const presentedByDocument = { ...state.presentedByDocument };
      if (
        disposition !== 'in-review' &&
        session.documentId &&
        presentedByDocument[session.documentId] === operationId
      ) {
        delete presentedByDocument[session.documentId];
      }
      return {
        presentedByDocument,
        sessions: {
          ...state.sessions,
          [operationId]: {
            ...session,
            disposition,
            blockedReason: disposition === 'in-review' ? session.blockedReason : undefined,
          },
        },
      };
    });
  },

  setOperationBlockedReason: (operationId, blockedReason) => {
    set((state) => {
      const session = state.sessions[operationId];
      return session?.disposition === 'in-review'
        ? { sessions: { ...state.sessions, [operationId]: { ...session, blockedReason } } }
        : state;
    });
  },

  exitReviewMode: (filePath) => {
    set((state) => {
      const key = state.presentedByDocument[filePath] ?? filePath;
      const session = state.sessions[key];
      const { [filePath]: _presentation, ...presentedByDocument } = state.presentedByDocument;
      if (session?.operationId) {
        return {
          presentedByDocument,
          sessions: {
            ...state.sessions,
            [key]: {
              ...session,
              disposition: session.disposition === 'applied' ? 'applied' : 'dismissed',
              blockedReason: undefined,
            },
          },
        };
      }
      const { [key]: _session, ...sessions } = state.sessions;
      return { sessions, presentedByDocument };
    });
  },

  selectDraft: (filePath, id) => {
    const session = currentSession(get(), filePath);
    if (!session) return;

    const draft = session.drafts.find((d) => d.id === id);
    if (draft) {
      const start = draft.start - 1;
      const end = draft.end - 1;
      const wraps = draft.end < draft.start;
      set((state) => ({
        sessions: updateSession(state, filePath, (s) => ({
          ...s,
          selectedId: id,
          highlightRequest: { start, end, wraps, timestamp: Date.now() },
        })),
      }));
    } else {
      set((state) => ({
        sessions: updateSession(state, filePath, (s) => ({
          ...s,
          selectedId: id,
          highlightRequest: null,
        })),
      }));
    }
  },

  toggleDraftAccepted: (filePath, id) => {
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => (d.id === id ? { ...d, accepted: !d.accepted } : d)),
      })),
    }));
  },

  acceptDraft: (filePath, id) => {
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => (d.id === id ? { ...d, accepted: true } : d)),
      })),
    }));
  },

  acceptRange: (filePath, ids) => {
    const idSet = new Set(ids);
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => (idSet.has(d.id) ? { ...d, accepted: true } : d)),
      })),
    }));
  },

  setRangeAccepted: (filePath, ids, accepted) => {
    const idSet = new Set(ids);
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => (idSet.has(d.id) ? { ...d, accepted } : d)),
      })),
    }));
  },

  rejectDraft: (filePath, id) => {
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => (d.id === id ? { ...d, accepted: false } : d)),
      })),
    }));
  },

  acceptAll: (filePath) => {
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => ({ ...d, accepted: true })),
      })),
    }));
  },

  rejectAll: (filePath) => {
    set((state) => ({
      sessions: updateSession(state, filePath, (s) => ({
        ...s,
        drafts: s.drafts.map((d) => ({ ...d, accepted: false })),
      })),
    }));
  },

  getSession: (filePath) => currentSession(get(), filePath),

  isActive: (filePath) => currentSession(get(), filePath) !== undefined,

  getAcceptedDrafts: (filePath) => {
    const session = currentSession(get(), filePath);
    return session ? session.drafts.filter((d) => d.accepted) : [];
  },

  getSelectedDraft: (filePath) => {
    const session = currentSession(get(), filePath);
    if (!session) return undefined;
    return session.drafts.find((d) => d.id === session.selectedId);
  },

  reset: () => {
    set({ sessions: {}, presentedByDocument: {} });
  },
}));
