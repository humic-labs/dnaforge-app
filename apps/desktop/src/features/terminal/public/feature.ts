import type { RendererFeature } from '../../../feature-registry/renderer-feature';
import { TerminalWorkspace } from '../TerminalWorkspace';

export const terminalRendererFeature: RendererFeature = {
  id: 'terminal',
  views: [
    {
      view: 'terminal',
      Component: TerminalWorkspace,
      placement: 'sidebar',
      screenCategory: 'unknown',
    },
  ],
};
