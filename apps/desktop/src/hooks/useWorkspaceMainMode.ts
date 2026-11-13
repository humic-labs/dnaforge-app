import { useCanvasStore } from '../features/canvas';
import type { ActivityView } from '../components/ActivityBar';
import { isRendererFeatureView } from '../feature-registry';

export function useWorkspaceMainMode(activeView: ActivityView, sidebarVisible: boolean) {
  const settingsViewActive = activeView === 'settings';
  const homeViewActive = activeView === 'home';
  const referencesViewActive = activeView === 'references';
  const terminalViewActive = activeView === 'terminal';
  const featureViewActive = isRendererFeatureView(activeView);
  const hasOpenTabs = useCanvasStore((s) =>
    Object.values(s.panels).some((panel) => panel.tabs.length > 0)
  );
  const emptyFilesHomeActive = activeView === 'files' && !hasOpenTabs;
  const homeWorkbenchActive = homeViewActive || emptyFilesHomeActive;
  const workspaceTakeoverActive =
    settingsViewActive ||
    homeViewActive ||
    referencesViewActive ||
    featureViewActive ||
    terminalViewActive;
  const sidebarChromeVisible = sidebarVisible && !workspaceTakeoverActive;
  return {
    settingsViewActive,
    homeViewActive,
    referencesViewActive,
    terminalViewActive,
    featureViewActive,
    hasOpenTabs,
    emptyFilesHomeActive,
    homeWorkbenchActive,
    workspaceTakeoverActive,
    sidebarChromeVisible,
  };
}
