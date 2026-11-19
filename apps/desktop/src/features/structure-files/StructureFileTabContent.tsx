import { structureCoordinateScores } from '../page/public/embeds/structure3d/structureScoreState';
import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Tab } from '../canvas/public/types';
import { useCanvasStore } from '../canvas/public/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { platform } from '../../platform';
import { LazyStructure3dPanel } from '../page/public/embeds/structure3d/components/LazyStructure3dPanel';
import {
  acknowledgeStructureViewHandoff,
  failStructureViewHandoff,
  markStructureViewHostInteractive,
  markStructureViewHostReleased,
} from '../structure-drawer/public/state/structure-view-handoff';
import { loadStructureFileSnapshot, StructureFileLoadError } from './loadStructureFileSnapshot';
import { redirectTabToCoordinatePackage } from './redirectToCoordinatePackage';
import {
  acquireStructureFileSnapshotLease,
  type StructureFileSnapshot,
} from './structure-file-snapshots';
import { useStructureRendererHostId } from '../page/public/embeds/structure3d/agentStructureRenderers';

export function StructureFileTabContent({
  tab,
  rendererHostId,
}: {
  tab: Tab;
  rendererHostId?: string;
}) {
  const viewerRendererHostId = useStructureRendererHostId(rendererHostId);
  const attrs = tab.initialStructureAttrs;
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const [retryRevision, setRetryRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<StructureFileSnapshot | null>(null);
  const [error, setError] = useState<StructureFileLoadError | null>(null);
  const viewerAttrs = useMemo(
    () =>
      attrs && snapshot
        ? {
            ...attrs,
            coordinateScores: structureCoordinateScores(
              snapshot.data,
              snapshot.coordinateDigestSha256
            ),
          }
        : attrs,
    [attrs, snapshot]
  );
  const structureId = attrs?.structureArtifactRef?.structureId ?? tab.entityId;
  const structureViewId = attrs?.structureViewIdentity?.structureViewId ?? tab.entityId;
  const artifactEntityId = attrs?.structureArtifactRef?.entityId;
  const artifactRevisionId = attrs?.structureArtifactRef?.revisionId;
  const coordinateDigestSha256 = attrs?.structureArtifactRef?.coordinateDigestSha256;
  const artifactPath = attrs?.structureArtifactRef?.artifactPath;
  const artifactFormat = attrs?.structureArtifactRef?.format;
  const handoff = attrs?.structureViewHandoff;
  const viewerInstanceId = `tab:${tab.id}`;

  useEffect(() => {
    let current = true;
    const lease = acquireStructureFileSnapshotLease(structureViewId);
    setSnapshot(null);
    setError(null);
    const locator =
      artifactEntityId &&
      artifactRevisionId &&
      coordinateDigestSha256 &&
      artifactPath &&
      artifactFormat
        ? {
            structureViewId,
            entityId: artifactEntityId,
            revisionId: artifactRevisionId,
            coordinateDigestSha256,
            artifactPath,
            format: artifactFormat,
          }
        : null;
    if (!locator) {
      setError(
        new StructureFileLoadError(
          'invalid-reference',
          'This structure tab has no coordinate-file reference.'
        )
      );
      return () => {
        current = false;
        lease.release();
      };
    }
    void loadStructureFileSnapshot(locator, workspaceFolders, lease).then(
      (loaded) => {
        if (current) setSnapshot(loaded);
      },
      (reason) => {
        if (!current) return;
        const failure =
          reason instanceof StructureFileLoadError
            ? reason
            : new StructureFileLoadError(
                'read-error',
                'DNAForge could not prepare this coordinate file.'
              );
        const missingPath = failure.filePath ?? locator.artifactPath;
        void redirectTabToCoordinatePackage(tab.id, missingPath, locator.coordinateDigestSha256)
          .catch(() => false)
          .then((redirected) => {
            if (current && !redirected) setError(failure);
          });
      }
    );
    return () => {
      current = false;
      lease.release();
    };
  }, [
    artifactEntityId,
    artifactFormat,
    artifactPath,
    artifactRevisionId,
    coordinateDigestSha256,
    retryRevision,
    structureViewId,
    tab.id,
    workspaceFolders,
  ]);

  useEffect(
    () => () => markStructureViewHostReleased(structureViewId, viewerInstanceId),
    [structureViewId, viewerInstanceId]
  );

  const handleLoad = useCallback(() => {
    markStructureViewHostInteractive(structureViewId, viewerInstanceId);
    if (!handoff) return;
    acknowledgeStructureViewHandoff({
      transactionId: handoff.transactionId,
      structureViewId,
      viewerInstanceId,
      generation: handoff.generation,
    });
  }, [handoff, structureViewId, viewerInstanceId]);

  const handleViewerError = useCallback(
    (message: string) => {
      if (handoff) failStructureViewHandoff(handoff.transactionId, message);
    },
    [handoff]
  );

  const filePath =
    error?.filePath ?? attrs?.structureArtifactRef?.artifactPath ?? attrs?.sourceId ?? '';

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div
          role="alert"
          data-testid="structure-file-error"
          data-error-code={error.code}
          className="max-w-md rounded-md border border-border bg-bg-subtle p-4"
        >
          <div className="text-sm font-medium text-fg">Couldn’t open structure</div>
          <div className="mt-1 text-xs text-fg-muted">
            {toUserMessage(error, 'structure.failed')}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-border px-2.5 py-1 text-xs wp-interactive"
              onClick={() => setRetryRevision((value) => value + 1)}
            >
              Retry
            </button>
            {attrs?.structureArtifactRef?.format !== 'binary-cif' && filePath && (
              <button
                type="button"
                className="rounded border border-border px-2.5 py-1 text-xs wp-interactive"
                onClick={() => openCoordinateFileAsText(tab, filePath)}
              >
                Open as text
              </button>
            )}
            {filePath && (
              <button
                type="button"
                className="rounded border border-border px-2.5 py-1 text-xs wp-interactive"
                onClick={() => void platform().shell.revealItemInDir(filePath)}
              >
                Reveal in Finder
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot || !attrs) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="h-full flex items-center justify-center text-sm text-fg-muted"
      >
        Reading coordinate file…
      </div>
    );
  }

  return (
    <LazyStructure3dPanel
      structureId={structureId}
      structureViewId={structureViewId}
      initialStructureAttrs={viewerAttrs}
      structureData={snapshot.data}
      structureDataFormat={snapshot.parser}
      viewerInstanceId={viewerInstanceId}
      rendererHostId={viewerRendererHostId}
      onLoad={handleLoad}
      onError={handleViewerError}
    />
  );
}

function openCoordinateFileAsText(tab: Tab, filePath: string): void {
  const store = useCanvasStore.getState();
  const existing = store.findTab('text', filePath);
  if (existing) {
    store.setActiveTab(existing.panelId, existing.tabId);
    store.focusPanel(existing.panelId);
    return;
  }
  const source = store.findTab(tab.type, tab.entityId);
  const panelId = source?.panelId ?? store.focusedPanelId ?? Object.keys(store.panels)[0];
  if (!panelId) return;
  const label = filePath.split(/[\\/]/).filter(Boolean).pop() ?? tab.label;
  store.openTab(panelId, { type: 'text', entityId: filePath, label });
}
