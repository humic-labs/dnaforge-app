import type { BrowserWindow } from 'electron';

export interface RendererUiObservation {
  canvasState: unknown;
  designState?: unknown;
  sequenceRender?: unknown;
  tabElements: Array<{
    id: string | null;
    label: string;
    type: string | null;
    selected: boolean;
    visible: boolean;
    testId: string | null;
  }>;
  tabLabels: string[];
  visibleTabLabels: string[];
  target?: {
    label: string;
    domPresent: boolean;
    domVisible: boolean;
    storePresent: boolean;
  };
}

export async function observeRendererUi(
  mainWindow: BrowserWindow,
  targetLabel?: string,
  targetDesignId?: string
): Promise<RendererUiObservation> {
  if (mainWindow.isDestroyed()) {
    throw new Error('Renderer window is not available.');
  }

  return mainWindow.webContents.executeJavaScript(
    buildRendererUiObservationScript(targetLabel, targetDesignId),
    true
  ) as Promise<RendererUiObservation>;
}

function buildRendererUiObservationScript(targetLabel?: string, targetDesignId?: string): string {
  return `
    (() => {
      const targetLabel = ${JSON.stringify(targetLabel ?? null)};
      const targetDesignId = ${JSON.stringify(targetDesignId ?? null)};
      const tabElements = Array.from(document.querySelectorAll('[role="tab"]')).map((element) => {
        const html = element;
        const rect = html.getBoundingClientRect();
        const style = window.getComputedStyle(html);
        const label = html.getAttribute('data-tab-label') || (html.textContent || '').trim();
        return {
          id: html.getAttribute('data-tab-id'),
          label,
          type: html.getAttribute('data-tab-type'),
          selected: html.getAttribute('aria-selected') === 'true',
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0 &&
            rect.width > 0 &&
            rect.height > 0,
          testId: html.getAttribute('data-testid'),
        };
      });
      const canvasState = window.__test?.getCanvasState?.() ?? null;
      const storeTabEntries = Array.isArray(canvasState?.panels)
        ? canvasState.panels.flatMap((panel) =>
            Array.isArray(panel?.tabs)
              ? panel.tabs.map((tab) => ({
                  panelId: panel?.id ?? null,
                  activeTabId: panel?.activeTabId ?? null,
                  tab,
                  active: panel?.activeTabId === tab?.id,
                }))
              : []
          )
        : [];
      const storeTabs = storeTabEntries.map((entry) => entry.tab);
      const rectOf = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: Number(rect.x.toFixed(1)),
          y: Number(rect.y.toFixed(1)),
          w: Number(rect.width.toFixed(1)),
          h: Number(rect.height.toFixed(1)),
        };
      };
      const isVisibleElement = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const canvasSummary = (canvas) => {
        const rect = rectOf(canvas);
        return {
          widthAttr: canvas.width,
          heightAttr: canvas.height,
          clientRect: rect,
          visible: isVisibleElement(canvas),
          nonDefaultBacking: canvas.width !== 300 || canvas.height !== 150,
        };
      };
      const rectsOverlap = (a, b) => {
        if (!a || !b) return false;
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      };
      const safeWebglSnapshot = () => {
        const fn = window.__webglStateSnapshot;
        if (typeof fn !== 'function') return null;
        try {
          return fn();
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      };
      const loadedSequences = window.__test?.getLoadedSequences?.() ?? null;
      const buildSequenceRenderObservation = () => {
        if (!targetLabel) return null;
        const entry = storeTabEntries.find((item) => item?.tab?.label === targetLabel);
        if (!entry?.tab || entry.tab.type !== 'sequence') {
          return {
            label: targetLabel,
            rendered: false,
            reason: entry?.tab ? 'target_not_sequence_tab' : 'target_sequence_tab_not_found',
          };
        }

        const host = document.getElementById('tab-content-' + entry.tab.id);
        const viewer = host?.querySelector('[data-testid="sequence-viewer-container"]') ?? null;
        const minimap = host?.querySelector('[data-testid="sequence-minimap"]') ?? null;
        const canvases = Array.from((minimap ?? host)?.querySelectorAll('canvas') ?? []).map(
          canvasSummary
        );
        const visibleCanvases = canvases.filter((canvas) => canvas.visible);
        const loadedSequence =
          Array.isArray(loadedSequences?.sequences) && typeof entry.tab.entityId === 'string'
            ? loadedSequences.sequences.find(
                (sequence) => sequence.documentId === entry.tab.entityId
              ) ?? null
            : null;
        const webglSnapshot = safeWebglSnapshot();
        const minimapRect = rectOf(minimap);
        const webglInstances = Array.isArray(webglSnapshot?.instances)
          ? webglSnapshot.instances.map((instance) => {
              const canvasRect = instance?.app?.canvasEl?.clientRect ?? null;
              const genome = instance?.genome ?? null;
              const lengthMatches =
                !loadedSequence?.length || genome?.length === loadedSequence.length;
              return {
                instanceId: instance?.instanceId ?? null,
                visible: instance?.visible === true,
                frameCount: instance?.frameCount ?? 0,
                msSinceLastFrame: instance?.msSinceLastFrame ?? null,
                appAlive: instance?.app?.alive === true,
                stageChildren: instance?.app?.stageChildren ?? null,
                canvasRect,
                canvasPresent: instance?.app?.canvasEl !== null,
                overlapsMinimap: rectsOverlap(canvasRect, minimapRect),
                genome: genome
                  ? {
                      name: genome.name ?? null,
                      length: genome.length ?? null,
                      featureCount: genome.featureCount ?? null,
                      primerCount: genome.primerCount ?? null,
                    }
                  : null,
                matchesTarget: Boolean(lengthMatches && rectsOverlap(canvasRect, minimapRect)),
              };
            })
          : [];
        const matchingWebglInstances = webglInstances.filter((instance) => instance.matchesTarget);
        const webglReady = matchingWebglInstances.some(
          (instance) =>
            instance.visible &&
            instance.appAlive &&
            instance.canvasPresent &&
            instance.frameCount > 0 &&
            (instance.stageChildren ?? 0) > 0
        );
        const minimapType = minimap?.getAttribute('data-minimap-type') ?? null;
        const structuralReady =
          entry.active === true &&
          host?.isConnected === true &&
          isVisibleElement(host) &&
          viewer !== null &&
          isVisibleElement(viewer) &&
          minimap !== null &&
          isVisibleElement(minimap) &&
          visibleCanvases.length > 0;
        const canvas2dReady = visibleCanvases.some((canvas) => canvas.nonDefaultBacking);
        const rendered =
          minimapType === 'webgl'
            ? structuralReady && webglReady
            : structuralReady && minimapType !== 'hidden' && canvas2dReady;
        const reason = rendered
          ? null
          : !entry.active
            ? 'target_tab_not_active'
            : host?.isConnected !== true
              ? 'target_tab_host_not_connected'
              : viewer === null
                ? 'sequence_viewer_missing'
                : minimap === null
                  ? 'sequence_minimap_missing'
                  : visibleCanvases.length === 0
                    ? 'sequence_canvas_missing_or_hidden'
                    : minimapType === 'webgl' && !webglSnapshot
                      ? 'webgl_snapshot_unavailable'
                      : minimapType === 'webgl' && !webglReady
                        ? 'webgl_instance_not_ready'
                        : !canvas2dReady
                          ? 'canvas_not_sized'
                          : 'unknown';

        return {
          label: targetLabel,
          rendered,
          reason,
          tabId: entry.tab.id ?? null,
          panelId: entry.panelId,
          entityId: entry.tab.entityId ?? null,
          active: entry.active === true,
          hostConnected: host?.isConnected === true,
          hostVisible: isVisibleElement(host),
          viewerPresent: viewer !== null,
          viewerVisible: isVisibleElement(viewer),
          minimapPresent: minimap !== null,
          minimapVisible: isVisibleElement(minimap),
          minimapType,
          minimapRect,
          canvasCount: canvases.length,
          visibleCanvasCount: visibleCanvases.length,
          canvases,
          loadedSequence: loadedSequence
            ? {
                path: loadedSequence.path,
                name: loadedSequence.name ?? null,
                length: loadedSequence.length ?? null,
                circular: loadedSequence.circular ?? null,
                annotationCount: loadedSequence.annotationCount ?? null,
                dirty: loadedSequence.dirty ?? null,
              }
            : null,
          webgl: {
            snapshotAvailable: !!webglSnapshot && !webglSnapshot.error,
            snapshotError: webglSnapshot?.error ?? null,
            instanceCount: webglSnapshot?.instanceCount ?? null,
            visibleCount: webglSnapshot?.visibleCount ?? null,
            matchingInstanceCount: matchingWebglInstances.length,
            ready: webglReady,
            matchingInstances: matchingWebglInstances,
          },
        };
      };
      const observation = {
        canvasState,
        designState: null,
        sequenceRender: buildSequenceRenderObservation(),
        tabElements,
        tabLabels: tabElements.map((tab) => tab.label).filter(Boolean),
        visibleTabLabels: tabElements.filter((tab) => tab.visible).map((tab) => tab.label).filter(Boolean),
      };
      if (targetDesignId) {
        const design = window.__test?.getDesignStore?.()?.designs?.[targetDesignId] ?? null;
        observation.designState = design
          ? {
              id: design.id,
              name: design.name,
              assemblyMethod: design.assemblyMethod,
              assemblyState: design.assemblyState,
              version: design.version,
              regionCount: Array.isArray(design.regions) ? design.regions.length : null,
              homologyRegionCount: Array.isArray(design.homologyRegions) ? design.homologyRegions.length : null,
              goldenGateJunctionCount: Array.isArray(design.goldenGateJunctions) ? design.goldenGateJunctions.length : 0,
              validationErrorCount: Array.isArray(design.validationErrors) ? design.validationErrors.length : null,
              validationErrors: Array.isArray(design.validationErrors)
                ? design.validationErrors.map((error) => ({
                    code: error.code,
                    severity: error.severity,
                    message: error.message,
                    field: error.field ?? null,
                    fragmentIndex: error.fragmentIndex ?? null,
                  }))
                : [],
              regions: Array.isArray(design.regions)
                ? design.regions.map((region) => ({
                    id: region.id,
                    sourceSequenceName: region.sourceSequenceName,
                    sourceStart: region.sourceStart,
                    sourceEnd: region.sourceEnd,
                    length: typeof region.sequence === 'string' ? region.sequence.length : null,
                    annotationCount: Array.isArray(region.annotations) ? region.annotations.length : null,
                    sourceType: region.sourceType ?? null,
                  }))
                : [],
              primerPairCount: Array.isArray(design.designPrimers) ? design.designPrimers.length : null,
              activeDesignId: window.__test?.getDesignStore?.()?.activeDesignId ?? null,
            }
          : null;
      }
      if (targetLabel) {
        observation.target = {
          label: targetLabel,
          domPresent: tabElements.some((tab) => tab.label === targetLabel),
          domVisible: tabElements.some((tab) => tab.label === targetLabel && tab.visible),
          storePresent: storeTabs.some((tab) => tab?.label === targetLabel),
        };
      }
      return observation;
    })()
  `;
}
