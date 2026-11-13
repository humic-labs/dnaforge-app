import { create } from 'zustand';
import type {
  ScientificPdfAnchor,
  ScientificPdfSource,
  ScientificProtocolDocument,
} from '../scientific-document/public/model';

export type ResolvedPdfSource = ScientificPdfSource & { absolutePath: string };

export type ProtocolReviewRegistration = {
  protocolPath: string;
  title: string;
  candidate: {
    candidateSetId: string;
    candidateId: string;
    ordinal: number;
    label: string;
    status: 'proposed' | 'selected' | 'rejected';
  };
  draftRevision: number;
  draftState: 'draft' | 'finalized';
  gapCount: number;
  sourceKinds: Array<'pdf' | 'captured_text'>;
  sources: ResolvedPdfSource[];
  steps: Array<{
    id: string;
    ordinal: number;
    title: string;
    anchors: ScientificPdfAnchor[];
  }>;
};

export type PdfReviewRegistration = {
  filePath: string;
  sha256: string;
  pageCount: number;
  generationId?: string;
};

export type ReviewStepTarget = {
  protocolPath: string;
  stepId: string;
};

type PaperProtocolReviewState = {
  protocols: Record<string, ProtocolReviewRegistration>;
  pdfs: Record<string, PdfReviewRegistration>;
  pdfInstances: Record<string, Record<string, PdfReviewRegistration>>;
  selectedStep: ReviewStepTarget | null;
  hoveredStep: ReviewStepTarget | null;
  registerProtocol: (registration: ProtocolReviewRegistration) => void;
  unregisterProtocol: (protocolPath: string) => void;
  registerPdf: (registration: PdfReviewRegistration) => void;
  unregisterPdf: (filePath: string, generationId?: string) => void;
  selectStep: (target: ReviewStepTarget | null) => void;
  hoverStep: (target: ReviewStepTarget | null) => void;
};

export const usePaperProtocolReviewStore = create<PaperProtocolReviewState>((set) => ({
  protocols: {},
  pdfs: {},
  pdfInstances: {},
  selectedStep: null,
  hoveredStep: null,
  registerProtocol: (registration) =>
    set((state) => ({
      protocols: { ...state.protocols, [registration.protocolPath]: registration },
    })),
  unregisterProtocol: (protocolPath) =>
    set((state) => {
      const protocols = { ...state.protocols };
      delete protocols[protocolPath];
      return {
        protocols,
        selectedStep: state.selectedStep?.protocolPath === protocolPath ? null : state.selectedStep,
        hoveredStep: state.hoveredStep?.protocolPath === protocolPath ? null : state.hoveredStep,
      };
    }),
  registerPdf: (registration) =>
    set((state) => {
      const path = registration.filePath;
      const existing = state.pdfs[path] ? (state.pdfInstances[path] ?? {}) : {};
      return {
        pdfs: { ...state.pdfs, [path]: registration },
        pdfInstances: {
          ...state.pdfInstances,
          [path]: { ...existing, [registration.generationId ?? 'legacy']: registration },
        },
      };
    }),
  unregisterPdf: (filePath, generationId) =>
    set((state) => {
      const pdfs = { ...state.pdfs };
      const pdfInstances = { ...state.pdfInstances };
      if (generationId === undefined) {
        delete pdfs[filePath];
        delete pdfInstances[filePath];
      } else {
        const instances = { ...pdfInstances[filePath] };
        delete instances[generationId];
        const remainingInstances = Object.values(instances);
        const remaining = remainingInstances[remainingInstances.length - 1];
        if (remaining) {
          pdfs[filePath] = remaining;
          pdfInstances[filePath] = instances;
        } else {
          delete pdfs[filePath];
          delete pdfInstances[filePath];
        }
      }
      return { pdfs, pdfInstances };
    }),
  selectStep: (selectedStep) => set({ selectedStep }),
  hoverStep: (hoveredStep) => set({ hoveredStep }),
}));

export function registrationFromProtocol(
  protocolPath: string,
  document: ScientificProtocolDocument,
  resolveSourcePath: (workspacePath: string) => string | null
): ProtocolReviewRegistration | null {
  const sources = document.pdfSources.flatMap((source) => {
    const absolutePath = resolveSourcePath(source.workspacePath);
    return absolutePath ? [{ ...source, absolutePath }] : [];
  });
  if (sources.length === 0) return null;
  if (!document.paperProtocol) return null;
  return {
    protocolPath,
    title: document.title,
    candidate: document.paperProtocol.candidate,
    draftRevision: document.paperProtocol.draft.revision,
    draftState: document.paperProtocol.draft.state,
    gapCount: document.paperProtocol.gaps.length,
    sourceKinds: [...new Set(document.paperProtocol.sources.map((source) => source.kind))].sort(),
    sources,
    steps: document.steps.map((step) => ({
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      anchors: step.pdfAnchors,
    })),
  };
}

export function protocolForPdf(
  protocols: Record<string, ProtocolReviewRegistration>,
  filePath: string,
  preferredProtocolPath?: string
): ProtocolReviewRegistration | null {
  const preferred = preferredProtocolPath ? protocols[preferredProtocolPath] : undefined;
  if (preferred?.sources.some((source) => source.absolutePath === filePath)) return preferred;
  return (
    Object.values(protocols).find((protocol) =>
      protocol.sources.some((source) => source.absolutePath === filePath)
    ) ?? null
  );
}

export function anchorsForStep(
  protocol: ProtocolReviewRegistration | null,
  target: ReviewStepTarget | null,
  filePath: string
): ScientificPdfAnchor[] {
  if (!protocol || !target || target.protocolPath !== protocol.protocolPath) return [];
  const sourceIds = new Set(
    protocol.sources
      .filter((source) => source.absolutePath === filePath)
      .map((source) => source.sourceId)
  );
  return (
    protocol.steps
      .find((step) => step.id === target.stepId)
      ?.anchors.filter((anchor) => sourceIds.has(anchor.sourceId)) ?? []
  );
}
