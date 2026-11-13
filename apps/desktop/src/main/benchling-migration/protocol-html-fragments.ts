import { createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import type { SourceObject } from '../../shared/benchling-migration';
import {
  buildNotebookHtmlProjection,
  type NotebookAttachmentBinding,
  type NotebookAttachmentReference,
} from './notebook-html-projection';
import type { ProtocolStep } from './protocol-document';

export type ProtocolHtmlProjectionOptions = {
  capturedAt: string;
  converterVersion: string;
  attachments: NotebookAttachmentBinding[];
  supportedFormulaNames: readonly string[];
};

export type ProtocolHtmlFragmentProjection = {
  content: JSONContent;
  attachmentReferences: NotebookAttachmentReference[];
  warnings: string[];
};

export type ProtocolStepsProjection = {
  steps: ProtocolStep[];
  sourceVersionSteps: Array<{
    sourceStepId: string;
    ordinal: number;
    title: string;
    html: string;
  }>;
  attachmentReferences: NotebookAttachmentReference[];
  warnings: string[];
};

export function projectProtocolHtmlFragment(
  sourceObject: SourceObject,
  fragmentId: string,
  title: string,
  html: string,
  options: ProtocolHtmlProjectionOptions
): ProtocolHtmlFragmentProjection {
  const projection = buildNotebookHtmlProjection(
    {
      ...sourceObject,
      id: `${sourceObject.id}:${fragmentId}`,
      stableId: `${sourceObject.stableId}:${fragmentId}`,
      sourceType: 'notebook_protocol_fragment',
      name: title,
      content: { html },
      relationships: [],
    },
    options
  );
  const content = projection.document.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(`Protocol ${fragmentId} did not produce a TipTap document.`);
  }
  return {
    content: content as JSONContent,
    attachmentReferences: projection.attachmentReferences,
    warnings: projection.warnings,
  };
}

export function projectProtocolSteps(
  value: unknown,
  sourceObject: SourceObject,
  options: ProtocolHtmlProjectionOptions
): ProtocolStepsProjection {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Protocol requires at least one ordered step.');
  }
  const sourceIds = new Set<string>();
  const attachmentReferences: NotebookAttachmentReference[] = [];
  const warnings: string[] = [];
  const sourceVersionSteps: ProtocolStepsProjection['sourceVersionSteps'] = [];
  const steps = value.map((entry, index) => {
    const raw = requireRecord(entry, `Protocol step ${index + 1} must be an object.`);
    const sourceStepId = requireText(raw.sourceStepId, `Protocol step ${index + 1} source ID`);
    if (sourceIds.has(sourceStepId))
      throw new Error(`Duplicate protocol source step ID: ${sourceStepId}.`);
    sourceIds.add(sourceStepId);
    const title = requireText(raw.title, `Protocol step ${index + 1} title`);
    const html = requireTextValue(raw.html, `Protocol step ${index + 1} HTML`);
    sourceVersionSteps.push({ sourceStepId, ordinal: index + 1, title, html });
    const fragment = projectProtocolHtmlFragment(
      sourceObject,
      `step:${sourceStepId}`,
      title,
      html,
      options
    );
    attachmentReferences.push(...fragment.attachmentReferences);
    warnings.push(...fragment.warnings);
    return {
      id: `protocol-step-${sha256(`${sourceObject.stableId}:${sourceStepId}`).slice(0, 20)}`,
      sourceStepId,
      ordinal: index + 1,
      title,
      content: fragment.content,
    };
  });
  return { steps, sourceVersionSteps, attachmentReferences, warnings };
}

export function mergeProtocolAttachmentReferences(
  references: NotebookAttachmentReference[]
): NotebookAttachmentReference[] {
  const byIdentity = new Map<string, NotebookAttachmentReference>();
  for (const reference of references) {
    const identity = `${reference.sourceRef}\0${reference.hash}\0${reference.workspacePath}`;
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, {
      ...reference,
      occurrences: (existing?.occurrences ?? 0) + reference.occurrences,
    });
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.sourceRef.localeCompare(right.sourceRef)
  );
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must be single-line text.`);
  return value.trim();
}

function requireTextValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} requires non-empty text.`);
  }
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
