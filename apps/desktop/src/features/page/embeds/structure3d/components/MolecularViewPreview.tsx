import { toUserMessage } from '@waypoint/user-messages';
import { coordinateStructureData } from '../../../../../shared/binary-coordinates';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { TAB_PORTAL_HOST_ATTACHED_EVENT } from '../../../../../shared/tab-portal-contract';
import { useWorkspaceVisibility } from '../../../../canvas/workspace-visibility';
import { LazyMolstarViewer } from '../LazyMolstarViewer';
import {
  acquireCachedViewerLease,
  getPaneRendererHostCacheKey,
  releaseCachedViewerLease,
  type MolstarPlugin,
} from '../molstar/cache';
import { validateMolecularViewCoordinates, type MolecularView } from '../utils/molecularView';
import { molViewSpecStorySteps } from '../utils/molViewSpecStory';
import {
  colorLegendsForMolViewSpecScene,
  molViewSpecColorGroups,
} from '../molstar/molViewSpecLegend';
import {
  nativeMolViewSpecColorGroups,
  focusMolViewSpecColorGroup,
  selectMolViewSpecColorGroup,
} from '../molstar/molViewSpecSwatchSelection';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { ColorLegend } from './ColorLegend';
import { MolViewSpecStoryControls } from './MolViewSpecStoryControls';
import { MolecularViewWorkspace } from './MolecularViewWorkspace';

const INSET_HEIGHT = 320;

function InteractiveInset({
  view,
  referenceId,
  rendererHostId,
  cameraRef,
  snapshotIndex,
  selectionRevision,
  onReady,
}: {
  view: MolecularView;
  referenceId: string;
  rendererHostId: string;
  cameraRef: MutableRefObject<string | undefined>;
  snapshotIndex: number;
  selectionRevision: number;
  onReady: (plugin: MolstarPlugin | null) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pluginRef = useRef<MolstarPlugin | null>(null);
  const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
  useEffect(() => {
    acquireCachedViewerLease(cacheKey);
    return () => {
      onReady(null);
      releaseCachedViewerLease(cacheKey);
    };
  }, [cacheKey, onReady]);
  const onLoad = useCallback(() => {
    setError(null);
    setLoaded(true);
    onReady(pluginRef.current);
  }, [onReady]);
  const onPluginReady = useCallback(
    (plugin: MolstarPlugin | null) => {
      pluginRef.current = plugin;
      if (loaded) onReady(plugin);
    },
    [loaded, onReady]
  );
  const onCameraChange = useCallback(
    (snapshot: string) => {
      if (molViewSpecStorySteps(view.scene).length > 1) return;
      cameraRef.current = snapshot;
    },
    [cameraRef, view.scene]
  );
  const onError = useCallback(
    (message: string) => {
      setLoaded(false);
      setError(toUserMessage(message, 'structure.failed'));
      onReady(null);
    },
    [onReady]
  );

  return (
    <div
      data-testid={`molecular-view-inset-${referenceId}`}
      data-preview-state={error ? 'error' : loaded ? 'loaded' : 'loading'}
      className="absolute inset-0"
    >
      <LazyMolstarViewer
        structureData={coordinateStructureData(view.coordinates)}
        structureDataFormat={view.coordinates.format === 'pdb' ? 'pdb' : 'mmcif'}
        structureKeyOverride={`molecular-view:${referenceId}`}
        rendererHostId={rendererHostId}
        molViewSpec={view.scene}
        molViewSpecAssets={view.version === 2 ? view.pinnedAssets : undefined}
        molViewSpecSnapshotIndex={snapshotIndex}
        molViewSpecSelectionRevision={selectionRevision}
        cameraSnapshot={
          molViewSpecStorySteps(view.scene).length > 1 ? undefined : cameraRef.current
        }
        height={INSET_HEIGHT}
        scrollZoom={false}
        deferWhileScrolling
        onCameraChange={onCameraChange}
        onPluginReady={onPluginReady}
        onLoad={onLoad}
        onError={onError}
      />
    </div>
  );
}

export function MolecularViewPreview({
  view,
  referenceId,
  enabled = true,
  activeSnapshotIndex,
  onSnapshotIndexChange,
}: {
  view: MolecularView;
  referenceId: string;
  enabled?: boolean;
  activeSnapshotIndex?: number;
  onSnapshotIndexChange?: (index: number) => void;
}) {
  const workspaceVisible = useWorkspaceVisibility();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(view.cameraSnapshot);
  const [localSnapshotIndex, setSnapshotIndex] = useState(view.initialSnapshotIndex ?? 0);
  const snapshotIndex = activeSnapshotIndex ?? localSnapshotIndex;
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [readyPlugin, setReadyPlugin] = useState<MolstarPlugin | null>(null);
  const namedColorGroups = useMemo(
    () =>
      readyPlugin
        ? nativeMolViewSpecColorGroups(readyPlugin, view.scene, snapshotIndex)
        : molViewSpecColorGroups(view.scene, snapshotIndex),
    [readyPlugin, view.scene, snapshotIndex]
  );
  const colorLegends = useMemo(
    () => colorLegendsForMolViewSpecScene(view.scene, snapshotIndex, namedColorGroups),
    [view.scene, snapshotIndex, namedColorGroups]
  );
  const hasStory = molViewSpecStorySteps(view.scene).length > 1;
  const instanceId = useId();
  const rendererHostId = `chat-inset:${referenceId}:${instanceId}`;
  const [visible, setVisible] = useState(false);
  const [validation, setValidation] = useState<{
    view: MolecularView;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    cameraRef.current = view.cameraSnapshot;
    setSnapshotIndex(view.initialSnapshotIndex ?? 0);
  }, [view]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    const host = surface.closest('[id^="tab-content-"]');
    const observe = () => {
      observer.disconnect();
      observer.observe(surface);
    };
    observer.observe(surface);
    host?.addEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, observe);
    return () => {
      host?.removeEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, observe);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!enabled || !workspaceVisible || !visible || validation?.view === view) return;
    let cancelled = false;
    void validateMolecularViewCoordinates(view).then(
      () => {
        if (!cancelled) setValidation({ view, error: null });
      },
      (error: unknown) => {
        if (!cancelled)
          setValidation({
            view,
            error: toUserMessage(error, 'failure.saved-structure-data-could-not-be-verified'),
          });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, workspaceVisible, visible, view, validation?.view]);

  const validationError = validation?.view === view ? validation.error : null;
  const active =
    enabled && workspaceVisible && visible && validation?.view === view && !validationError;
  const selectNamedColorGroup = useCallback(
    (group: (typeof namedColorGroups)[number]) => {
      if (!readyPlugin) return;
      try {
        selectMolViewSpecColorGroup(readyPlugin, view.scene, snapshotIndex, group);
      } catch (error) {
        void PluginCommands.Toast.Show(readyPlugin, {
          title: 'Selection unavailable',
          message: toUserMessage(error, 'structure.failed'),
          timeoutMs: 4_000,
        });
      }
    },
    [readyPlugin, view.scene, snapshotIndex]
  );
  const focusNamedColorGroup = useCallback(
    (group: (typeof namedColorGroups)[number]) => {
      if (!readyPlugin) return;
      try {
        focusMolViewSpecColorGroup(readyPlugin, view.scene, snapshotIndex, group);
      } catch (error) {
        void PluginCommands.Toast.Show(readyPlugin, {
          title: 'Target unavailable',
          message: toUserMessage(error, 'structure.failed'),
          timeoutMs: 4_000,
        });
      }
    },
    [readyPlugin, view.scene, snapshotIndex]
  );
  return (
    <div
      ref={surfaceRef}
      hidden={!workspaceVisible}
      role="region"
      aria-label={`3D structure preview: ${view.title}`}
      data-testid={`molecular-view-preview-${referenceId}`}
      className="relative w-full overflow-hidden bg-white"
    >
      <MolecularViewWorkspace footerPlacement="inline">
        <div data-molecular-view-viewport className="min-w-0 flex-1">
          <div className="relative w-full" style={{ height: INSET_HEIGHT }}>
            <img
              src={view.preview}
              alt={`Saved molecular view: ${view.title}`}
              className="h-full w-full object-contain"
              loading="lazy"
              style={{ visibility: active ? 'hidden' : 'visible' }}
            />
            {active && (
              <InteractiveInset
                view={view}
                referenceId={referenceId}
                rendererHostId={rendererHostId}
                cameraRef={cameraRef}
                snapshotIndex={snapshotIndex}
                selectionRevision={selectionRevision}
                onReady={setReadyPlugin}
              />
            )}
            {validationError && (
              <div
                role="alert"
                className="absolute inset-0 flex items-center justify-center bg-bg/95 p-4 text-xs text-error"
              >
                Could not load the saved 3D preview:{' '}
                {toUserMessage(validationError, 'structure.failed')}
              </div>
            )}
          </div>
          {!validationError && (
            <ColorLegend
              legends={colorLegends}
              namedGroups={namedColorGroups}
              onSelectNamedGroup={active && readyPlugin ? selectNamedColorGroup : undefined}
              onFocusNamedGroup={active && readyPlugin ? focusNamedColorGroup : undefined}
              placement="inline"
            />
          )}
          {hasStory && (
            <MolViewSpecStoryControls
              scene={view.scene}
              comparison={view.version === 2}
              activeIndex={snapshotIndex}
              onSelect={(index) => {
                readyPlugin?.managers.interactivity.lociSelects.deselectAll();
                cameraRef.current = undefined;
                setSnapshotIndex(index);
                setSelectionRevision((value) => value + 1);
                onSnapshotIndexChange?.(index);
              }}
            />
          )}
        </div>
      </MolecularViewWorkspace>
    </div>
  );
}
