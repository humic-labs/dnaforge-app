import { toUserMessage, userMessage, type UserMessage } from '@waypoint/user-messages';

export const MOLSTAR_VIEWER_GENERIC_RENDER_ERROR = userMessage('structure.failed');
export const CANCELLED_VIEWER_LOAD_ERROR = '__waypoint_molstar_viewer_load_cancelled__';

export function formatMolstarViewerDisplayError(error: unknown): UserMessage | null {
  if (
    error == null ||
    error === CANCELLED_VIEWER_LOAD_ERROR ||
    (typeof error === 'string' && !error.trim())
  )
    return null;
  return toUserMessage(error, 'structure.failed');
}
