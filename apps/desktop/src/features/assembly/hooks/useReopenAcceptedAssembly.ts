import { type UserMessage, withUserMessage, toUserMessage } from '@waypoint/user-messages';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeChecksum } from '@waypoint/sequence-utils';
import { platform } from '../../../platform';
import { useCanvasStore } from '../../canvas/public/store';
import { useDesignStore } from '../../design/public/store';
import { useSequenceStore } from '../../sequence/public/store';
import { assertWorkspaceEditorsSettled } from '../../../services/workspace-editor-mutation-state';
import {
  acceptedAssemblyRecordCandidates,
  acceptedAssemblyVersionFromSidecar,
  parseAcceptedAssemblyRecord,
} from '../accepted-reopen';
import {
  reopenAcceptedAssemblyWorkflow,
  type ReopenAcceptedAssemblyResult,
} from '../accepted-reopen-workflow';
import { rememberAssemblyReopen, discardAssemblyReopen } from '../journey-telemetry';
import { inspectAcceptedProductIntegrity } from '../accepted-product-integrity';
import type { AcceptedAssemblySidecarPayload } from '../accepted-types';
import {
  forgetFinalizedPlasmid,
  plasmidIdentityForDocument,
  type FinalizedPlasmidIdentity,
} from '../plasmid-identity';

type ReopenAcceptedAssemblyStatus = 'missing' | 'checking' | 'available' | 'opening' | 'error';

type ResolvedRecord = { path: string; packageRoot: string | null; productFile?: string };

export type AcceptedProductMismatch = {
  expectedChecksum: string;
  actualChecksum: string | null;
};

export function useReopenAcceptedAssembly(
  documentId: string,
  productPath: string | null
): {
  status: ReopenAcceptedAssemblyStatus;
  sidecarPath: string | null;
  error: UserMessage | null;
  productMismatch: AcceptedProductMismatch | null;
  acceptedRecord: AcceptedAssemblySidecarPayload | null;
  reopen: () => Promise<void>;
} {
  const sessionIdentity = plasmidIdentityForDocument(documentId);
  const [status, setStatus] = useState<ReopenAcceptedAssemblyStatus>(
    sessionIdentity ? 'available' : 'checking'
  );
  const [error, setError] = useState<UserMessage | null>(null);
  const [productMismatch, setProductMismatch] = useState<AcceptedProductMismatch | null>(null);
  const [acceptedRecord, setAcceptedRecord] = useState<AcceptedAssemblySidecarPayload | null>(null);
  const [recordRefresh, setRecordRefresh] = useState(0);
  const [record, setRecord] = useState<ResolvedRecord | null>(() =>
    sessionIdentity
      ? {
          path: sessionIdentity.metaPath,
          packageRoot: sessionIdentity.packageRoot,
          productFile: sessionIdentity.productPath.split(/[\\/]/).pop(),
        }
      : null
  );
  const candidates = useMemo(
    () => (productPath ? acceptedAssemblyRecordCandidates(productPath) : null),
    [productPath]
  );

  useEffect(() => {
    if (!candidates) return;
    const onChanged = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (
        path === candidates.packageRoot ||
        path?.startsWith(`${candidates.packageRoot}/`) ||
        path === candidates.legacySidecarPath
      )
        setRecordRefresh((value) => value + 1);
    };
    window.addEventListener('waypoint:workspace-files-changed', onChanged);
    return () => window.removeEventListener('waypoint:workspace-files-changed', onChanged);
  }, [candidates]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setProductMismatch(null);
    setAcceptedRecord(null);

    if (sessionIdentity) {
      setRecord({
        path: sessionIdentity.metaPath,
        packageRoot: sessionIdentity.packageRoot,
        productFile: sessionIdentity.productPath.split(/[\\/]/).pop(),
      });
      setStatus('available');
      void inspectMismatchFromSession(sessionIdentity).then((mismatch) => {
        if (!cancelled) setProductMismatch(mismatch);
      });
      return () => {
        cancelled = true;
      };
    }

    if (!candidates) {
      setRecord(null);
      setStatus('missing');
      return;
    }

    setStatus('checking');

    void (async () => {
      try {
        const fs = platform().fs;
        if (await fs.exists(candidates.packageMetaPath)) {
          const reopenable = await inspectReopenablePackage(
            fs,
            candidates.packageMetaPath,
            candidates.packageRoot,
            candidates.productFile,
            productPath
          );
          if (cancelled) return;
          if (reopenable) {
            setRecord({
              path: candidates.packageMetaPath,
              packageRoot: candidates.packageRoot,
              productFile: candidates.productFile,
            });
            setProductMismatch(reopenable.mismatch);
            setAcceptedRecord(reopenable.acceptedRecord);
            setStatus('available');
            return;
          }
        }
        if (await fs.exists(candidates.legacySidecarPath)) {
          const accepted = parseAcceptedAssemblyRecord(
            await fs.readTextFile(candidates.legacySidecarPath),
            { packageRoot: null }
          );
          if (cancelled) return;
          setRecord({ path: candidates.legacySidecarPath, packageRoot: null });
          setAcceptedRecord(accepted);
          setStatus('available');
          return;
        }
        if (cancelled) return;
        setRecord(null);
        setStatus('missing');
      } catch (err: unknown) {
        if (cancelled) return;
        setRecord(null);
        setStatus('error');
        setError(toUserMessage(err, 'failure.unable-to-check-accepted-assembly-sidecar'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [candidates, productPath, recordRefresh, sessionIdentity]);

  const sidecarPath = record?.path ?? candidates?.packageMetaPath ?? null;

  const reopen = useCallback(async () => {
    if (!record) return;
    setStatus('opening');
    setError(null);
    let reconstructed: ReopenAcceptedAssemblyResult | null = null;
    try {
      const sequenceTab = useCanvasStore.getState().findTab('sequence', documentId);
      if (!sequenceTab) {
        throw new Error('The sequence tab closed before its assembly editor could open.');
      }
      if (useSequenceStore.getState().isDirty(documentId)) {
        throw withUserMessage(
          new Error('Save or discard unsaved sequence edits before editing the assembly.'),
          'workspace.unsavedEdits'
        );
      }
      if (record.packageRoot) {
        assertWorkspaceEditorsSettled({
          workspaceRoot: record.packageRoot,
          affectedEntityIds: [documentId, sessionIdentity?.constructId ?? documentId],
        });
      }
      let designId: string;
      if (record.packageRoot && productPath) {
        const result = await reopenAcceptedAssemblyWorkflow({
          selector: sessionIdentity
            ? {
                constructId: sessionIdentity.constructId,
                acceptedAssemblyVersionId: sessionIdentity.acceptedVersion.id,
              }
            : { locator: record.path },
          idempotencyKey: 'local-edit-assembly',
          actor: 'local-user',
          requireProductIntegrity: false,
        });
        designId = result.designId;
        reconstructed = result;
        forgetFinalizedPlasmid(documentId);
      } else {
        const content = await platform().fs.readTextFile(record.path);
        const sidecarChecksum = await computeChecksum(content);
        const sidecar = parseAcceptedAssemblyRecord(content, {
          packageRoot: record.packageRoot,
          productFile: record.productFile,
        });
        designId = useDesignStore
          .getState()
          .reopenAcceptedAssemblyVersion(
            acceptedAssemblyVersionFromSidecar(sidecar, { sidecarChecksum })
          );
      }

      const canvas = useCanvasStore.getState();
      const stillOpen = canvas.findTab('sequence', documentId);
      if (!stillOpen || stillOpen.tabId !== sequenceTab.tabId) {
        throw new Error('The sequence tab closed before its assembly editor could open.');
      }
      if (reconstructed) rememberAssemblyReopen(reconstructed);
      canvas.updateTab(sequenceTab.panelId, sequenceTab.tabId, {
        assemblyEditDesignId: designId,
      });
      setStatus('available');
    } catch (err) {
      if (reconstructed) discardAssemblyReopen(reconstructed.designId);
      setStatus('error');
      setError(toUserMessage(err, 'failure.unable-to-reopen-accepted-assembly'));
    }
  }, [documentId, productPath, record, sessionIdentity]);

  return { status, sidecarPath, error, productMismatch, acceptedRecord, reopen };
}

async function inspectReopenablePackage(
  fs: {
    exists?(path: string): Promise<boolean>;
    readTextFile(path: string): Promise<string>;
  },
  metaPath: string,
  packageRoot: string,
  productFile: string,
  productPath: string | null
): Promise<{
  mismatch: AcceptedProductMismatch | null;
  acceptedRecord: AcceptedAssemblySidecarPayload;
} | null> {
  try {
    const sidecar = parseAcceptedAssemblyRecord(await fs.readTextFile(metaPath), {
      packageRoot,
      productFile,
    });
    if (!productPath) return { mismatch: null, acceptedRecord: sidecar };
    const integrity = await inspectAcceptedProductIntegrity({
      productPath,
      expectedGenBankChecksum: sidecar.artifacts.productGenBankChecksum ?? null,
      exists: (path) => (fs.exists ? fs.exists(path) : Promise.resolve(true)),
      readTextFile: (path) => fs.readTextFile(path),
    });
    return {
      acceptedRecord: sidecar,
      mismatch:
        integrity.status === 'drifted' && integrity.expectedGenBankChecksum
          ? {
              expectedChecksum: integrity.expectedGenBankChecksum,
              actualChecksum: integrity.actualGenBankChecksum,
            }
          : null,
    };
  } catch {
    return null;
  }
}

async function inspectMismatchFromSession(
  identity: FinalizedPlasmidIdentity
): Promise<AcceptedProductMismatch | null> {
  const expected = identity.acceptedVersion.artifacts?.productGenBankChecksum ?? null;
  if (!expected) return null;
  try {
    const integrity = await inspectAcceptedProductIntegrity({
      productPath: identity.productPath,
      expectedGenBankChecksum: expected,
      exists: (path) => platform().fs.exists(path),
      readTextFile: (path) => platform().fs.readTextFile(path),
    });
    return integrity.status === 'drifted' && integrity.expectedGenBankChecksum
      ? {
          expectedChecksum: integrity.expectedGenBankChecksum,
          actualChecksum: integrity.actualGenBankChecksum,
        }
      : null;
  } catch {
    return null;
  }
}
