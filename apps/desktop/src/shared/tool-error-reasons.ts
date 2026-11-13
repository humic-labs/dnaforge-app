export const TOOL_ERROR_REASON_CODES = [
  'stale_design',
  'draft_required',
  'output_exists',
  'precondition_failed',
  'filesystem_error',
  'projection_failed',
  'export_failed',
] as const;

export type ToolErrorReasonCode = (typeof TOOL_ERROR_REASON_CODES)[number];
