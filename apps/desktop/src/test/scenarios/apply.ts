import { vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { useCanvasStore } from '../../features/canvas/store';
import { useDesignStore } from '../../features/design/store';
import { useRichSequenceClipboardStore } from '../../features/sequence-clipboard/store';
import type { SequenceDesign } from '../../features/design/types';
import { useSequenceStore } from '../../features/sequence/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { _resetToolboxState } from '../../hooks/useToolboxStatus';
import { setMockFileContent, clearFileTree } from '../platform-mocks';
import { applyAlignmentScenario, resetAlignmentScenarioState } from './apply-alignment';
import type { AppScenario } from './types';

export function resetAllStores(): void {
  _resetToolboxState();

  useCanvasStore.setState({
    panels: {
      main: { id: 'main', tabs: [], activeTabId: null },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });

  useSequenceStore.getState().clearAll();

  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  useRichSequenceClipboardStore.getState().clear();

  useWorkspaceStore.setState({
    folders: [],
    activeWorkspaceFile: null,
    expandedPaths: new Set(),
    selectedPath: null,
    isLoading: false,
    error: null,
  });

  resetAlignmentScenarioState();

  clearFileTree();
}

export function applyScenario(scenario: AppScenario): void {
  resetAllStores();

  if (scenario.sidecar) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => scenario.sidecar,
    });
  }

  if (scenario.canvas) {
    const tabs = scenario.canvas.tabs.map((t) => ({
      ...t,
      id: crypto.randomUUID(),
    }));

    const activeTabId = tabs[scenario.canvas.activeTabIndex ?? 0]?.id ?? null;

    if (scenario.canvas.layout === 'three-column' && tabs.length >= 3) {
      const panelIds = ['chat', 'paper', 'protocol'];
      useCanvasStore.setState({
        panels: Object.fromEntries(
          panelIds.map((panelId, index) => [
            panelId,
            {
              id: panelId,
              tabs: index === 2 ? tabs.slice(2) : [tabs[index]],
              activeTabId: tabs[index]?.id ?? null,
            },
          ])
        ),
        layout: {
          type: 'split',
          direction: 'vertical',
          children: panelIds.map((panelId) => ({ type: 'panel' as const, panelId })),
          sizes: [32, 34, 34],
        },
        focusedPanelId: panelIds[0],
      });
    } else if (scenario.canvas.layout === 'split-vertical' && tabs.length >= 2) {
      const leftPanelId = 'left';
      const rightPanelId = 'right';
      useCanvasStore.setState({
        panels: {
          [leftPanelId]: {
            id: leftPanelId,
            tabs: [tabs[0]],
            activeTabId: tabs[0].id,
          },
          [rightPanelId]: {
            id: rightPanelId,
            tabs: tabs.slice(1),
            activeTabId: tabs[1]?.id ?? null,
          },
        },
        layout: {
          type: 'split',
          direction: 'vertical',
          children: [
            { type: 'panel', panelId: leftPanelId },
            { type: 'panel', panelId: rightPanelId },
          ],
          sizes: [50, 50],
        },
        focusedPanelId: (scenario.canvas.activeTabIndex ?? 0) === 0 ? leftPanelId : rightPanelId,
      });
    } else if (scenario.canvas.layout === 'split-horizontal' && tabs.length >= 2) {
      const topPanelId = 'top';
      const bottomPanelId = 'bottom';
      useCanvasStore.setState({
        panels: {
          [topPanelId]: {
            id: topPanelId,
            tabs: [tabs[0]],
            activeTabId: tabs[0].id,
          },
          [bottomPanelId]: {
            id: bottomPanelId,
            tabs: tabs.slice(1),
            activeTabId: tabs[1]?.id ?? null,
          },
        },
        layout: {
          type: 'split',
          direction: 'horizontal',
          children: [
            { type: 'panel', panelId: topPanelId },
            { type: 'panel', panelId: bottomPanelId },
          ],
          sizes: [50, 50],
        },
        focusedPanelId: (scenario.canvas.activeTabIndex ?? 0) === 0 ? topPanelId : bottomPanelId,
      });
    } else {
      useCanvasStore.setState({
        panels: {
          main: { id: 'main', tabs, activeTabId },
        },
        layout: { type: 'panel', panelId: 'main' },
        focusedPanelId: 'main',
      });
    }
  }

  if (scenario.sequences) {
    for (const [documentId, sequence] of Object.entries(scenario.sequences)) {
      useSequenceStore.getState().setSequence(documentId, sequence);
    }
  }

  if (scenario.designs) {
    useDesignStore.setState({
      designs: normalizeScenarioDesigns(scenario.designs.designs),
      activeDesignId: scenario.designs.activeDesignId ?? null,
      pendingDispatchId: scenario.designs.pendingDispatchId ?? null,
    });
    const clipboard = useRichSequenceClipboardStore.getState();
    if (scenario.designs.lastCopied) {
      clipboard.setCopiedRegion(scenario.designs.lastCopied);
    } else {
      clipboard.clear();
    }
  }

  if (scenario.files) {
    for (const [path, content] of Object.entries(scenario.files)) {
      setMockFileContent(path, content);
    }
  }

  if (scenario.assets) {
    const wpAssetsPath =
      process.env.WP_ASSETS_PATH ?? resolve(__dirname, '../../../../../../wp-assets');
    for (const asset of scenario.assets) {
      const fullPath = resolve(wpAssetsPath, asset.wpAssetsPath);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        setMockFileContent(asset.mountPath, content);
      } else {
        console.warn(`[applyScenario] wp-assets file not found: ${fullPath}`);
      }
    }
  }

  if (scenario.workspace) {
    useWorkspaceStore.setState({
      folders: scenario.workspace.folders.map((f) => ({
        ...f,
        addedAt: Date.now(),
      })),
      selectedPath: scenario.workspace.selectedPath ?? null,
    });
  }

  if (scenario.alignment) {
    applyAlignmentScenario(scenario.alignment);
  }
}

function normalizeScenarioDesigns(
  designs: Record<string, SequenceDesign>
): Record<string, SequenceDesign> {
  return Object.fromEntries(
    Object.entries(designs).map(([id, design]) => [
      id,
      {
        ...design,
        createdAt: new Date(design.createdAt),
        updatedAt: new Date(design.updatedAt),
      },
    ])
  );
}
