import { create } from 'zustand';
import { structureLinkRegistryKey, type StructureLinkEntry } from './use-structure-link-registry';

export type StructureResidueSessionPhase =
  | 'awaiting-candidate-commit'
  | 'viewer-mounting'
  | 'interactive'
  | 'error'
  | 'drawer-unmounted';

export interface StructureResidueSessionEntry {
  structureId: string;
  bindingId?: string;
  structureViewId?: string;
  ownerId?: string;
  requestId?: number;
  sequenceDocumentId?: string;
  phase: StructureResidueSessionPhase;
  link?: StructureLinkEntry;
  failureReason?: string;
  updatedAt: number;
}

interface StructureResidueSessionRegistryState {
  sessions: Record<string, StructureResidueSessionEntry>;
  upsertSession(entry: Omit<StructureResidueSessionEntry, 'updatedAt'>): void;
  markPhase(
    structureId: string,
    phase: StructureResidueSessionPhase,
    failureReason?: string,
    ownerId?: string
  ): void;
  refreshSessionLink(
    structureId: string,
    ownerId: string | undefined,
    link: StructureLinkEntry
  ): void;
  unregisterSession(structureId: string, ownerId?: string): void;
  unregisterSessionsForRequest(
    requestId: number,
    predicate?: (entry: StructureResidueSessionEntry) => boolean
  ): void;
  getSessionsBySequenceDocument(sequenceDocumentId: string): StructureResidueSessionEntry[];
}

export const useStructureResidueSessionRegistry = create<StructureResidueSessionRegistryState>(
  (set, get) => ({
    sessions: {},

    upsertSession(entry) {
      set((state) => {
        const ownerId = entry.ownerId ?? entry.link?.ownerId;
        const key = structureLinkRegistryKey(entry.structureId, ownerId);
        const current = state.sessions[key];
        const next: StructureResidueSessionEntry = {
          ...current,
          ...entry,
          ...(ownerId ? { ownerId } : {}),
          ...((entry.bindingId ?? entry.link?.bindingId)
            ? { bindingId: entry.bindingId ?? entry.link?.bindingId }
            : {}),
          ...((entry.structureViewId ?? entry.link?.structureViewId)
            ? { structureViewId: entry.structureViewId ?? entry.link?.structureViewId }
            : {}),
          updatedAt: Date.now(),
        };
        return {
          sessions: {
            ...state.sessions,
            [key]: next,
          },
        };
      });
    },

    markPhase(structureId, phase, failureReason, ownerId) {
      set((state) => {
        const key = structureLinkRegistryKey(structureId, ownerId);
        const current = state.sessions[key] ?? (!ownerId ? state.sessions[structureId] : undefined);
        if (!current) return state;
        if (current.phase === phase && current.failureReason === failureReason) return state;
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              phase,
              failureReason,
              updatedAt: Date.now(),
            },
          },
        };
      });
    },

    refreshSessionLink(structureId, ownerId, link) {
      set((state) => {
        let changed = false;
        const sessions: Record<string, StructureResidueSessionEntry> = {};
        for (const [key, entry] of Object.entries(state.sessions)) {
          const entryOwnerId = entry.ownerId ?? entry.link?.ownerId;
          const matches =
            entry.structureId === structureId &&
            (ownerId === undefined || entryOwnerId === ownerId);
          if (!matches) {
            sessions[key] = entry;
            continue;
          }
          if (entry.link === link) {
            sessions[key] = entry;
            continue;
          }
          changed = true;
          sessions[key] = {
            ...entry,
            ownerId: ownerId ?? entryOwnerId,
            link,
            updatedAt: Date.now(),
          };
        }
        return changed ? { sessions } : state;
      });
    },

    unregisterSession(structureId, ownerId) {
      set((state) => {
        if (ownerId === undefined) {
          let changed = false;
          const rest: Record<string, StructureResidueSessionEntry> = {};
          for (const [key, entry] of Object.entries(state.sessions)) {
            if (entry.structureId === structureId) {
              changed = true;
              continue;
            }
            rest[key] = entry;
          }
          return changed ? { sessions: rest } : state;
        }
        const key = structureLinkRegistryKey(structureId, ownerId);
        if (!(key in state.sessions)) return state;
        const { [key]: _, ...rest } = state.sessions;
        return { sessions: rest };
      });
    },

    unregisterSessionsForRequest(requestId, predicate) {
      set((state) => {
        let changed = false;
        const rest: Record<string, StructureResidueSessionEntry> = {};
        for (const [structureId, entry] of Object.entries(state.sessions)) {
          const shouldRemove = entry.requestId === requestId && (!predicate || predicate(entry));
          if (shouldRemove) {
            changed = true;
            continue;
          }
          rest[structureId] = entry;
        }
        return changed ? { sessions: rest } : state;
      });
    },

    getSessionsBySequenceDocument(sequenceDocumentId) {
      return Object.values(get().sessions).filter(
        (entry) => entry.sequenceDocumentId === sequenceDocumentId
      );
    },
  })
);
