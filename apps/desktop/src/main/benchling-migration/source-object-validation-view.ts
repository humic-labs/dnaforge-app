import type { SourceObject } from '../../shared/benchling-migration';
import {
  collectProjectionFormulaEvidence,
  VALIDATION_FORMULA_EVIDENCE,
  type SourceObjectFormulaValidationView,
} from './formula-evidence';

export function sourceObjectValidationView(
  source: SourceObject
): SourceObjectFormulaValidationView {
  return {
    ...source,
    [VALIDATION_FORMULA_EVIDENCE]: collectProjectionFormulaEvidence(source),
    content: validationContentView(source.content),
  };
}

function validationContentView(content: unknown): unknown {
  if (!isRecord(content)) {
    return Array.isArray(content) ? null : content;
  }

  const view: Record<string, unknown> = {};
  if (hasOwn(content, 'html')) {
    view.html = typeof content.html === 'string' ? '' : compactInvalidValue(content.html);
  }
  if (hasOwn(content, 'attachments')) {
    view.attachments = Array.isArray(content.attachments)
      ? []
      : compactInvalidValue(content.attachments);
  }
  if (hasOwn(content, 'mediaType')) {
    view.mediaType =
      typeof content.mediaType === 'string'
        ? content.mediaType
        : compactInvalidValue(content.mediaType);
  }
  if (hasOwn(content, 'sha256')) {
    view.sha256 =
      typeof content.sha256 === 'string' ? content.sha256 : compactInvalidValue(content.sha256);
  }
  if (hasOwn(content, 'sizeBytes')) {
    view.sizeBytes =
      typeof content.sizeBytes === 'number'
        ? content.sizeBytes
        : compactInvalidValue(content.sizeBytes);
  }
  if (hasOwn(content, 'rawAccess')) {
    view.rawAccess = rawAccessValidationView(content.rawAccess);
  }
  return view;
}

function rawAccessValidationView(value: unknown): unknown {
  if (!isRecord(value)) return compactInvalidValue(value);
  return {
    ...(hasOwn(value, 'archivePartId')
      ? {
          archivePartId:
            typeof value.archivePartId === 'string'
              ? value.archivePartId
              : compactInvalidValue(value.archivePartId),
        }
      : {}),
    ...(hasOwn(value, 'entryPath')
      ? {
          entryPath:
            typeof value.entryPath === 'string'
              ? value.entryPath
              : compactInvalidValue(value.entryPath),
        }
      : {}),
  };
}

function compactInvalidValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? null : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
