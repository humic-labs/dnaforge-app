export const TAB_TYPES = [
  'sequence',
  'file',
  'text',
  'terminal',
  'image',
  'pdf',
  'html',
  'scientific-document',
  'record',
  'chat',
  'page',
  'structure',
  'table',
  'design',
  'primer',
  'protein',
  'assembly-panel',
  'adjacency-graph',
  'assembly-browser',
] as const;

export type TabType = (typeof TAB_TYPES)[number];

export const TAB_DOCUMENT_LIFECYCLES = {
  sequence: 'editable',
  file: 'read-only',
  text: 'editable',
  terminal: 'read-only',
  image: 'read-only',
  pdf: 'read-only',
  html: 'read-only',
  'scientific-document': 'editable',
  record: 'editable',
  chat: 'read-only',
  page: 'editable',
  structure: 'read-only',
  table: 'editable',
  design: 'editable',
  primer: 'editable',
  protein: 'editable',
  'assembly-panel': 'read-only',
  'adjacency-graph': 'read-only',
  'assembly-browser': 'read-only',
} as const satisfies Record<TabType, 'editable' | 'read-only'>;

export function isKnownTabType(value: unknown): value is TabType {
  return typeof value === 'string' && (TAB_TYPES as readonly string[]).includes(value);
}

export const QUIT_LABEL_BY_TAB_TYPE = {
  sequence: { one: 'sequence', many: 'sequences' },
  file: { one: 'file', many: 'files' },
  text: { one: 'text file', many: 'text files' },
  terminal: { one: 'terminal', many: 'terminals' },
  image: { one: 'image', many: 'images' },
  pdf: { one: 'PDF', many: 'PDFs' },
  html: { one: 'HTML file', many: 'HTML files' },
  'scientific-document': { one: 'scientific document', many: 'scientific documents' },
  record: { one: 'record', many: 'records' },
  chat: { one: 'chat', many: 'chats' },
  page: { one: 'page', many: 'pages' },
  structure: { one: 'structure', many: 'structures' },
  table: { one: 'table', many: 'tables' },
  design: { one: 'assembly', many: 'assemblies' },
  primer: { one: 'primer', many: 'primers' },
  protein: { one: 'protein', many: 'proteins' },
  'assembly-panel': { one: 'assembly', many: 'assemblies' },
  'adjacency-graph': { one: 'assembly graph', many: 'assembly graphs' },
  'assembly-browser': { one: 'assembly browser', many: 'assembly browsers' },
} as const satisfies Record<TabType, { readonly one: string; readonly many: string }>;

export function quitWorkPhrase(type: TabType, count: number): string {
  const words = QUIT_LABEL_BY_TAB_TYPE[type];
  return `${count} ${count === 1 ? words.one : words.many}`;
}

export type EditableTabType = {
  [Kind in TabType]: (typeof TAB_DOCUMENT_LIFECYCLES)[Kind] extends 'editable' ? Kind : never;
}[TabType];

export const TAB_DOCUMENT_OWNER_MODULES = {
  sequence: [
    'features/sequence/components/SequenceTab.tsx',
    'features/sequence/components/TrackViewActions.tsx',
    'features/design/components/useEmbeddedAssemblyWorkingCopyOwner.ts',
  ],
  text: ['components/TextViewerTab.tsx'],
  'scientific-document': ['features/scientific-document/ScientificDocumentTab.tsx'],
  record: ['features/lims/components/EntityRecordTab.tsx'],
  page: ['features/page/hooks/useNotebookCloseRequests.ts'],
  table: ['components/TabularFileViewerTab.tsx'],
  design: ['features/design/components/useDesignSaveOwner.ts'],
  primer: [
    'features/primers/components/PrimerCreationTab.tsx',
    'features/primers/components/PrimerCreationForm.tsx',
  ],
  protein: [
    'features/proteins/components/ProteinCreationTab.tsx',
    'features/proteins/components/ProteinSequenceTab.tsx',
  ],
} as const satisfies Record<EditableTabType, readonly [string, ...string[]]>;
