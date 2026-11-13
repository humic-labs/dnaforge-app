import { isTabDirty } from '../../canvas/public/artifact-document-lifecycle';
   
                                        
   

import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { useCanvasStore } from '../../canvas/public/store';
import { requestTabClose } from '../../canvas/public/artifact-document-lifecycle';

export const closeTabSchema = z.object({}).strict();

export const closeTabOutputSchema = z.object({
  ok: z.literal(true),
  closed: z.boolean(),
  message: z.string().optional(),
});

export const closeTabTool = resultTool({
  description: 'Close the currently active tab.',
  inputSchema: closeTabSchema as z.ZodTypeAny,
  execute: async (_params: z.infer<typeof closeTabSchema>) => {
    const store = useCanvasStore.getState();
    const { focusedPanelId, panels } = store;

    if (!focusedPanelId) {
      return toolSuccess({ closed: false, message: 'No panel focused' });
    }

                                                           
                                                                   
                                                       
    const focusedPanel = panels[focusedPanelId];
    const focusedActive = focusedPanel?.tabs.find((t) => t.id === focusedPanel.activeTabId);
    if (focusedActive && focusedActive.type !== 'chat') {
      if (isTabDirty(focusedActive)) {
        requestTabClose(focusedPanelId, focusedActive.id);
        return {
          ...toolFailure({
            code: 'CONFIRMATION_REQUIRED',
            error: 'Unsaved changes require confirmation before this tab can close.',
            retriable: false,
            stateChanged: true,
            partialEffects: ['close-confirmation-requested'],
          }),
          closed: false,
          confirmationRequired: true,
          message: 'Unsaved changes require confirmation before this tab can close.',
        };
      }
      store.closeTab(focusedPanelId, focusedActive.id);
      return toolSuccess({ closed: true });
    }

                                                                                 
                                                                                 
                                                                                
                                                                              
                                      
    const contentPanelEntries = Object.entries(panels).filter(([, p]) =>
      p.tabs.some((t) => t.type !== 'chat')
    );
    if (contentPanelEntries.length > 0) {
      const [contentPanelId, contentPanel] = contentPanelEntries[contentPanelEntries.length - 1];
      const activeContent = contentPanel.tabs.find(
        (t) => t.id === contentPanel.activeTabId && t.type !== 'chat'
      );
      const target =
        activeContent ?? contentPanel.tabs.filter((t) => t.type !== 'chat').slice(-1)[0];
      if (target) {
        if (isTabDirty(target)) {
          requestTabClose(contentPanelId, target.id);
          return {
            ...toolFailure({
              code: 'CONFIRMATION_REQUIRED',
              error: 'Unsaved changes require confirmation before this tab can close.',
              retriable: false,
              stateChanged: true,
              partialEffects: ['close-confirmation-requested'],
            }),
            closed: false,
            confirmationRequired: true,
            message: 'Unsaved changes require confirmation before this tab can close.',
          };
        }
        store.closeTab(contentPanelId, target.id);
        return toolSuccess({ closed: true });
      }
    }

    return toolSuccess({ closed: false, message: 'No tab open to close' });
  },
});
