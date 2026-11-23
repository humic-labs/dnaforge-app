import { describe, it, expect } from 'vitest';
import { CLOSED_BETA_EVENTS, sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import {
  SCIENTIFIC_WORKFLOW_ACTIONS,
  SCIENTIFIC_WORKFLOWS,
} from '../../shared/scientific-workflow-vocab';
import * as eventCatalog from '../analytics-events';

const { ALL_EVENTS } = eventCatalog;

describe('analytics-events catalog', () => {
  it('includes every exported event declaration in the validation inventory', () => {
    const declaredEvents = Object.values(eventCatalog).filter((value) => typeof value === 'string');
    expect([...ALL_EVENTS].sort()).toEqual(declaredEvents.sort());
  });

  it('should have no duplicate event names', () => {
    const unique = new Set(ALL_EVENTS);
    expect(unique.size).toBe(ALL_EVENTS.length);
  });

  it('all event names should be snake_case strings', () => {
    for (const event of ALL_EVENTS) {
      expect(event).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('declares only event names that production code emits', () => {
    expect([...ALL_EVENTS].sort()).toEqual([
      'chat_history_observed',
      'job_management_observed',
      'release_notes_observed',
      'tool_action_completed',
      'tool_action_started',
      'tool_error',
      'tool_opened',
    ]);
  });

  it('should include closed-beta tool usage events', () => {
    expect(ALL_EVENTS).toContain('tool_opened');
    expect(ALL_EVENTS).toContain('tool_action_started');
    expect(ALL_EVENTS).toContain('tool_action_completed');
    expect(ALL_EVENTS).toContain('tool_error');
  });

  it('closed-beta event allowlist stays deliberately small', () => {
    expect(CLOSED_BETA_EVENTS).toEqual([
      'app_first_opened',
      'app_session_started',
      'workspace_created',
      'first_product_action_completed',
      'sample_project_opened',
      'import_started',
      'import_completed',
      'import_failed',
      'error_boundary_triggered',
      'desktop_main_error_captured',
      'sidecar_lifecycle',
      'app_update_check_completed',
      'beta_install_attributed',
      'tool_opened',
      'tool_action_started',
      'tool_action_completed',
      'tool_error',
      'settings_changed',
      'agent_auth_result',
      'screen_viewed',
      'workspace_opened',
      'file_opened',
      'app_update_available',
      'app_update_downloaded',
      'app_update_error',
      'app_update_installed',
      'app_migration_backup',
      'app_migration_result',
      'app_schema_refused',
      'app_oversize_decision',
      'app_session_ended',
      'workflow_action_observed',
      'meaningful_activity_completed',
      'telemetry_payload_rejected',
      'file_open_failed',
      'notebook_migration_result',
      'notebook_external_reload_result',
      'app_update_origin_failed',
      'ai_turn_finished',
      'benchling_migration_attempt_finished',
      'benchling_migration_issue_summary',
      'benchling_migration_run_disposition_changed',
      'interaction_observed',
      'project_lifecycle_observed',
      'feedback_stage',
      'external_access_lifecycle_observed',
      'chat_history_observed',
      'job_management_observed',
      'release_notes_observed',
      'skill_operation_observed',
      'app_update_check_started',
      'app_update_restart_decided',
      'app_update_install_attempt',
      'app_update_download_started',
      'import_wizard_dismissed',
      'sequence_search_observed',
      'app_hang_observed',
      'child_process_gone',
      'app_activity_heartbeat',
      'app_startup_timed',
      'compute_job_observed',
      'genome_view_observed',
      'ngs_read_analysis_observed',
      'background_job_observed',
      'hosted_reference_install_observed',
      'workspace_sync_observed',
      'sequence_translation_copy_observed',
      'sequence_orf_detection_observed',
      'sequence_orf_display_observed',
      'sequence_search_navigation_observed',
      'pdf_stage',
      'workspace_sync_stage',
      'workspace_recovery_stage',
      'workspace_backup_enabled',
      'loop_suppressed',
      'crash_loop_detected',
      'ui_frustration',
      'benchling_migration_attempt_started',
      'notebook_operation_observed',
      'user_notification_observed',
      'agent_auth_state_observed',
      'model_preference_observed',
      'indexed_genome_stage',
      'sanger_read_stage',
    ]);
  });

  it('retains the actual update, migration, oversize, and settings producer properties', () => {
    expect(
      sanitizeClosedBetaProperties({
        setting: 'analytics',
        version: '0.4.0-beta.2',
        download_duration_ms: 12_345,
        error: 'net::ERR_NAME_NOT_RESOLVED https://updates.example.test/latest.yml',
        error_class: 'update_check_failed',
        error_code: 'network',
        stage: 'check',
        reason: 'no-manifest',
        from_version: 14,
        to_version: 15,
        restored_from_backup: true,
        db_version: 20,
        build_version: '0.6.2',
        is_release: true,
        ext_bucket: 'gbk',
        size_bucket: '100-256MB',
        decision: 'deferred-on-rehydrate',
      })
    ).toEqual({
      setting: 'analytics',
      version: '0.4.0-beta.2',
      download_duration_ms: 12_345,
      error_class: 'update_check_failed',
      error_code: 'network',
      stage: 'check',
      reason: 'no-manifest',
      from_version: 14,
      to_version: 15,
      restored_from_backup: true,
      db_version: 20,
      build_version: '0.6.2',
      is_release: true,
      ext_bucket: 'gbk',
      size_bucket: '100-256MB',
      decision: 'deferred-on-rehydrate',
    });
    expect(
      sanitizeClosedBetaProperties({ error_code: 'no_manifest', reason: 'no-manifest' })
    ).toEqual({ error_code: 'no_manifest', reason: 'no-manifest' });
  });

  it('bounds telemetry actor and CI run identifiers', () => {
    expect(
      sanitizeClosedBetaProperties({
        telemetry_actor: ' Maintainer ',
        ci_run_id: '32902696778',
      })
    ).toEqual({ telemetry_actor: 'maintainer' });

    expect(
      sanitizeClosedBetaProperties({
        telemetry_actor: 'ci',
        ci_run_id: '32902696778',
      })
    ).toEqual({ telemetry_actor: 'ci', ci_run_id: '32902696778' });

    expect(
      sanitizeClosedBetaProperties({
        telemetry_actor: 'internal_admin',
        ci_run_id: 'run-with-user-data',
      })
    ).toEqual({});
  });

  it('keeps correlated scientific-operation properties without content identifiers', () => {
    const props = sanitizeClosedBetaProperties({
      feature_area: 'tool_usage',
      tool_id: 'assembly',
      surface: 'tab',
      action: 'computed',
      operation_id: '018f3fd0-0000-7000-8000-000000000042',
      duration_ms: 1234,
      file_name: 'DNA1598_secret.gb',
      sequence: 'ATGCGT',
    });

    expect(props).toEqual({
      feature_area: 'tool_usage',
      tool_id: 'assembly',
      surface: 'tab',
      action: 'computed',
      operation_id: '018f3fd0-0000-7000-8000-000000000042',
      duration_ms: 1234,
    });
  });

  it('keeps only closed semantic navigation, workspace, file, and error values', () => {
    expect(
      sanitizeClosedBetaProperties({
        feature_area: 'navigation',
        screen_category: 'sequence',
        source_surface: 'file_tree',
        workspace_source: 'folder_picker',
        workspace_kind: 'git',
        file_count_bucket: '21_100',
        file_type_category: 'dna',
        size_bucket: '100kb_1mb',
        error_class: 'compute',
      })
    ).toEqual({
      feature_area: 'navigation',
      screen_category: 'sequence',
      source_surface: 'file_tree',
      workspace_source: 'folder_picker',
      workspace_kind: 'git',
      file_count_bucket: '21_100',
      file_type_category: 'dna',
      size_bucket: '100kb_1mb',
      error_class: 'compute',
    });

    expect(
      sanitizeClosedBetaProperties({
        screen_category: 'private_filename',
        file_count_bucket: '12345',
        error_class: 'DNA1598_FILENAME_secret',
      })
    ).toEqual({});
  });

  it('keeps tool telemetry properties on controlled enums only', () => {
    const props = sanitizeClosedBetaProperties({
      feature_area: 'tool_usage',
      tool_id: 'primer_design',
      surface: 'sidebar',
      action: 'created',
      prompt: 'design primers for pUC19',
      file_name: 'secret.gb',
      raw_error: 'Error: /Users/tester/private/file.gb',
    });

    expect(props).toEqual({
      feature_area: 'tool_usage',
      tool_id: 'primer_design',
      surface: 'sidebar',
      action: 'created',
    });
  });

  it('keeps founder operator as a bounded enum and never stores email', () => {
    expect(
      sanitizeClosedBetaProperties({
        telemetry_actor: 'user',
        internal_operator: 'OPERATOR_A',
        email: 'scientist@example.com',
      })
    ).toEqual({ telemetry_actor: 'user', internal_operator: 'operator_a' });
    expect(
      sanitizeClosedBetaProperties({
        telemetry_actor: 'maintainer',
        internal_operator: 'operator_b',
      })
    ).toEqual({ telemetry_actor: 'maintainer', internal_operator: 'operator_b' });
    expect(
      sanitizeClosedBetaProperties({
        telemetry_actor: 'user',
        internal_operator: 'user@example.com',
      })
    ).toEqual({ telemetry_actor: 'user' });
  });

  it('keeps identity kind bounded without exporting an identifier', () => {
    expect(
      sanitizeClosedBetaProperties({
        identity_kind: 'identified',
        account_id: '20010000-0000-4000-8000-000000000003',
      })
    ).toEqual({ identity_kind: 'identified' });
    expect(sanitizeClosedBetaProperties({ identity_kind: 'internal-person@example.com' })).toEqual(
      {}
    );
  });

  it('keeps every scientific workflow and action the emitters actually send', () => {
    for (const workflow of SCIENTIFIC_WORKFLOWS) {
      expect(sanitizeClosedBetaProperties({ workflow })).toEqual({ workflow });
    }
    for (const workflow_action of SCIENTIFIC_WORKFLOW_ACTIONS) {
      expect(sanitizeClosedBetaProperties({ workflow_action })).toEqual({ workflow_action });
    }
    expect(
      sanitizeClosedBetaProperties({
        workflow: 'search',
        workflow_action: 'search',
        workflow_status: 'success',
      })
    ).toEqual({
      workflow: 'search',
      workflow_action: 'search',
      workflow_status: 'success',
    });
    expect(
      sanitizeClosedBetaProperties({
        workflow: 'file',
        workflow_action: 'open',
        workflow_status: 'viewed',
      })
    ).toEqual({
      workflow: 'file',
      workflow_action: 'open',
      workflow_status: 'viewed',
    });
  });

  it('keeps current-release updater origin index and notebook migration identity', () => {
    expect(sanitizeClosedBetaProperties({ origin_index: 0, stage: 'download' })).toEqual({
      origin_index: 0,
      stage: 'download',
    });
    expect(sanitizeClosedBetaProperties({ origin_index: 2, stage: 'check' })).toEqual({
      origin_index: 2,
      stage: 'check',
    });
    expect(
      sanitizeClosedBetaProperties({
        feature_area: 'reliability',
        workflow_status: 'success',
        version: 2,
        source: 'database-only',
        outcome: 'success',
        success: true,
      })
    ).toEqual({
      feature_area: 'reliability',
      workflow_status: 'success',
      version: 2,
      source: 'database-only',
      outcome: 'success',
      success: true,
    });
    expect(
      sanitizeClosedBetaProperties({
        feature_area: 'reliability',
        version: '2',
        source: 'json-authority-package',
        outcome: 'started',
        workflow_status: 'started',
      })
    ).toEqual({
      feature_area: 'reliability',
      version: '2',
      source: 'json-authority-package',
      outcome: 'started',
      workflow_status: 'started',
    });
  });

  it('keeps beta attribution properties pseudonymous and controlled', () => {
    const props = sanitizeClosedBetaProperties({
      feature_area: 'tool_usage',
      beta_invite_id: 'bti_0123456789abcdef',
      beta_cohort: 'closed_beta',
      invite_batch: 'manual_onboarding',
      email: 'person@example.com',
      beta_token: 'dummy-token',
    });

    expect(props).toEqual({
      feature_area: 'tool_usage',
      beta_invite_id: 'bti_0123456789abcdef',
      beta_cohort: 'closed_beta',
      invite_batch: 'manual_onboarding',
    });
  });

  it('drops unknown tool IDs, surfaces, and actions', () => {
    const props = sanitizeClosedBetaProperties({
      feature_area: 'tool_usage',
      tool_id: 'primers:selected-secret-lab',
      surface: 'toolbar',
      action: 'typed_raw_prompt',
    });

    expect(props).toEqual({ feature_area: 'tool_usage' });
  });

  it('drops non-string diagnostic codes instead of manufacturing unknown values', () => {
    expect(
      sanitizeClosedBetaProperties({
        close_reason: { raw: 'window-path' },
        rejected_event: ['private-event'],
      })
    ).toEqual({});
    expect(
      sanitizeClosedBetaProperties({
        close_reason: 'invalid value',
        rejected_event: 'valid_code',
      })
    ).toEqual({ close_reason: 'unknown', rejected_event: 'valid_code' });
  });

  it('drops the retired outbound consent-state property', () => {
    expect(
      sanitizeClosedBetaProperties({
        feature_area: 'settings',
        analytics_consent_state: 'opted_out',
      })
    ).toEqual({ feature_area: 'settings' });
  });
});
