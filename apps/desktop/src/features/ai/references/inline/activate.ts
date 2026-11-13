import {
  userEntityLabel,
  userMessage,
  userMessageValue,
  userMessageWithValues,
  type UserMessage,
} from '@waypoint/user-messages';
import type { DBEntityReference } from '../../../../db/entity-references';
import { pathRelativeToBoundary } from '../../../../shared/path-boundary';
import type {
  InlineReferenceTargetFailureCode,
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../../../../shared/inline-reference-ipc';
import { platform } from '../../../../platform';
import { stripDisplayExtension } from '../../../../utils/fileTypes';
import type { InlineReferenceDeclaration } from './types';
import { gitLocatorParts } from './origin';

export type InlinePathDeclaration = Extract<
  InlineReferenceDeclaration,
  { kind: 'path-entity' | 'workspace-path' }
>;

export type InlineReferenceActivationFailureCode =
  | InlineReferenceTargetFailureCode
  | 'origin-unrecoverable'
  | 'origin-persistence-failed'
  | 'origin-conflict'
  | 'package-product-invalid'
  | 'open-failed';

export type InlineReferenceActivationResult =
  | {
      ok: true;
      action: 'sequence';
      documentId: string;
      tabId: string;
    }
  | {
      ok: true;
      action: 'structure';
      path: string;
      tabId: string;
    }
  | {
      ok: true;
      action: 'workspace';
      path: string;
      revealPath: string;
    }
  | { ok: false; code: InlineReferenceActivationFailureCode };

export interface InlineReferenceActivationInput {
  declaration: InlinePathDeclaration;
  label: string;
  intent?: 'open' | 'reveal';
  rootPath: string;
}

export function inlineWorkspaceDeclarationFromReference(
  reference: Pick<DBEntityReference, 'locator'>
): Extract<InlinePathDeclaration, { kind: 'workspace-path' }> | null {
  const parts = gitLocatorParts(reference.locator);
  return parts ? { kind: 'workspace-path', ...parts } : null;
}

export function inlinePathDeclarationFromReference(
  reference: Pick<DBEntityReference, 'entity_type' | 'locator'>
): Extract<InlinePathDeclaration, { kind: 'path-entity' }> | null {
  if (reference.entity_type !== 'sequence' && reference.entity_type !== 'structure') return null;
  const parts = gitLocatorParts(reference.locator);
  if (!parts) return null;
  return {
    kind: 'path-entity',
    entityType: reference.entity_type,
    ...parts,
  };
}

export interface InlineReferenceActivationDeps {
  signal?: AbortSignal;
  resolveTarget?(
    request: ResolveInlineReferenceTargetRequest
  ): Promise<ResolveInlineReferenceTargetResult>;
  resolvePackageProduct(packageRoot: string): Promise<string>;
  openSequence(input: {
    sourcePath: string;
    label: string;
  }): Promise<{ tabId: string; documentId: string } | null>;
  openStructure(input: { filePath: string; label: string }): Promise<string | null>;
  revealWorkspacePath(path: string): void;
}

const ACTIVATION_ABORTED = Symbol('inline-reference-activation-aborted');

function awaitReferenceActivation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T | typeof ACTIVATION_ABORTED> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(ACTIVATION_ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => finish(() => resolve(ACTIVATION_ABORTED));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function targetRequest(
  input: InlineReferenceActivationInput,
  segments = input.declaration.segments
): ResolveInlineReferenceTargetRequest {
  return {
    roots: [{ name: input.declaration.root, path: input.rootPath }],
    root: input.declaration.root,
    segments: [...segments],
    targetKind:
      input.declaration.kind === 'workspace-path' ? 'workspace' : input.declaration.entityType,
  };
}

export async function activateInlineReference(
  input: InlineReferenceActivationInput,
  deps: InlineReferenceActivationDeps
): Promise<InlineReferenceActivationResult> {
  const resolveTarget =
    deps.resolveTarget ??
    ((request: ResolveInlineReferenceTargetRequest) =>
      platform().fs.resolveInlineReferenceTarget(request));
  const current = await awaitReferenceActivation(resolveTarget(targetRequest(input)), deps.signal);
  if (current === ACTIVATION_ABORTED) return { ok: false, code: 'open-failed' };
  if (!current.ok) return current;

  if (input.intent === 'reveal' || input.declaration.kind === 'workspace-path') {
    if (deps.signal?.aborted) return { ok: false, code: 'open-failed' };
    deps.revealWorkspacePath(current.path);
    return { ok: true, action: 'workspace', path: current.path, revealPath: current.path };
  }

  if (input.declaration.entityType === 'structure') {
    const tabId = await awaitReferenceActivation(
      deps.openStructure({
        filePath: current.canonicalPath,
        label: input.label,
      }),
      deps.signal
    );
    if (tabId === ACTIVATION_ABORTED) return { ok: false, code: 'open-failed' };
    return tabId
      ? { ok: true, action: 'structure', path: current.path, tabId }
      : { ok: false, code: 'open-failed' };
  }

  let canonicalOpenPath = current.canonicalPath;
  if (current.targetType === 'sequence-package') {
    let productPath: string;
    try {
      const resolvedProduct = await awaitReferenceActivation(
        deps.resolvePackageProduct(current.canonicalPath),
        deps.signal
      );
      if (resolvedProduct === ACTIVATION_ABORTED) return { ok: false, code: 'open-failed' };
      productPath = resolvedProduct;
    } catch {
      return { ok: false, code: 'package-product-invalid' };
    }
    const productRelativePath = pathRelativeToBoundary(productPath, current.canonicalRootPath);
    if (!productRelativePath) return { ok: false, code: 'package-product-invalid' };
    const productSegments = productRelativePath.split('/').filter(Boolean);
    const product = await awaitReferenceActivation(
      resolveTarget(targetRequest(input, productSegments)),
      deps.signal
    );
    if (product === ACTIVATION_ABORTED) return { ok: false, code: 'open-failed' };
    if (!product.ok) return product;
    canonicalOpenPath = product.canonicalPath;
  }

  const opened = await awaitReferenceActivation(
    deps.openSequence({
      sourcePath: canonicalOpenPath,
      label: input.label,
    }),
    deps.signal
  );
  if (opened === ACTIVATION_ABORTED) return { ok: false, code: 'open-failed' };
  if (!opened) return { ok: false, code: 'open-failed' };
  return {
    ok: true,
    action: 'sequence',
    documentId: opened.documentId,
    tabId: opened.tabId,
  };
}

export function inlineReferenceActivationErrorMessage(
  code: InlineReferenceActivationFailureCode,
  label: string,
  entityType?: string
): UserMessage {
  const displayLabel = userMessageValue(
    userEntityLabel(stripDisplayExtension(label), 'document.untitled')
  );
  if (code === 'target-not-found') {
    return userMessageWithValues('reference.locationMissing', { label: displayLabel });
  }
  if (code === 'root-not-found' || code === 'root-unavailable' || code === 'target-unavailable') {
    return userMessageWithValues('reference.locationUnavailable', { label: displayLabel });
  }
  if (code === 'wrong-kind' || code === 'package-product-invalid') {
    const kind =
      entityType === 'structure'
        ? 'structure'
        : entityType === 'sequence'
          ? 'sequence'
          : entityType === 'file'
            ? 'file'
            : entityType === 'folder'
              ? 'folder'
              : 'item';
    return userMessageWithValues('reference.unreadable', {
      label: displayLabel,
      kind: userMessageValue(kind),
    });
  }
  if (code === 'outside-root' || code === 'invalid-input' || code === 'root-ambiguous') {
    return userMessage('reference.locationUnsafe');
  }
  if (code === 'origin-unrecoverable') {
    return userMessageWithValues('reference.originUnrecoverable', { label: displayLabel });
  }
  if (code === 'origin-conflict') {
    return userMessage('reference.originConflict');
  }
  if (code === 'origin-persistence-failed') {
    return userMessageWithValues('reference.originRestoreFailed', { label: displayLabel });
  }
  return userMessageWithValues('reference.openFailed', { label: displayLabel });
}
