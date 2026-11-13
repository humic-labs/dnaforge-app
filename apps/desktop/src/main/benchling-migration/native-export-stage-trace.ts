const NATIVE_EXPORT_STAGE_TRACE_ENV = 'DNAFORGE_BENCHLING_NATIVE_EXPORT_STAGE_TRACE';

export type TargetedReadIdentityTraceReason =
  | 'root_identity'
  | 'protocol_view_url'
  | 'edit_url'
  | 'web_url'
  | 'envelope_shape';

export type TargetedReadIdentityTraceCheck =
  | 'root_identity'
  | 'field_shape'
  | 'url_parse'
  | 'organization_boundary'
  | 'path_binding'
  | 'query_collision'
  | 'alias_conflict'
  | 'envelope_shape';

type NativeExportEntryTracePhase =
  | 'catalog'
  | 'control'
  | 'walk'
  | 'persist_walk'
  | 'entry_preview';
type NativeExportEntryTraceStage = `${NativeExportEntryTracePhase}_entry_${'start' | 'complete'}`;
type NativeExportStage =
  | NativeExportEntryTraceStage
  | 'invoke_accepted'
  | 'artifact_verify_start'
  | 'artifact_verify_complete'
  | 'decode_first_inspect_start'
  | 'decode_first_inspect_complete'
  | 'bind_archive_start'
  | 'bind_archive_complete'
  | 'list_catalog_start'
  | 'list_catalog_complete'
  | 'decode_control_read_start'
  | 'decode_control_read_complete'
  | 'empty_control_pass_start'
  | 'empty_control_pass_complete'
  | 'control_pass_start'
  | 'control_pass_complete'
  | 'decode_walk_start'
  | 'walk_entry_stream_open'
  | 'walk_entry_stream_complete'
  | 'walk_entry_semantic_complete'
  | 'walk_complete'
  | 'decode_walk_complete'
  | 'selected_source_object_candidates'
  | 'selected_notebook_html_candidates'
  | 'selected_notebook_attachment_like_html_candidates'
  | 'selected_notebook_pdf_candidates'
  | 'selected_notebook_docx_candidates'
  | 'selected_notebook_text_candidates'
  | 'selected_notebook_other_candidates'
  | 'selected_notebook_primary_candidates'
  | 'selected_notebook_weak_identity_missing'
  | 'local_archive_failure'
  | 'local_decode_failure'
  | 'local_scope_failure'
  | 'local_unexpected_failure'
  | 'second_inspect_start'
  | 'second_inspect_complete'
  | 'second_persist_start'
  | 'second_persist_complete';

export type NativeExportStageTraceFacts = {
  ordinal?: number;
  count?: number;
  empty?: boolean;
};

export function traceNativeExportStage(
  stage: NativeExportStage,
  facts: NativeExportStageTraceFacts = {}
): void {
  if (process.env[NATIVE_EXPORT_STAGE_TRACE_ENV] !== '1') return;
  console.info('[benchling-native-export-stage]', {
    stage,
    ...(facts.ordinal === undefined ? {} : { ordinal: facts.ordinal }),
    ...(facts.count === undefined ? {} : { count: facts.count }),
    ...(facts.empty === undefined ? {} : { empty: facts.empty }),
  });
}

export function traceTargetedReadIdentityFailure(
  reason: TargetedReadIdentityTraceReason,
  check: TargetedReadIdentityTraceCheck
): void {
  if (process.env[NATIVE_EXPORT_STAGE_TRACE_ENV] !== '1') return;
  console.info('[benchling-targeted-read-stage]', {
    stage: 'envelope_identity',
    reason,
    check,
  });
}
