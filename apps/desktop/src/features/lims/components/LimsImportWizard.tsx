import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Button,
  UI_CARD_CLASS,
  UI_MODAL_LAYER_CLASS,
  UI_TEXTAREA_CLASS,
} from '../../../components/ui';
import { safeFocus } from '../../../shared/utils/safeFocus';
import {
  type LimsEntityKind,
  type LimsIdScheme,
  type LimsImportColumnMappingOverride,
  type LimsImportPlan,
  type LimsSchemaDefinitionView,
} from '../../../shared/lims';
import { isRegisterableOpenSequenceKind } from '../register-open-sequence';
import type { WorkbookSheetPreview } from '../ingress';
import { XIcon, CheckIcon } from '../../../components/icons/glyphs';
import { ImportSheetGrid } from '../../../components/ImportSheetGrid';
import { LimsImportDropZone } from './LimsImportDropZone';
import { LimsImportColumnsPane } from './LimsImportColumnsPane';
import { ImportDestinationPicker } from './ImportDestinationPicker';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { computeImportPlanView } from './import-plan-view';
import type { SheetImportOutcome } from './workbook-review';

const TABLE_ACCEPT = '.csv,.tsv,.xlsx,.xls,.xlsm,.txt';
const SEQUENCE_ACCEPT = '.gb,.gbk,.genbank,.dna,.fa,.fasta,.fna';
const PROTEIN_ACCEPT = '.faa,.fa,.fasta,.csv,.tsv,.xlsx,.xls,.xlsm,.txt';

export type ImportDoorKind = LimsEntityKind;

const SEQUENCE_DOOR_KINDS: ReadonlySet<string> = new Set(['plasmid', 'chromosome', 'genome']);

const FRIENDLY_PLURAL: Partial<Record<string, string>> = {
  oligo: 'DNA oligos',
  rna_oligo: 'RNA oligos',
  strain: 'strains',
  protein: 'proteins',
  sequence: 'sequences',
};

const PRIMARY_TILES: { kind: ImportDoorKind; label: string; sub: string; testid?: string }[] = [
  { kind: 'oligo', label: 'DNA oligos', sub: 'DNA oligos from a spreadsheet' },
  { kind: 'rna_oligo', label: 'RNA oligos', sub: 'RNA oligos from a spreadsheet' },
  { kind: 'strain', label: 'Strains', sub: 'strains from a spreadsheet' },

  {
    kind: 'sequence',
    label: 'Sequences',
    sub: 'DNA sequence files',
    testid: 'lims-import-type-sequences',
  },
];

function isSequenceDoor(kind: ImportDoorKind): boolean {
  return isRegisterableOpenSequenceKind(kind);
}
function acceptForKind(kind: ImportDoorKind): string {
  if (kind === 'protein') return PROTEIN_ACCEPT;
  return isSequenceDoor(kind) ? SEQUENCE_ACCEPT : TABLE_ACCEPT;
}
function fileHintForKind(kind: ImportDoorKind): string {
  if (kind === 'protein') return 'Protein FASTA, CSV, TSV, or Excel';
  return isSequenceDoor(kind) ? 'GenBank, FASTA, or SnapGene files' : 'CSV, TSV, or Excel';
}
function kindNoun(
  kind: ImportDoorKind,
  schemas: LimsSchemaDefinitionView[],
  plural: boolean
): string {
  const p =
    FRIENDLY_PLURAL[kind] ??
    `${(schemas.find((s) => s.entityKind === kind)?.displayName ?? kind).toLowerCase()}s`;
  return plural ? p : p.replace(/s$/, '');
}

export type WizardStep = 'type' | 'file' | 'destination' | 'review';

interface WorkbookReviewTabView {
  sheetName: string;
  verdict: 'entity-table' | 'possible-table';
  rowCount: number;
  selected: boolean;
  planError?: string;
  outcome?: SheetImportOutcome;
}
export interface WorkbookReviewView {
  fileName: string;
  kind: LimsEntityKind;
  phase: 'review' | 'importing' | 'done';
  tabs: WorkbookReviewTabView[];
  activeSheet: string;

  activeGrid?: WorkbookSheetPreview;
}

export function LimsImportWizard({
  step,
  onGotoStep,
  schemas,
  chosenKind,
  suggestedKind,
  onChooseKind,
  onFile,
  onPasteImport,
  plan,
  idSchemes,
  folders,
  destinationRoot,
  onChooseDestination,
  onColumnMappingsChange,
  onRecordAcceptedChange,
  onRecordsAcceptedChange,
  onApply,
  onCancel,
  onDone,
  job,
  onSelectTab,
  onToggleTabSelected,
  onImportAll,
  onNext,
  totalCount,
  initialDataMode = 'upload',
}: {
  step: WizardStep;
  onGotoStep(step: WizardStep): void;
  schemas: LimsSchemaDefinitionView[];
  chosenKind: ImportDoorKind | null;
  suggestedKind?: LimsEntityKind;
  onChooseKind(kind: ImportDoorKind): void;
  onFile(file: File): void;

  onPasteImport(text: string, hasHeader: boolean): void;
  plan: LimsImportPlan | null;
  idSchemes: LimsIdScheme[];
  folders: WorkspaceFolder[];
  destinationRoot: string | null;
  onChooseDestination(path: string): void;
  onColumnMappingsChange(mappings: LimsImportColumnMappingOverride[]): void;
  onRecordAcceptedChange(recordId: string, accepted: boolean): void;
  onRecordsAcceptedChange(recordIds: string[], accepted: boolean): void;
  onApply(): void;
  onCancel(): void;
  onDone?(): void;
  job?: WorkbookReviewView;
  onSelectTab?(sheetName: string): void;
  onToggleTabSelected?(sheetName: string): void;
  onImportAll?(): void;
  onNext?(): void;
  totalCount?: number;

  initialDataMode?: 'upload' | 'paste';
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  const kind = job?.kind ?? chosenKind;
  const activeSchema = kind ? schemas.find((s) => s.entityKind === kind) : undefined;
  const view = plan ? computeImportPlanView(plan, idSchemes, undefined, activeSchema) : null;

  const canPaste = !!kind && !isSequenceDoor(kind);
  const [dataMode, setDataMode] = useState<'upload' | 'paste'>(initialDataMode);
  const [pasteText, setPasteText] = useState('');
  const [pasteHasHeader, setPasteHasHeader] = useState(true);

  useEffect(() => {
    setDataMode(initialDataMode);
  }, [initialDataMode]);

  const MIN_W = 720;
  const MIN_H = 440;
  const [box, setBox] = useState(() => {
    const w = Math.max(MIN_W, Math.min(2600, Math.round(window.innerWidth * 0.9)));
    const h = Math.max(MIN_H, Math.min(1100, Math.round(window.innerHeight * 0.86)));
    return {
      w,
      h,
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
    };
  });
  const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
  const beginGesture = (mode: 'drag' | 'resize' | 'resize-w', event: ReactMouseEvent) => {
    event.preventDefault();
    const start = { mx: event.clientX, my: event.clientY, box };
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.mx;
      const dy = ev.clientY - start.my;
      setBox((prev) => {
        if (mode === 'drag') {
          return {
            ...prev,
            x: clamp(start.box.x + dx, 0, window.innerWidth - prev.w),
            y: clamp(start.box.y + dy, 0, window.innerHeight - prev.h),
          };
        }
        return {
          ...prev,
          w: clamp(start.box.w + dx, MIN_W, window.innerWidth - prev.x - 8),
          h:
            mode === 'resize'
              ? clamp(start.box.h + dy, MIN_H, window.innerHeight - prev.y - 8)
              : prev.h,
        };
      });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    safeFocus(cardRef.current);
  }, []);

  const hasContent = !!plan || (!!job && job.tabs.some((t) => t.selected));
  const selectedCount = job ? job.tabs.filter((t) => t.selected).length : 0;
  const titleText =
    step === 'type' || !kind ? 'Import to registry' : `Import ${kindNoun(kind, schemas, true)}`;

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        data-testid="lims-import-wizard"
        data-review-id={plan?.review?.id}
        role="dialog"
        aria-modal="true"
        aria-label="Import to registry"
        className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} bg-black/40`}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;

          const target = event.target as HTMLElement | null;
          const tag = target?.tagName;
          if (
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            target?.closest('[aria-expanded="true"],[role="listbox"]')
          ) {
            return;
          }
          event.preventDefault();
          onCancel();
        }}
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div
          ref={cardRef}
          tabIndex={-1}
          data-testid="lims-import-wizard-card"
          style={{ position: 'fixed', left: box.x, top: box.y, width: box.w, height: box.h }}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl outline-none"
        >
          {}
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div
              data-testid="lims-import-wizard-drag"
              onMouseDown={(event) => beginGesture('drag', event)}
              className="min-w-0 flex-1 cursor-move select-none"
            >
              <div className="truncate text-sm font-semibold text-fg">{titleText}</div>
              {}
              {plan && view ? (
                <div
                  data-testid="lims-import-status-line"
                  className="truncate text-[11px] font-normal text-fg-muted"
                >
                  <span data-testid="lims-import-plan-source" className="font-medium text-fg">
                    {plan.sourceName}
                  </span>{' '}
                  · {view.detectedRecordsText} · {view.newCount} new
                  {view.idRange ? ` · ${view.idRange}` : ''}
                </div>
              ) : job ? (
                <div
                  data-testid="lims-import-status-line"
                  className="truncate text-[11px] font-normal text-fg-muted"
                >
                  {job.fileName}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              data-testid="lims-import-cancel"
              aria-label="Close"
              onClick={onCancel}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg"
            >
              <XIcon />
            </button>
          </div>

          {}
          {job?.phase === 'done' ? (
            <DonePane job={job} />
          ) : (
            <div className="flex min-h-0 flex-1">
              <StepRail
                step={step}
                hasType={!!chosenKind}
                hasContent={hasContent}
                onGoto={onGotoStep}
              />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border">
                {step === 'type' && (
                  <TypeStep
                    schemas={schemas}
                    chosen={chosenKind}
                    suggested={suggestedKind}
                    onChoose={onChooseKind}
                  />
                )}

                {step === 'file' &&
                  (job ? (
                    <SheetPickerPane
                      job={job}
                      onSelectTab={onSelectTab}
                      onToggleTabSelected={onToggleTabSelected}
                    />
                  ) : (
                    <DataStepPane
                      kind={kind ?? undefined}
                      schemas={schemas}
                      canPaste={canPaste}
                      mode={dataMode}
                      onModeChange={setDataMode}
                      onFile={onFile}
                      pasteText={pasteText}
                      onPasteTextChange={setPasteText}
                      pasteHasHeader={pasteHasHeader}
                      onPasteHasHeaderChange={setPasteHasHeader}
                    />
                  ))}

                {step === 'destination' && (
                  <ImportDestinationPicker
                    folders={folders}
                    value={destinationRoot}
                    onChange={onChooseDestination}
                  />
                )}

                {step === 'review' && (
                  <ReviewPane
                    job={job}
                    plan={plan}
                    view={view}
                    onSelectTab={onSelectTab}
                    onToggleTabSelected={onToggleTabSelected}
                    onColumnMappingsChange={onColumnMappingsChange}
                    onRecordAcceptedChange={onRecordAcceptedChange}
                    onRecordsAcceptedChange={onRecordsAcceptedChange}
                  />
                )}
              </div>
            </div>
          )}

          {}
          <div className="flex min-h-[3.5rem] items-center justify-between border-t border-border px-4 py-3">
            <div>
              {step === 'type' ? (
                <Button type="button" data-testid="lims-import-cancel-footer" onClick={onCancel}>
                  Cancel
                </Button>
              ) : job?.phase !== 'done' ? (
                <Button
                  type="button"
                  data-testid="lims-import-back"
                  onClick={() =>
                    onGotoStep(
                      step === 'destination' ? 'review' : step === 'review' ? 'file' : 'type'
                    )
                  }
                >
                  ← Back
                </Button>
              ) : null}
            </div>
            <div>
              {}
              {job?.phase === 'done' ? (
                <Button
                  type="button"
                  data-testid="lims-import-done"
                  onClick={onDone ?? onCancel}
                  variant="primary"
                >
                  Done
                </Button>
              ) : (
                <>
                  {}
                  {step === 'file' && !job && canPaste && dataMode === 'paste' && (
                    <Button
                      type="button"
                      data-testid="lims-import-paste-preview"
                      onClick={() => onPasteImport(pasteText, pasteHasHeader)}
                      disabled={!pasteText.trim()}
                      variant="primary"
                    >
                      Preview records →
                    </Button>
                  )}
                  {}
                  {step === 'file' && job && (
                    <Button
                      type="button"
                      data-testid="lims-import-next"
                      onClick={onNext}
                      disabled={selectedCount === 0}
                      variant="primary"
                    >
                      Next → ({selectedCount} sheet{selectedCount === 1 ? '' : 's'})
                    </Button>
                  )}
                  {}
                  {step === 'review' &&
                    (!job && view?.allAlreadyRegistered ? (
                      <Button
                        type="button"
                        data-testid="lims-import-done"
                        onClick={onDone ?? onCancel}
                        variant="primary"
                      >
                        Done
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        data-testid="lims-import-next"
                        onClick={() => onGotoStep('destination')}
                        disabled={job ? false : !view?.canApply}
                        variant="primary"
                      >
                        Next → Destination
                      </Button>
                    ))}
                  {}
                  {step === 'destination' &&
                    (job?.phase === 'importing' ? (
                      <Button type="button" disabled variant="primary">
                        Importing…
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        data-testid="lims-import-apply"
                        onClick={job ? onImportAll : onApply}
                        disabled={folders.length > 0 && !destinationRoot}
                        variant="primary"
                      >
                        Add {job ? (totalCount ?? 0) : (view?.acceptedCount ?? 0)}{' '}
                        {kindNoun(
                          job ? job.kind : (kind ?? 'oligo'),
                          schemas,
                          (job ? (totalCount ?? 0) : (view?.acceptedCount ?? 0)) !== 1
                        )}
                      </Button>
                    ))}
                </>
              )}
            </div>
          </div>

          {}
          <div
            data-testid="lims-import-wizard-resize-w"
            onMouseDown={(event) => beginGesture('resize-w', event)}
            className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-accent/30"
          />
          <div
            data-testid="lims-import-wizard-resize"
            onMouseDown={(event) => beginGesture('resize', event)}
            className="absolute bottom-0 right-0 flex h-4 w-4 cursor-nwse-resize items-end justify-end p-0.5"
          >
            <span className="h-2 w-2 border-b-2 border-r-2 border-fg-subtle/50" />
          </div>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}

function DataStepPane({
  kind,
  schemas,
  canPaste,
  mode,
  onModeChange,
  onFile,
  pasteText,
  onPasteTextChange,
  pasteHasHeader,
  onPasteHasHeaderChange,
}: {
  kind: ImportDoorKind | undefined;
  schemas: LimsSchemaDefinitionView[];
  canPaste: boolean;
  mode: 'upload' | 'paste';
  onModeChange(mode: 'upload' | 'paste'): void;
  onFile(file: File): void;
  pasteText: string;
  onPasteTextChange(text: string): void;
  pasteHasHeader: boolean;
  onPasteHasHeaderChange(hasHeader: boolean): void;
}) {
  const dropzone = (
    <LimsImportDropZone
      label={kind ? kindNoun(kind, schemas, true) : 'records'}
      hint={kind ? fileHintForKind(kind) : 'CSV, TSV, Excel, GenBank, or FASTA'}
      accept={kind ? acceptForKind(kind) : `${TABLE_ACCEPT},${SEQUENCE_ACCEPT}`}
      onFile={onFile}
    />
  );
  if (!canPaste) return dropzone;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        className="flex flex-shrink-0 items-end gap-1 border-b border-border bg-bg-subtle/50 px-3 pt-2"
      >
        <DataTabButton
          active={mode === 'upload'}
          testid="lims-import-data-tab-upload"
          onClick={() => onModeChange('upload')}
        >
          Upload file
        </DataTabButton>
        <DataTabButton
          active={mode === 'paste'}
          testid="lims-import-data-tab-paste"
          onClick={() => onModeChange('paste')}
        >
          Paste data
        </DataTabButton>
      </div>
      {mode === 'upload' ? (
        dropzone
      ) : (
        <PasteDataPane
          kind={kind}
          noun={kind ? kindNoun(kind, schemas, true) : 'records'}
          text={pasteText}
          onTextChange={onPasteTextChange}
          hasHeader={pasteHasHeader}
          onHasHeaderChange={onPasteHasHeaderChange}
        />
      )}
    </div>
  );
}

function DataTabButton({
  active,
  testid,
  onClick,
  children,
}: {
  active: boolean;
  testid: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      data-active={active}
      onClick={onClick}
      className={`flex-shrink-0 rounded-t-md border px-4 py-1.5 text-sm font-medium ${
        active
          ? '-mb-px border-border border-b-bg bg-bg text-fg'
          : 'border-transparent bg-bg-muted/40 text-fg-muted hover:bg-bg-muted/70 hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

function PasteDataPane({
  kind,
  noun,
  text,
  onTextChange,
  hasHeader,
  onHasHeaderChange,
}: {
  kind: ImportDoorKind | undefined;
  noun: string;
  text: string;
  onTextChange(text: string): void;
  hasHeader: boolean;
  onHasHeaderChange(hasHeader: boolean): void;
}) {
  const placeholder =
    kind === 'protein'
      ? [
          'Protein table:',
          ...(hasHeader ? ['Name\tAmino acid sequence'] : []),
          'RL28_ECOLI\tMSRVCQVTGKRPVTGNNRSHALNATKRRFLPNLHSHRFWVESEKRFVTLRVSAKGMRVIDKKGIDTVLAELRARGEKY',
          '',
          'Multi-FASTA:',
          '>sp|P0A7M2|RL28_ECOLI Large ribosomal subunit protein bL28',
          'MSRVCQVTGKRPVTGNNRSHALNATKRRFLPNLHSHRFWVESEKRFVTLRVSAKGMRVIDKKGIDTVLAELRARGEKY',
          '>sp|P0A7M6|RL29_ECOLI Large ribosomal subunit protein uL29',
          'MKAKELREKSVEELNTELLNLLREQFNLRMQAASGQLQQSHLLKQVRRDVARVKTLLNEKAGA',
        ].join('\n')
      : hasHeader
        ? 'Name\tSequence\nprimer-1\tACGTACGT\nprimer-2\tTTGGCCAA'
        : 'primer-1\tACGTACGT\nprimer-2\tTTGGCCAA';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
      <div className="text-sm text-fg-muted">
        {kind === 'protein'
          ? 'Paste a protein table or multi-FASTA. Each FASTA record becomes one protein.'
          : `Paste tab- or comma-separated ${noun} — one per row.`}
      </div>
      <textarea
        data-testid="lims-import-paste-input"
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        spellCheck={false}
        placeholder={placeholder}
        className={`${UI_TEXTAREA_CLASS} min-h-0 flex-1 resize-none font-mono`}
      />
      <label className="flex flex-shrink-0 cursor-pointer select-none items-center gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          data-testid="lims-import-paste-has-header"
          checked={hasHeader}
          onChange={(event) => onHasHeaderChange(event.target.checked)}
          className="h-3.5 w-3.5 accent-accent"
        />
        First row is a header
      </label>
    </div>
  );
}

function StepRail({
  step,
  hasType,
  hasContent,
  onGoto,
}: {
  step: WizardStep;
  hasType: boolean;
  hasContent: boolean;
  onGoto(step: WizardStep): void;
}) {
  const order: WizardStep[] = ['type', 'file', 'review', 'destination'];
  const activeIndex = order.indexOf(step);
  const rows: { step: WizardStep; n: number; label: string; enabled: boolean }[] = [
    { step: 'type', n: 1, label: 'Type', enabled: true },
    { step: 'file', n: 2, label: 'Data', enabled: hasType },
    { step: 'review', n: 3, label: 'Review', enabled: hasType && hasContent },
    { step: 'destination', n: 4, label: 'Destination', enabled: hasType && hasContent },
  ];
  return (
    <div className="w-44 flex-shrink-0 space-y-1 bg-bg-subtle/40 p-3">
      {rows.map((row) => {
        const index = order.indexOf(row.step);
        const isActive = row.step === step;
        const isDone = index < activeIndex;
        return (
          <button
            key={row.step}
            type="button"
            data-testid={`lims-import-step-${row.step}`}
            data-active={isActive}
            disabled={!row.enabled}
            onClick={() => onGoto(row.step)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              isActive ? 'bg-bg font-medium text-fg shadow-sm' : 'text-fg-muted hover:bg-bg/60'
            }`}
          >
            <span
              className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                isActive
                  ? 'bg-accent text-white'
                  : isDone
                    ? 'bg-accent/15 text-accent'
                    : 'border border-border text-fg-subtle'
              }`}
            >
              {isDone ? <CheckIcon /> : row.n}
            </span>
            {row.label}
          </button>
        );
      })}
    </div>
  );
}

function TypeStep({
  schemas,
  chosen,
  suggested,
  onChoose,
}: {
  schemas: LimsSchemaDefinitionView[];
  chosen: ImportDoorKind | null;
  suggested?: LimsEntityKind;
  onChoose(kind: ImportDoorKind): void;
}) {
  const [showMore, setShowMore] = useState(false);

  const has = (kind: ImportDoorKind) => schemas.some((s) => s.entityKind === kind);
  const primaries = PRIMARY_TILES.filter((t) => has(t.kind));
  const primaryKinds = new Set<string>(primaries.map((t) => t.kind));

  const more = schemas.filter(
    (s) =>
      !primaryKinds.has(s.entityKind) &&
      !SEQUENCE_DOOR_KINDS.has(s.entityKind) &&
      s.entityKind !== 'notebook' &&
      s.entityKind !== 'track-view'
  );

  const tileClass = (kind: ImportDoorKind) =>
    `${UI_CARD_CLASS} flex flex-col gap-1 border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
      chosen === kind || (!chosen && suggested === kind)
        ? 'border-accent ring-1 ring-accent'
        : 'border-transparent hover:border-accent/40'
    }`;

  return (
    <div data-testid="lims-import-type-step" className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-1 text-sm font-semibold text-fg">What are you importing?</div>
      <div className="mb-4 text-xs text-fg-muted">
        Pick one type — everything in this import is registered as that type.
      </div>

      <div className="grid grid-cols-3 gap-2">
        {primaries.map((tile) => (
          <button
            key={tile.kind}
            type="button"
            data-testid={tile.testid ?? `lims-import-type-${tile.kind}`}
            data-suggested={suggested === tile.kind ? 'true' : undefined}
            onClick={() => onChoose(tile.kind)}
            className={tileClass(tile.kind)}
          >
            <span className="text-xs font-semibold text-fg">{tile.label}</span>
            <span className="text-[11px] leading-snug text-fg-muted">{tile.sub}</span>
          </button>
        ))}
      </div>

      {more.length > 0 && (
        <>
          <button
            type="button"
            data-testid="lims-import-type-more"
            onClick={() => setShowMore((v) => !v)}
            className="mt-3 text-xs text-accent hover:underline"
          >
            {showMore ? 'Fewer types' : 'More types…'}
          </button>
          {showMore && (
            <div className="mt-2 grid grid-cols-3 gap-1.5" data-testid="lims-import-type-more-grid">
              {more.map((schema) => (
                <button
                  key={schema.schemaId}
                  type="button"
                  data-testid={`lims-import-type-${schema.entityKind}`}
                  onClick={() => onChoose(schema.entityKind as LimsEntityKind)}
                  className={`${UI_CARD_CLASS} border text-left text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    chosen === schema.entityKind
                      ? 'border-accent text-fg ring-1 ring-accent'
                      : 'border-transparent text-fg hover:border-accent/40'
                  }`}
                >
                  {schema.displayName}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SheetTabStrip({
  job,
  onSelectTab,
  onToggleTabSelected,
}: {
  job: WorkbookReviewView;
  onSelectTab?(sheetName: string): void;
  onToggleTabSelected?(sheetName: string): void;
}) {
  return (
    <div
      data-testid="lims-import-tab-strip"
      role="tablist"
      className="flex flex-shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-bg-subtle/50 px-2 pt-2"
    >
      {job.tabs.map((tab) => {
        const isActive = tab.sheetName === job.activeSheet;
        const done = tab.outcome?.status === 'imported';
        const failed = tab.outcome?.status === 'failed';
        return (
          <button
            key={tab.sheetName}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`lims-import-tab-${tab.sheetName}`}
            data-active={isActive}
            data-selected={tab.selected}
            onClick={() => onSelectTab?.(tab.sheetName)}
            className={`flex max-w-[220px] flex-shrink-0 items-center gap-2 rounded-t-md border px-3 py-1.5 text-xs ${
              isActive
                ? '-mb-px border-border border-b-bg bg-bg font-semibold text-fg'
                : 'border-transparent bg-bg-muted/40 text-fg-muted hover:bg-bg-muted/70 hover:text-fg'
            } ${tab.selected ? '' : 'opacity-70'}`}
          >
            <input
              type="checkbox"
              aria-label={`Import ${tab.sheetName}`}
              data-testid={`lims-import-tab-${tab.sheetName}-check`}
              checked={tab.selected}
              onChange={(event) => {
                event.stopPropagation();
                onToggleTabSelected?.(tab.sheetName);
              }}
              onClick={(event) => event.stopPropagation()}
              className="h-3.5 w-3.5 flex-shrink-0 accent-accent"
            />
            <span
              className="min-w-0 flex-1 truncate"
              title={tab.sheetName}
              data-testid={isActive ? 'lims-import-active-tab-name' : undefined}
            >
              {tab.sheetName}
            </span>
            {done && (
              <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <CheckIcon />
              </span>
            )}
            {failed && <span className="flex-shrink-0 text-[11px] text-error">✕</span>}
          </button>
        );
      })}
    </div>
  );
}

function SheetPickerPane({
  job,
  onSelectTab,
  onToggleTabSelected,
}: {
  job: WorkbookReviewView;
  onSelectTab?(sheetName: string): void;
  onToggleTabSelected?(sheetName: string): void;
}) {
  const activeTab = job.tabs.find((t) => t.sheetName === job.activeSheet);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SheetTabStrip
        job={job}
        onSelectTab={onSelectTab}
        onToggleTabSelected={onToggleTabSelected}
      />
      <div className="border-b border-border px-4 py-2 text-xs text-fg-muted">
        Check the sheets to import — all import as{' '}
        <span className="font-medium text-fg">{kindNounFromView(job)}</span>.
      </div>
      {activeTab?.planError ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-error">
          Couldn’t read this sheet: {activeTab.planError}
        </div>
      ) : job.activeGrid ? (
        <ImportSheetGrid headers={job.activeGrid.headers} rows={job.activeGrid.rows} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-fg-subtle">
          No preview available for this sheet.
        </div>
      )}
    </div>
  );
}

function kindNounFromView(job: WorkbookReviewView): string {
  return FRIENDLY_PLURAL[job.kind] ?? `${job.kind}s`;
}

function ReviewPane({
  job,
  plan,
  view,
  onSelectTab,
  onToggleTabSelected,
  onColumnMappingsChange,
  onRecordAcceptedChange,
  onRecordsAcceptedChange,
}: {
  job?: WorkbookReviewView;
  plan: LimsImportPlan | null;
  view: ReturnType<typeof computeImportPlanView> | null;
  onSelectTab?(sheetName: string): void;
  onToggleTabSelected?(sheetName: string): void;
  onColumnMappingsChange(mappings: LimsImportColumnMappingOverride[]): void;
  onRecordAcceptedChange(recordId: string, accepted: boolean): void;
  onRecordsAcceptedChange(recordIds: string[], accepted: boolean): void;
}) {
  if (!plan || !view) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-fg-subtle">
        Reading the file…
      </div>
    );
  }
  return (
    <div data-testid="lims-import-plan-overlay" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {job && (
        <SheetTabStrip
          job={job}
          onSelectTab={onSelectTab}
          onToggleTabSelected={onToggleTabSelected}
        />
      )}
      {view.allAlreadyRegistered && (
        <div
          data-testid="lims-import-already-registered"
          className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-fg"
        >
          Everything here is already in your registry
          {view.alreadyRegisteredName ? ` as “${view.alreadyRegisteredName}”` : ''} — nothing new to
          add.
        </div>
      )}
      <LimsImportColumnsPane
        plan={plan}
        view={view}
        onColumnMappingsChange={onColumnMappingsChange}
        onRecordAcceptedChange={onRecordAcceptedChange}
        onRecordsAcceptedChange={onRecordsAcceptedChange}
      />
    </div>
  );
}

function DonePane({ job }: { job: WorkbookReviewView }) {
  const rows: SheetImportOutcome[] = job.tabs.map(
    (tab) =>
      tab.outcome ?? {
        sheetName: tab.sheetName,
        status: 'not-selected',
        added: 0,
        skipped: 0,
        flagged: 0,
      }
  );
  const totalAdded = rows.reduce((n, r) => n + r.added, 0);
  return (
    <div data-testid="lims-import-summary" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-fg">Import complete</div>
        <div className="mt-0.5 text-xs text-fg-muted">
          {totalAdded} entit{totalAdded === 1 ? 'y' : 'ies'} added across{' '}
          {rows.filter((r) => r.status === 'imported').length} sheet
          {rows.filter((r) => r.status === 'imported').length === 1 ? '' : 's'}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {rows.map((row) => (
          <div
            key={row.sheetName}
            data-testid={`lims-import-summary-row-${row.sheetName}`}
            data-status={row.status}
            className="flex items-center gap-3 rounded px-2 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {row.sheetName}
            </span>
            <span
              data-testid={`lims-import-summary-status-${row.sheetName}`}
              className={`flex-shrink-0 text-xs ${
                row.status === 'failed'
                  ? 'text-error'
                  : row.status === 'imported'
                    ? 'text-fg'
                    : 'text-fg-muted'
              }`}
            >
              {summaryText(row)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function summaryText(o: SheetImportOutcome): UserMessage {
  if (o.status === 'not-selected') return userMessage('registry.import.notSelected');
  if (o.status === 'failed')
    return userMessageWithValues('registry.import.failed', {
      reason: userMessageValue(toUserMessage(o.error, 'operation.failed')),
    });
  return userMessageWithValues('registry.import.added', {
    added: userMessageValue(o.added),
    skipped: userMessageValue(
      o.skipped > 0
        ? userMessageWithValues('registry.import.skipped', { count: userMessageValue(o.skipped) })
        : ''
    ),
    flagged: userMessageValue(
      o.flagged > 0
        ? userMessageWithValues('registry.import.flagged', { count: userMessageValue(o.flagged) })
        : ''
    ),
  });
}
