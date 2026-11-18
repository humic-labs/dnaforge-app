'use client';
import { toUserMessage } from '@waypoint/user-messages';

import { useCallback, useMemo, useRef, useState } from 'react';
import { platform } from '../../../platform';
import type { SequenceDesign, DesignPrimerPair } from '../../design/public/types';
import { isPalindrome } from '../../design/public/validation-constants';
import { useFinalizeAcceptedAssembly } from '../hooks/useFinalizeAcceptedAssembly';
import { useAssemblyPrimerOligos } from '../hooks/useAssemblyPrimerOligos';
import {
  buildPrimerArtifactRows,
  serializePrimerRowsCsv,
  serializePrimerRowsTsv,
} from '../../assembly/public/primer-artifacts';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button } from '../../../shared/components/Button';
import {
  AssemblySaveLocationPicker,
  type AssemblySaveLocationPickerHandle,
} from './AssemblySaveLocationPicker';
import {
  AssemblyPrimerOligoActions,
  AssemblyPrimerOligoCells,
  AssemblyPrimerOligoStatus,
  AssemblyPrimerTmContext,
  assemblyPrimerRowTestId,
} from './AssemblyPrimerOligoControls';
import { beginFileExport } from '../../../lib/file-export-telemetry';
import { reportSaveFailure } from '../../../lib/report-save-failure';
import { writableProjectRoots } from '../../../shared/project-root-selection';

interface ExportSectionProps {
  design: SequenceDesign;
  primers: DesignPrimerPair[] | null;
  projectRoot?: string | null;
}

export function ExportSection({ design, primers, projectRoot }: ExportSectionProps) {
  const [copySuccess, setCopySuccess] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ error: boolean; text: string } | null>(null);
  const finalizeAssembly = useFinalizeAcceptedAssembly(design, projectRoot);
  const saveLocationPickerRef = useRef<AssemblySaveLocationPickerHandle>(null);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const saveLocationRoots = useMemo(
    () =>
      writableProjectRoots(workspaceFolders).map((folder) => ({
        path: folder.path,
        name: folder.name,
      })),
    [workspaceFolders]
  );
  const hasPrimers = primers && primers.length > 0;
  const goldenGateOverhangStatus = useMemo(() => overhangStatusForDesign(design), [design]);

  const primerRows = useMemo(
    () => buildPrimerArtifactRows(primers, design.pcrPolymerase),
    [primers, design.pcrPolymerase]
  );

  const tablePrimers = useMemo(
    () => (primers ?? []).flatMap((pair) => [pair.forward, pair.reverse]),
    [primers]
  );
  const savedOligos = useAssemblyPrimerOligos({
    design,
    primers,
    projectRoot: projectRoot ?? null,
  });

  const tsvContent = useMemo(() => {
    if (primerRows.length === 0) return '';
    return serializePrimerRowsTsv(primerRows);
  }, [primerRows]);

  const handleExportCsv = useCallback(async () => {
    if (primerRows.length === 0) return;
    const telemetry = beginFileExport('csv');
    const fileName = `${design.name || 'primers'}_primers.csv`;
    setExportMessage(null);
    let csvContent: string;
    try {
      csvContent = serializePrimerRowsCsv(primerRows);
    } catch (error) {
      reportSaveFailure(
        '[AssemblyExport] CSV export failed:',
        { designId: design.id, format: 'csv', phase: 'serialize' },
        error
      );
      telemetry?.fail('serialize_failed');
      setExportMessage({
        error: true,
        text: 'Could not prepare the CSV file. Try Export CSV again.',
      });
      return;
    }

    let failure: 'dialog' | 'write' = 'dialog';
    let filePath: string | null = null;
    try {
      filePath = await platform().dialog.save({
        defaultPath: fileName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });

      if (!filePath) {
        telemetry?.cancel({ status: 'cancelled' });
        return;
      }
      failure = 'write';
      await platform().fs.writeTextFile(filePath, csvContent);
      telemetry?.complete({ status: 'saved' });
      return;
    } catch (error) {
      reportSaveFailure(
        '[AssemblyExport] CSV export failed:',
        { designId: design.id, format: 'csv', phase: failure, filePath },
        error
      );
    }

    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      url = URL.createObjectURL(blob);
      link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', fileName);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      telemetry?.complete({
        status: 'needs_action',
        outcomeKind:
          failure === 'dialog'
            ? 'export_browser_requested_after_dialog_failure'
            : 'export_browser_requested_after_write_failure',
        valueDelivered: false,
        usableResult: false,
      });
      setExportMessage({
        error: false,
        text: 'Download requested. Check your browser for the CSV file.',
      });
    } catch (error) {
      reportSaveFailure(
        '[AssemblyExport] CSV export failed:',
        { designId: design.id, format: 'csv', phase: 'browser-download', filePath },
        error
      );
      telemetry?.fail('unknown', {
        outcomeKind:
          failure === 'dialog'
            ? 'export_browser_failed_after_dialog_failure'
            : 'export_browser_failed_after_write_failure',
      });
      setExportMessage({
        error: true,
        text: 'Could not download the CSV file. Try Export CSV again.',
      });
    } finally {
      try {
        link?.remove();
      } catch (error) {
        void error;
      }
      try {
        if (url) URL.revokeObjectURL(url);
      } catch (error) {
        void error;
      }
    }
  }, [primerRows, design.id, design.name]);

  const handleCopy = useCallback(async () => {
    if (!tsvContent) return;

    try {
      await navigator.clipboard.writeText(tsvContent);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [tsvContent]);

  return (
    <div className="space-y-3">
      <div data-testid="accepted-assembly-finalize-card" className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {finalizeAssembly.warningCount > 0 && (
              <div className="text-xs text-warning">
                {finalizeAssembly.warningCount} warning
                {finalizeAssembly.warningCount === 1 ? '' : 's'} will be saved with the draft.
              </div>
            )}
            {finalizeAssembly.disabledReason && (
              <div className="text-xs text-fg-subtle">{finalizeAssembly.disabledReason}</div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {saveLocationRoots.length > 0 && finalizeAssembly.destinationState === 'unbound' ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-testid="assembly-save-location-new-folder"
                title="Create a new folder in the selected location"
                disabled={!finalizeAssembly.saveDirectory}
                onClick={() => {
                  const parent =
                    finalizeAssembly.saveDirectory || finalizeAssembly.initialSaveDirectory;
                  if (!parent) return;
                  saveLocationPickerRef.current?.newFolder(parent);
                }}
              >
                New folder
              </Button>
            ) : null}
            {finalizeAssembly.isCustomPath ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={finalizeAssembly.resetSavePath}
                data-testid="reset-accepted-assembly-save-path"
              >
                Use default
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="primary"
              onClick={finalizeAssembly.finalize}
              disabled={
                !finalizeAssembly.canFinalize || finalizeAssembly.status.state === 'running'
              }
              data-testid="finalize-accepted-assembly"
            >
              {finalizeAssembly.status.state === 'running' ? 'Finalizing...' : 'Finalize'}
            </Button>
          </div>
        </div>
        {saveLocationRoots.length > 0 && finalizeAssembly.destinationState === 'unbound' && (
          <AssemblySaveLocationPicker
            ref={saveLocationPickerRef}
            roots={saveLocationRoots}
            initialDir={finalizeAssembly.initialSaveDirectory}
            selectedDir={finalizeAssembly.saveDirectory}
            onSelectFolder={finalizeAssembly.selectSaveDirectory}
          />
        )}
        {finalizeAssembly.isExistingPackage && (
          <div className="text-xs text-fg-subtle" data-testid="accepted-assembly-existing-package">
            Updates the existing accepted sequence package.
          </div>
        )}
        {finalizeAssembly.status.state === 'success' && (
          <div
            className="mt-2 rounded border border-green-500/30 bg-green-500/10 px-2 py-1.5 text-xs text-green-700 dark:text-green-300"
            data-testid="accepted-assembly-success"
          >
            Saved {finalizeAssembly.status.productPath.split(/[\\/]/).pop()} with construction
            metadata and primer files.
          </div>
        )}
        {finalizeAssembly.status.state === 'error' && (
          <div
            className="mt-2 rounded border border-error/30 bg-error/10 px-2 py-1.5 text-xs text-error"
            data-testid="accepted-assembly-error"
          >
            {toUserMessage(finalizeAssembly.status.message, 'assembly.failed')}
            {finalizeAssembly.status.recovery === 'draft' && (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={finalizeAssembly.redraft}
              >
                Update draft
              </Button>
            )}
            {finalizeAssembly.status.recovery === 'destination' && (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() =>
                  saveLocationPickerRef.current?.newFolder(finalizeAssembly.saveDirectory)
                }
              >
                New folder
              </Button>
            )}
          </div>
        )}
        {goldenGateOverhangStatus && (
          <div
            className="mt-3 grid gap-1.5 text-xs"
            data-testid="accepted-assembly-overhang-checks"
          >
            <OverhangCheckRow
              ok={goldenGateOverhangStatus.allUnique}
              okText="All overhangs unique"
              issueText="Duplicate overhangs detected"
            />
            <OverhangCheckRow
              ok={goldenGateOverhangStatus.palindromeCount === 0}
              okText="No palindromes"
              issueText={`${goldenGateOverhangStatus.palindromeCount} palindromic overhang${
                goldenGateOverhangStatus.palindromeCount === 1 ? '' : 's'
              }`}
            />
          </div>
        )}
      </div>

      {hasPrimers && (
        <>
          <div className="text-sm text-fg-muted">
            {primers.length} primer pair{primers.length !== 1 ? 's' : ''} ({primers.length * 2}{' '}
            primers total)
          </div>

          <div className="border border-border rounded-md overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-bg-muted border-b border-border">
              <span className="shrink-0 text-xs font-medium text-fg-muted">Primer Table</span>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <AssemblyPrimerOligoActions oligos={savedOligos} />
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="gap-1"
                  onClick={handleCopy}
                >
                  {copySuccess ? (
                    <>
                      <CheckIcon className="w-3 h-3 text-green-500" />
                      <span className="text-green-500">Copied!</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon className="w-3 h-3" />
                      Copy table
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  className="gap-1"
                  onClick={handleExportCsv}
                >
                  <DownloadIcon className="w-3 h-3" />
                  Export CSV
                </Button>
              </div>
            </div>

            {exportMessage && (
              <p role={exportMessage.error ? 'alert' : 'status'} className="text-xs text-fg-muted">
                {exportMessage.text}
              </p>
            )}
            <AssemblyPrimerOligoStatus oligos={savedOligos} />

            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-bg-subtle sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-fg-muted whitespace-nowrap">
                      Name
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium text-fg-muted whitespace-nowrap">
                      Sequence
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium text-fg-muted whitespace-nowrap">
                      Len
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium text-fg-muted whitespace-nowrap">
                      Tm
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium text-fg-muted whitespace-nowrap">
                      GC%
                    </th>
                    <th className="px-2 py-1.5 text-center font-medium text-fg-muted whitespace-nowrap">
                      Dir
                    </th>
                    <th className="px-2 py-1.5 text-center font-medium text-fg-muted whitespace-nowrap">
                      Frag
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium text-fg-muted whitespace-nowrap">
                      Binding / tail
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium text-fg-muted whitespace-nowrap">
                      Saved oligo
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {primerRows.map((row, idx) => (
                    <tr
                      key={idx}
                      className="wp-interactive"
                      data-testid={assemblyPrimerRowTestId(tablePrimers[idx])}
                    >
                      <td className="px-2 py-1.5 font-medium whitespace-nowrap">{row.name}</td>
                      <td
                        className="px-2 py-1.5 font-mono text-[10px] max-w-[200px] truncate"
                        title={row.sequence}
                      >
                        {row.sequence}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{row.length}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{row.tm.toFixed(1)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{row.gc.toFixed(1)}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span
                          className={`text-[10px] px-1 py-0.5 rounded ${
                            row.direction === 'Forward'
                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                              : 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'
                          }`}
                        >
                          {row.direction === 'Forward' ? 'Fwd' : 'Rev'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-center text-fg-muted">{row.fragment}</td>
                      <AssemblyPrimerOligoCells primer={tablePrimers[idx]} oligos={savedOligos} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AssemblyPrimerTmContext oligos={savedOligos} />
          </div>
        </>
      )}
    </div>
  );
}

function OverhangCheckRow({
  ok,
  okText,
  issueText,
}: {
  ok: boolean;
  okText: string;
  issueText: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={ok ? 'text-green-500' : 'text-warning'}>{ok ? '✓' : '⚠'}</span>
      <span className={ok ? 'text-fg-muted' : 'text-fg'}>{ok ? okText : issueText}</span>
    </div>
  );
}

function overhangStatusForDesign(
  design: SequenceDesign
): { allUnique: boolean; palindromeCount: number } | null {
  if (design.assemblyMethod !== 'goldengate') return null;
  const overhangs = (design.goldenGateJunctions ?? [])
    .map((junction) => junction.overhang)
    .filter(Boolean);
  if (overhangs.length === 0) return null;
  return {
    allUnique: new Set(overhangs).size === overhangs.length,
    palindromeCount: overhangs.filter((overhang) => isPalindrome(overhang)).length,
  };
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
