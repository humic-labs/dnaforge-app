import type { CSSProperties, MouseEvent, ReactNode, Ref } from 'react';
import type { WebGLMapHandle } from '@waypoint/plasmid-viewer';
import { SequenceMinimapShapeControl } from './SequenceMinimapShapeControl';
import { SequenceMapPaneControls, type WebglMapZoomSource } from './SequenceMapPaneControls';
import type { SequenceMapShape } from '../view-state/sequence-view-state';

type MapGeometry = { renderHeight: number; geometryHeight: number; morphToCircle: number };

export function WorkspaceViewerMapPane({
  showResizeHandle,
  showSideResizeHandle,
  onVerticalResizeStart,
  onSideResizeStart,
  minimapContainerRef,
  minimapContainerStyle,
  title,
  minimapType,
  circular,
  effectiveMapShape,
  webglMapGeometry,
  hideMinimap,
  alternateMinimapContent,
  mountWebglMap,
  actualWebGLMapVisible,
  mapCameraZoomVisible,
  mapShapeControlMode,
  minMinimapGeometry,
  maxMinimap,
  minimapGeometryHeight,
  mapRenderMorphToCircle,
  webglCameraZoom,
  webglCameraZoomBounds,
  webglCameraZoomSource,
  isWebglSyncLocked,
  lastViewportCenterRef,
  minimapRef,
  patchSeqView,
  onMapShapeChange,
  onMorphToCircleChange,
  onGeometryHeightChange,
  onMapZoomChange,
  webglMap,
  mapControls,
  mapOverlay,
}: {
  showResizeHandle: boolean;
  showSideResizeHandle: boolean;
  onVerticalResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onSideResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  minimapContainerRef: Ref<HTMLDivElement>;
  minimapContainerStyle: CSSProperties;
  title?: string;
  minimapType: string;
  circular: boolean;
  effectiveMapShape: SequenceMapShape;
  webglMapGeometry: MapGeometry;
  hideMinimap: boolean;
  alternateMinimapContent?: ReactNode;
  mountWebglMap: boolean;
  actualWebGLMapVisible: boolean;
  mapCameraZoomVisible: boolean;
  mapShapeControlMode: NonNullable<
    import('react').ComponentProps<typeof SequenceMinimapShapeControl>['mode']
  >;
  minMinimapGeometry: number;
  maxMinimap: number;
  minimapGeometryHeight: number;
  mapRenderMorphToCircle: number;
  webglCameraZoom: number;
  webglCameraZoomBounds: { min: number; max: number };
  webglCameraZoomSource?: WebglMapZoomSource;
  isWebglSyncLocked: boolean;
  lastViewportCenterRef: { current: number | null };
  minimapRef: { current: WebGLMapHandle | null };
  patchSeqView: (patch: { scrollSynced: boolean }) => void;
  onMapShapeChange: (shape: SequenceMapShape) => void;
  onMorphToCircleChange: (morph: number) => void;
  onGeometryHeightChange: (height: number) => void;
  onMapZoomChange: (zoom: number) => void;
  webglMap: ReactNode;
  mapControls?: ReactNode;
  mapOverlay?: ReactNode;
}): ReactNode {
  return (
    <>
      {showResizeHandle ? (
        <div
          data-testid="sequence-minimap-resize-handle"
          onMouseDown={onVerticalResizeStart}
          style={{
            order: 1,
            height: 4,
            flexShrink: 0,
            backgroundColor: 'hsl(var(--color-border))',
            cursor: 'ns-resize',
          }}
          title="Drag to resize"
        />
      ) : null}

      {showSideResizeHandle ? (
        <div
          data-testid="sequence-map-side-resize-handle"
          onMouseDown={onSideResizeStart}
          style={{
            order: 1,
            width: 4,
            flexShrink: 0,
            backgroundColor: 'hsl(var(--color-border))',
            cursor: 'ew-resize',
          }}
          title="Drag to resize"
        />
      ) : null}

      <div
        ref={minimapContainerRef}
        data-testid="sequence-minimap"
        data-sequence-map-surface="map"
        data-sequence-wheel-zoom-scope=""
        data-minimap-type={minimapType}
        data-circular={circular ? 'true' : 'false'}
        data-map-shape={effectiveMapShape}
        data-morph-to-circle={String(webglMapGeometry.morphToCircle)}
        data-webgl-geometry-height={String(webglMapGeometry.geometryHeight)}
        title={title}
        style={minimapContainerStyle}
      >
        {hideMinimap ? (
          <div style={{ height: '100%', overflow: 'auto' }}>{alternateMinimapContent}</div>
        ) : !mountWebglMap ? null : (
          webglMap
        )}
        {actualWebGLMapVisible ? mapOverlay : null}
        {actualWebGLMapVisible ? (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 12,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              maxWidth: 'calc(100% - 16px)',
            }}
          >
            <button
              type="button"
              className="webgl-sync-lock-toggle wp-interactive"
              data-testid="webgl-sync-lock-toggle"
              data-sync-state={isWebglSyncLocked ? 'on' : 'off'}
              aria-pressed={isWebglSyncLocked}
              onClick={(e) => {
                e.stopPropagation();
                const nextLocked = !isWebglSyncLocked;
                patchSeqView({ scrollSynced: nextLocked });
                if (nextLocked && lastViewportCenterRef.current !== null) {
                  minimapRef.current?.setViewCenter?.(lastViewportCenterRef.current - 1);
                }
              }}
              title={
                isWebglSyncLocked
                  ? 'Scroll sync ON — canvas and WebGL scroll positions stay synced together'
                  : 'Scroll sync OFF — canvas and WebGL scroll independently'
              }
            >
              <span className="webgl-sync-lock-toggle-label">Scroll sync</span>
              <span className="webgl-sync-lock-toggle-state">
                {isWebglSyncLocked ? 'On' : 'Off'}
              </span>
            </button>
            {mapControls}
          </div>
        ) : null}
        {actualWebGLMapVisible ? (
          <>
            {circular ? (
              <div
                data-testid="map-pane-topology-corner-control"
                className="map-pane-corner-control map-pane-corner-control--left"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <SequenceMinimapShapeControl
                  geometryHeight={minimapGeometryHeight}
                  minHeight={minMinimapGeometry}
                  maxHeight={maxMinimap}
                  mapShape={effectiveMapShape}
                  morphToCircle={mapRenderMorphToCircle}
                  mode={mapShapeControlMode}
                  onMapShapeChange={onMapShapeChange}
                  onMorphToCircleChange={onMorphToCircleChange}
                  onGeometryHeightChange={onGeometryHeightChange}
                />
              </div>
            ) : null}
            {mapCameraZoomVisible ? (
              <div
                data-testid="map-pane-zoom-corner-control"
                className="map-pane-corner-control map-pane-corner-control--right"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <SequenceMapPaneControls
                  mapZoomVisible={mapCameraZoomVisible}
                  mapZoom={webglCameraZoom}
                  mapZoomBounds={webglCameraZoomBounds}
                  mapZoomSource={webglCameraZoomSource}
                  onMapZoomChange={onMapZoomChange}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}

export function workspaceViewerMapMorphToCircle(
  mapTopologyCircular: boolean,
  morphToCircle: number
): number {
  return mapTopologyCircular ? morphToCircle : 0;
}
