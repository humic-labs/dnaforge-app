import { ActionMenu } from '../../../components/ActionMenu';
import { useCanvasStore } from '../store';
import { useTabMenuPanels } from '../tab-menu-presentation';

interface TabBarContextMenuProps {
  position: { x: number; y: number };
  panelId: string;
  onClose: () => void;
}

export function TabBarContextMenu({ position, panelId, onClose }: TabBarContextMenuProps) {
  const panels = useTabMenuPanels();
  const mergePanels = useCanvasStore((s) => s.mergePanels);
  const otherPanels = Object.entries(panels).filter(([id]) => id !== panelId);
  const getPanelLabel = (panel: (typeof panels)[string]): string => {
    if (panel.tabs.length === 0) return 'Empty pane';
    if (panel.tabs.length === 1) return panel.tabs[0].label;
    return `${panel.tabs[0].label} (+${panel.tabs.length - 1})`;
  };
  return (
    <ActionMenu
      open
      label="Tab bar actions"
      anchorPoint={position}
      onClose={onClose}
      testId="tabbar-context-menu"
      entries={[
        {
          id: 'merge-pane',
          label: 'Merge tabs with...',
          disabled: otherPanels.length === 0,
          children: otherPanels.map(([id, panel]) => ({
            id,
            label: getPanelLabel(panel),
            onSelect: () => mergePanels(panelId, id),
          })),
        },
      ]}
    />
  );
}
