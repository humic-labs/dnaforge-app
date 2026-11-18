import {
  toUserMessage,
  userMessage,
  userEntityLabel,
  userToolLabel,
  userMessageValue,
  userMessageWithValues,
  type UserMessage,
} from '@waypoint/user-messages';
import { useState, type ReactNode } from 'react';
import { ChevronRightIcon, BiologyFileIcon } from '../icons';
import { toolHistoryPolicy } from '../../shared/tool-history-policy';
import type {
  StoredToolResult,
  ToolHistoryReactivationResult,
} from '../../features/ai/history/reactivate-tool-result';
import { canReactivateToolResult } from '../../features/ai/history/can-reactivate-tool-result';
import { presentToolAction } from '../../shared/agent-tool-presentation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visibleToolError(output: unknown): UserMessage | null {
  return isRecord(output) && output.error ? toUserMessage(output.error, 'assistant.failed') : null;
}

async function defaultReactivateToolResult(
  toolName: string,
  result: StoredToolResult
): Promise<ToolHistoryReactivationResult> {
  const { reactivateToolResult } = await import('../../features/ai/history/reactivate-tool-result');
  return reactivateToolResult(toolName, result);
}

interface ToolResultDisplayProps {
  toolName: string;
  content: string;
  allowReactivation?: boolean;
  reactivate?: (
    toolName: string,
    result: StoredToolResult
  ) => Promise<ToolHistoryReactivationResult>;
}

export function ToolResultDisplay({
  toolName,
  content,
  allowReactivation = false,
  reactivate = defaultReactivateToolResult,
}: ToolResultDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const [reactivationState, setReactivationState] = useState<
    'idle' | 'running' | 'restored' | 'failed'
  >('idle');
  const [reactivationError, setReactivationError] = useState<string | null>(null);

  let toolData: {
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    isError?: boolean;
  } | null = null;
  let summary = '';
  let details: React.ReactNode = null;

  try {
    toolData = JSON.parse(content);
  } catch {
    summary = userMessage('assistant.resultAvailable');
  }

  const presentation = toolData
    ? presentToolAction({
        name: toolName,
        status: 'completed',
        input: toolData.input,
        output: toolData.output,
      })
    : null;

  if (toolData) {
    const { input, output, isError } = toolData;

    if (toolName === 'list_files') {
      const path = (input?.path as string) || '.';
      const entries =
        (output as { entries?: Array<{ name: string; type: string; isBiologyFile?: boolean }> })
          ?.entries || [];
      const bioFiles = entries.filter((e) => e.isBiologyFile);
      const displayPath = !path || path === '.' ? 'project root' : path;
      summary = `Listed ${entries.length} items in "${displayPath}"`;
      if (bioFiles.length > 0) {
        summary += ` (${bioFiles.length} biology files)`;
      }

      const LIST_FILES_LIMIT = 15;
      details = (
        <div className="mt-2 space-y-1">
          <div className="text-xs text-fg-muted font-medium mb-1">Files found:</div>
          <div className="max-h-40 overflow-y-auto">
            {entries.slice(0, LIST_FILES_LIMIT).map((entry, i) => (
              <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                {entry.type === 'directory' ? (
                  <span>📁</span>
                ) : entry.isBiologyFile ? (
                  <BiologyFileIcon className="w-3.5 h-3.5 flex-shrink-0 text-accent" />
                ) : (
                  <span>📄</span>
                )}
                <span className={entry.isBiologyFile ? 'text-accent' : 'text-fg-muted'}>
                  {entry.name}
                </span>
              </div>
            ))}
            {entries.length > LIST_FILES_LIMIT && (
              <div className="text-xs text-fg-subtle italic">
                ...and {entries.length - LIST_FILES_LIMIT} more files
              </div>
            )}
          </div>
        </div>
      );
    } else if (toolName === 'read_file') {
      const filePath = (input?.path as string) || 'file';
      const fileName = filePath.split('/').pop() || filePath;
      const fileOutput = output as {
        name?: string;
        format?: string;
        length?: number;
        annotations?: Array<{ name: string; type: string }>;
        circular?: boolean;
        description?: string;
      };
      const format = fileOutput?.format || 'unknown';
      const length = fileOutput?.length || 0;
      const annotations = fileOutput?.annotations || [];

      summary = `Read ${fileName} (${format}, ${length.toLocaleString()} bp)`;
      if (annotations.length > 0) {
        summary += ` - ${annotations.length} annotations`;
      }

      details = (
        <div className="mt-2 space-y-2">
          <div className="text-xs space-y-1">
            <div>
              <span className="text-fg-muted">Format:</span>{' '}
              <span className="text-fg">{format}</span>
            </div>
            <div>
              <span className="text-fg-muted">Length:</span>{' '}
              <span className="text-fg">{length.toLocaleString()} bp</span>
            </div>
            {fileOutput?.circular !== undefined && (
              <div>
                <span className="text-fg-muted">Topology:</span>{' '}
                <span className="text-fg">{fileOutput.circular ? 'circular' : 'linear'}</span>
              </div>
            )}
            {fileOutput?.description && (
              <div>
                <span className="text-fg-muted">Description:</span>{' '}
                <span className="text-fg">{fileOutput.description}</span>
              </div>
            )}
          </div>
          {annotations.length > 0 && (
            <div>
              <div className="text-xs text-fg-muted font-medium mb-1">
                Annotations ({annotations.length}):
              </div>
              <div className="max-h-32 overflow-y-auto">
                {annotations.slice(0, 20).map((ann, i) => (
                  <div key={i} className="text-xs py-0.5 text-fg-muted">
                    <span className="text-accent">{ann.type}</span>: {ann.name}
                  </div>
                ))}
                {annotations.length > 20 && (
                  <div className="text-xs text-fg-subtle italic">
                    ...and {annotations.length - 20} more
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      );
    } else if (toolName === 'find_features') {
      const ffInput = input as { path?: string; query?: string; type?: string } | undefined;
      const ffOutput = output as
        | {
            matchCount?: number;
            features?: Array<{ name: string; type: string; start: number; end: number }>;
            error?: string;
          }
        | undefined;
      if (ffOutput?.error) {
        summary = toUserMessage(ffOutput.error, 'assistant.failed');
      } else {
        const matchCount = ffOutput?.matchCount ?? 0;
        const queryPart = ffInput?.query ? ` matching "${ffInput.query}"` : '';
        const typePart = ffInput?.type ? ` (type: ${ffInput.type})` : '';
        summary = `Found ${matchCount} features${queryPart}${typePart}`;
      }
      if (ffOutput?.features && ffOutput.features.length > 0) {
        details = (
          <div className="mt-2">
            <div className="text-xs text-fg-muted font-medium mb-1">Features:</div>
            <div className="max-h-32 overflow-y-auto">
              {ffOutput.features.slice(0, 20).map((f, i) => (
                <div key={i} className="text-xs py-0.5 text-fg-muted">
                  <span className="text-accent">{f.type}</span>: {f.name} ({f.start}..{f.end})
                </div>
              ))}
              {ffOutput.features.length > 20 && (
                <div className="text-xs text-fg-subtle italic">
                  ...and {ffOutput.features.length - 20} more
                </div>
              )}
            </div>
          </div>
        );
      }
    } else if (toolName === 'get_workspace') {
      const wsOutput = output as
        | {
            focusedPanelId?: string;
            panels?: Array<{
              id: string;
              tabs: Array<{ id: string; type: string; entityId?: string; label: string }>;
              activeTabId?: string;
            }>;
          }
        | undefined;
      const panels = wsOutput?.panels || [];
      const totalTabs = panels.reduce((sum, p) => sum + p.tabs.length, 0);
      summary = `Project: ${panels.length} panel${panels.length !== 1 ? 's' : ''}, ${totalTabs} tab${totalTabs !== 1 ? 's' : ''} open`;

      if (panels.length > 0) {
        const tabIcon = (type: string): ReactNode => {
          switch (type) {
            case 'sequence':
              return <BiologyFileIcon className="w-3.5 h-3.5 inline-block" />;
            case 'chat':
              return '💬';
            case 'file':
              return '📄';
            case 'plasmid':
              return '🔵';
            case 'alignment':
              return '📊';
            default:
              return '📋';
          }
        };
        details = (
          <div className="mt-2 space-y-2">
            {panels.map((panel, pi) => {
              const isFocused = panel.id === wsOutput?.focusedPanelId;
              return (
                <div key={pi}>
                  <div className="text-xs text-fg-muted font-medium mb-1 flex items-center gap-1">
                    <span>🗂</span>
                    <span>Panel {pi + 1}</span>
                    {isFocused && <span className="text-accent">(focused)</span>}
                  </div>
                  <div className="max-h-32 overflow-y-auto pl-2">
                    {panel.tabs.map((tab, ti) => {
                      const isActive = tab.id === panel.activeTabId;
                      return (
                        <div key={ti} className="flex items-center gap-2 text-xs py-0.5">
                          <span className="inline-flex items-center">{tabIcon(tab.type)}</span>
                          <span className={isActive ? 'text-accent' : 'text-fg-muted'}>
                            {tab.label}
                          </span>
                          {isActive && <span className="text-fg-subtle text-[10px]">●</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      }
    } else if (toolName === 'get_file_changes') {
      type FolderResult = {
        folder?: string;
        tracked?: boolean;
        changedFiles?: Array<{ path: string; status: string }>;
        changeCount?: number;
        recentCommits?: Array<{ hash: string; subject: string }>;
        diffStat?: { additions?: number; deletions?: number };
      };
      const fcOutput = output as (FolderResult & { folders?: FolderResult[] }) | undefined;
      const folders: FolderResult[] = fcOutput?.folders || (fcOutput ? [fcOutput] : []);

      const totalChanges = folders.reduce((sum, f) => sum + (f.changeCount ?? 0), 0);
      const anyUntracked = folders.some((f) => f.tracked === false);

      if (anyUntracked && folders.length === 1) {
        summary = 'Not a git repo';
      } else {
        summary = `${totalChanges} changed file${totalChanges !== 1 ? 's' : ''}`;
        if (folders.length > 1) {
          summary += ` across ${folders.length} folders`;
        }
      }

      const statusLabel = (s: string) => {
        switch (s) {
          case 'M':
            return { text: 'Modified', color: 'text-yellow-500' };
          case 'A':
            return { text: 'Added', color: 'text-green-500' };
          case 'D':
            return { text: 'Deleted', color: 'text-red-500' };
          case '??':
            return { text: 'Untracked', color: 'text-fg-subtle' };
          default:
            return { text: s, color: 'text-fg-muted' };
        }
      };

      const renderFolder = (f: FolderResult, idx: number) => {
        const files = f.changedFiles || [];
        const grouped = new Map<string, string[]>();
        for (const file of files) {
          const existing = grouped.get(file.status) || [];
          existing.push(file.path);
          grouped.set(file.status, existing);
        }

        return (
          <div key={idx} className="space-y-1">
            {folders.length > 1 && f.folder && (
              <div className="text-xs text-fg-muted font-medium">{f.folder}</div>
            )}
            {f.tracked === false ? (
              <div className="text-xs text-fg-subtle italic">Not a git repo</div>
            ) : (
              <>
                {Array.from(grouped.entries()).map(([status, paths]) => {
                  const { text, color } = statusLabel(status);
                  return (
                    <div key={status}>
                      <div className={`text-xs font-medium ${color}`}>{text}:</div>
                      <div className="max-h-32 overflow-y-auto pl-2">
                        {paths.map((p, i) => (
                          <div key={i} className="text-xs py-0.5 text-fg-muted">
                            {p}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {Array.isArray(f.recentCommits) && f.recentCommits.length > 0 && (
                  <div>
                    <div className="text-xs text-fg-muted font-medium mt-1">Recent commits:</div>
                    <div className="max-h-32 overflow-y-auto pl-2">
                      {f.recentCommits.map((c, i) => (
                        <div key={i} className="text-xs py-0.5 text-fg-muted">
                          <span className="text-accent font-mono">{c.hash.slice(0, 7)}</span>{' '}
                          {c.subject}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {f.diffStat && (
                  <div className="text-xs text-fg-muted mt-1">
                    <span className="text-green-500">+{f.diffStat.additions ?? 0}</span>{' '}
                    <span className="text-red-500">−{f.diffStat.deletions ?? 0}</span> lines
                  </div>
                )}
              </>
            )}
          </div>
        );
      };

      if (totalChanges > 0 || folders.some((f) => f.tracked === false)) {
        details = <div className="mt-2 space-y-2">{folders.map((f, i) => renderFolder(f, i))}</div>;
      }
    } else if (toolName === 'open_tab') {
      const otOutput = output as { label?: string } | undefined;
      const otInput = input as { label?: string; entityId?: string } | undefined;
      const label = userEntityLabel(otOutput?.label || otInput?.label);
      summary = label ? `Opened "${label}"` : 'Opened tab';
      details = null;
    } else if (toolName === 'close_tab') {
      const ctOutput = output as { closed?: boolean } | undefined;
      summary = ctOutput?.closed === false ? 'No tab to close' : 'Closed tab';
      details = null;
    } else if (toolName === 'create_reference') {
      const refOutput = output as { referenceId?: string; error?: string } | undefined;
      const refInput = input as { entityType?: string; displayLabel?: string } | undefined;
      if (refOutput?.error) {
        summary = toUserMessage(refOutput.error, 'assistant.failed');
      } else {
        summary = `Created reference: "${userEntityLabel(refInput?.displayLabel)}"`;
      }
      details = null;
    } else {
      summary =
        presentation?.summary ??
        userMessageWithValues('assistant.actionCompleted', {
          action: userMessageValue(userToolLabel(toolName)),
        });
      details = presentation?.details.length ? (
        <dl className="space-y-1">
          {presentation.details.map((detail, index) => (
            <div key={index} className="flex min-w-0 gap-2">
              <dt className="shrink-0 font-medium">{detail.label}: </dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null;
    }

    if (isError || presentation?.failed) {
      summary = visibleToolError(output) ?? userMessage('assistant.failed');
      details = null;
    }
  }

  const hasDetails = Boolean(details);
  const displayToolName = userToolLabel(toolName);
  const isToolError = Boolean(toolData?.isError || presentation?.failed);
  const historyPolicy = toolHistoryPolicy(toolName);
  const reactivationLabel = historyPolicy.mode === 'reactivate' ? historyPolicy.label : null;
  const canReactivate = Boolean(
    allowReactivation &&
    reactivationLabel &&
    toolData &&
    canReactivateToolResult(toolName, toolData)
  );

  const handleReactivate = async () => {
    if (!toolData || !canReactivate || reactivationState === 'running') return;
    setReactivationState('running');
    setReactivationError(null);
    try {
      const result = await reactivate(toolName, toolData);
      if (result.ok) {
        setReactivationState('restored');
      } else {
        setReactivationState('failed');
        setReactivationError(toUserMessage(result.error, 'operation.failed'));
      }
    } catch (error) {
      setReactivationState('failed');
      setReactivationError(toUserMessage(error, 'failure.could-not-restore-this-view'));
    }
  };

  return (
    <div
      data-testid="tool-result"
      data-tool-name={toolName}
      data-tool-input={toolData?.input ? JSON.stringify(toolData.input) : undefined}
      data-tool-status={isToolError ? 'failed' : 'completed'}
      className="group/tool my-0.5 min-w-0 text-xs text-accent/80 dark:text-accent/70"
    >
      <div className="flex min-w-0 items-start gap-2">
        <button
          onClick={() => hasDetails && setExpanded(!expanded)}
          className={`flex min-w-0 flex-1 items-start gap-2 rounded-sm px-0 py-1 text-left transition-colors ${
            hasDetails ? 'cursor-pointer hover:text-accent' : 'cursor-default'
          }`}
        >
          <span className="mt-[0.35rem] flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-accent/65 dark:text-accent/55">
            {hasDetails ? (
              <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
                <ChevronRightIcon size={10} />
              </span>
            ) : (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-accent/55 dark:bg-accent/45"
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span
              data-testid="tool-result-summary"
              className={`block truncate font-medium ${isToolError ? 'text-error' : 'text-accent/85 dark:text-accent/75'}`}
            >
              {summary}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[10px] leading-3 text-accent/65 dark:text-accent/55">
              {displayToolName}
            </span>
          </span>
        </button>
        {canReactivate && reactivationLabel && (
          <button
            type="button"
            data-testid="tool-result-reactivate"
            onClick={handleReactivate}
            disabled={reactivationState === 'running'}
            className="mt-1 flex-shrink-0 rounded border border-border px-2 py-0.5 text-[11px] font-medium text-accent transition-colors wp-interactive disabled:cursor-wait disabled:opacity-60"
          >
            {reactivationState === 'running'
              ? 'Showing…'
              : reactivationState === 'restored'
                ? 'Shown'
                : reactivationLabel}
          </button>
        )}
      </div>
      {reactivationState === 'failed' && reactivationError && (
        <div data-testid="tool-result-reactivate-error" className="ml-5 text-[11px] text-error">
          {toUserMessage(reactivationError, 'operation.failed')}
        </div>
      )}
      {expanded && hasDetails && (
        <div data-testid="tool-result-details" className="ml-5 mt-1 pb-1 text-fg-muted">
          <div className="rounded-md bg-bg-subtle/60 px-2 py-2 ring-1 ring-border/60">
            {details}
          </div>
        </div>
      )}
    </div>
  );
}
