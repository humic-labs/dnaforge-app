import { createGetWorkspaceTool } from '../../ai/public/tools/get-workspace';
import { GET_WORKSPACE_DESCRIPTION } from '../../ai/public/tools/get-workspace';
import {
  createAppViewsTool,
  appViewsSchema,
  appViewsOutputSchema,
} from '../../ai/public/tools/app-views';
import {
  createNotebookDocumentTool,
  notebookDocumentSchema,
  notebookDocumentOutputSchema,
  notebookInputSchemaOptions,
} from '../../ai/public/tools/notebook-document';
import {
  createWorkspaceProjectsTool,
  workspaceProjectsSchema,
  workspaceProjectsOutputSchema,
} from '../../ai/public/tools/workspace-projects';
import {
  createWorkspaceFilesTool,
  workspaceFilesSchema,
  workspaceFilesOutputSchema,
  WORKSPACE_FILES_DESCRIPTION,
} from '../../ai/public/tools/workspace-files';
import {
  createFileDocumentTool,
  fileDocumentSchema,
  fileDocumentOutputSchema,
  FILE_DOCUMENT_DESCRIPTION,
} from '../../ai/public/tools/file-document';
import {
  createGetRemoteHostsTool,
  createManageRemoteHostTool,
  getRemoteHostsSchema,
  getRemoteHostsOutputSchema,
  manageRemoteHostSchema,
  manageRemoteHostOutputSchema,
  GET_REMOTE_HOSTS_DESCRIPTION,
  MANAGE_REMOTE_HOST_DESCRIPTION,
} from '../../ai/public/tools/remote-hosts';
import { agentFeedbackReceiptSchema } from '../../../shared/agent-feedback';
import {
  closeTabSchema,
  closeTabOutputSchema,
  closeTabTool,
} from '../../ai/public/tools/close-tab';
import {
  createGetFileChangesTool,
  getFileChangesSchema,
  getFileChangesOutputSchema,
} from '../../ai/public/tools/get-file-changes';
import {
  createListFilesTool,
  listFilesSchema,
  listFilesOutputSchema,
} from '../../ai/public/tools/list-files';
import {
  createReadFileTool,
  readFileSchema,
  readFileOutputSchema,
  READ_FILE_DESCRIPTION,
} from '../../ai/public/tools/read-file';
import {
  createSearchSkillsTool,
  searchSkillsSchema,
  SEARCH_SKILLS_DESCRIPTION,
  searchSkillsOutputSchema,
} from '../../ai/public/tools/search-skills';
import {
  createReportAppFeedbackTool,
  agentFeedbackSchema,
  REPORT_APP_FEEDBACK_DESCRIPTION,
} from '../../ai/public/tools/report-app-feedback';
import {
  configureExternalAgentAccessSchema,
  configureExternalAgentAccessOutputSchema,
  externalAgentAccessOutputSchema,
  createConfigureExternalAgentAccessTool,
  createGetExternalAgentAccessTool,
  getExternalAgentAccessSchema,
} from '../../ai/public/tools/external-agent-access';
import { getWorkspaceSchema, getWorkspaceOutputSchema } from '../../ai/public/tools/get-workspace';
import {
  createImportEntitiesTool,
  importEntitiesSchema,
  importEntitiesOutputSchema,
} from '../../ai/public/tools/import-entities';
import {
  externalFetchSchema,
  externalFetchOutputSchema,
} from '../../ai/public/tools/external-fetch';
import {
  externalXrefSchema,
  externalXrefTool,
  externalXrefOutputSchema,
} from '../../ai/public/tools/external-xref';
import {
  observeAppStateSchema,
  observeAppStateOutputSchema,
  observeAppStateTool,
} from '../../ai/public/tools/observe-app-state';
import {
  createOpenTabTool,
  openTabSchema,
  openTabOutputSchema,
} from '../../ai/public/tools/open-tab';
import {
  createOpenTerminalTool,
  openTerminalSchema,
  openTerminalOutputSchema,
  OPEN_TERMINAL_DESCRIPTION,
} from '../../ai/public/tools/open-terminal';
import {
  createGetSelectionBasesTool,
  getSelectionBasesSchema,
  getSelectionBasesOutputSchema,
} from '../../ai/public/tools/selection-bases';
import {
  createHighlightRangeTool,
  highlightRangeSchema,
  highlightRangeOutputSchema,
} from '../../ai/public/tools/highlight-range';
import { resultSdkRendererTool, customRendererTool, defineRendererToolCatalog } from './types';
import {
  READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
  resolveImportEntitiesAuthorization,
  handleExternalFetch,
} from './helpers';

export const workspaceTools = defineRendererToolCatalog({
  app_views: {
    name: 'app_views',
    description:
      'Inspect and arrange tabs/panels; list, open, save, rename or duplicate saved views through their human document owner. Inspect-tracks and configure-tracks read and edit sequence annotation layouts through the human Tracks command owner. Inspect the exact view or tracks for their revision before changing them. Modal scope blocking applies; dirty tabs must be saved or discarded before close.',
    shape: 'viz-tab-action',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['modify-tabs', 'write-workspace'],
    audit_required: true,
    effects: ['read-only', 'ui-bound', 'mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    exposure: { kind: 'shared' },
    inputSchema: appViewsSchema,
    resolveInputAuthorization: (args) => {
      const kind = (args as { operation?: { kind?: string } }).operation?.kind;
      return {
        additionalRequiredCapabilities:
          kind === 'inspect' || kind === 'inspect-tracks' || kind === 'list'
            ? []
            : kind === 'save' || kind === 'rename' || kind === 'duplicate'
              ? ['modify-tabs', 'write-workspace']
              : ['modify-tabs'],
      };
    },
    outputSchema: appViewsOutputSchema,
    execution: resultSdkRendererTool((context) => createAppViewsTool(context.folders)),
  },
  notebook_document: {
    name: 'notebook_document',
    description:
      'Inspect, search and edit native notebooks through the human editor and save owner. One insert path handles entities, inspected files and tables. Saved molecular documents produce document-reference chips; coordinate files supply structure geometry. Returned documentReference or referenceId values can also be inserted directly. Internal reference links become native chips automatically. schema discovers nodes and embeds. Inspect first for the current revision.',
    shape: 'app-action',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace', 'create-entity'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: notebookDocumentSchema,
    inputSchemaOptions: notebookInputSchemaOptions,
    resolveInputAuthorization: (args) => {
      const operation = (args as { operation?: { kind?: string; command?: { kind?: string } } })
        .operation;
      const kind = operation?.kind;
      return {
        additionalRequiredCapabilities:
          kind === 'inspect' ||
          kind === 'schema' ||
          kind === 'search' ||
          kind === 'list' ||
          (kind === 'table' && operation?.command?.kind === 'inspect')
            ? []
            : kind === 'create'
              ? ['write-workspace', 'create-entity']
              : ['write-workspace'],
      };
    },
    outputSchema: notebookDocumentOutputSchema,
    execution: resultSdkRendererTool((context) => createNotebookDocumentTool(context.folders)),
  },
  workspace_projects: {
    name: 'workspace_projects',
    description:
      'List, create, import, open, rename, close, archive, trash and restore native projects through the human project lifecycle. Exact project revisions protect updates and dirty drafts remain protected.',
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace', 'modify-tabs', 'create-entity'],
    audit_required: true,
    effects: ['read-only', 'mutating', 'ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    exposure: { kind: 'shared' },
    inputSchema: workspaceProjectsSchema,
    resolveInputAuthorization: (args) => {
      const kind = (args as { operation?: { kind?: string } }).operation?.kind;
      return {
        additionalRequiredCapabilities:
          kind === 'list'
            ? []
            : kind === 'open' || kind === 'close'
              ? ['modify-tabs']
              : kind === 'create' || kind === 'import'
                ? ['write-workspace', 'modify-tabs', 'create-entity']
                : ['write-workspace', 'modify-tabs'],
      };
    },
    outputSchema: workspaceProjectsOutputSchema,
    execution: resultSdkRendererTool(() => createWorkspaceProjectsTool()),
  },
  workspace_files: {
    name: 'workspace_files',
    description: WORKSPACE_FILES_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: workspaceFilesSchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities: ['inspect', 'list-trash'].includes(
        (args as { operation?: { kind?: string } }).operation?.kind ?? ''
      )
        ? []
        : ['write-workspace'],
    }),
    outputSchema: workspaceFilesOutputSchema,
    execution: resultSdkRendererTool((context) => createWorkspaceFilesTool(context.folders)),
  },
  file_document: {
    name: 'file_document',
    description: FILE_DOCUMENT_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: fileDocumentSchema,
    outputSchema: fileDocumentOutputSchema,
    resolveInputAuthorization: (args) => {
      const operation = (args as { operation?: { kind?: string; command?: { kind?: string } } })
        .operation;
      return {
        additionalRequiredCapabilities:
          operation?.kind === 'inspect' ||
          (operation?.kind === 'table' && operation.command?.kind === 'inspect')
            ? []
            : ['write-workspace'],
      };
    },
    execution: resultSdkRendererTool((context) => createFileDocumentTool(context.folders)),
  },
  list_files: {
    name: 'list_files',
    description: 'List files and directories inside the mounted workspace.',
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    emptyInputReason: 'list_files intentionally defaults to the mounted workspace root.',
    exposure: { kind: 'shared' },
    inputSchema: listFilesSchema,
    outputSchema: listFilesOutputSchema,
    execution: resultSdkRendererTool((context) => createListFilesTool(context.folders)),
  },
  read_file: {
    name: 'read_file',
    description: READ_FILE_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-workspace-file',
    exposure: { kind: 'shared' },
    inputSchema: readFileSchema,
    outputSchema: readFileOutputSchema,
    execution: resultSdkRendererTool((context) => createReadFileTool(context.folders)),
  },
  search_skills: {
    name: 'search_skills',
    description: SEARCH_SKILLS_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: searchSkillsSchema,
    outputSchema: searchSkillsOutputSchema,
    execution: resultSdkRendererTool((context) => createSearchSkillsTool(context.folders)),
  },
  get_file_changes: {
    name: 'get_file_changes',
    description: 'Read Git status, recent commits, and diff statistics for the mounted workspace.',
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    emptyInputReason: 'get_file_changes intentionally defaults to all mounted workspace folders.',
    exposure: { kind: 'shared' },
    inputSchema: getFileChangesSchema,
    outputSchema: getFileChangesOutputSchema,
    execution: resultSdkRendererTool((context) => createGetFileChangesTool(context.folders)),
  },
  open_terminal: {
    name: 'open_terminal',
    description: OPEN_TERMINAL_DESCRIPTION,
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    emptyInputReason:
      'open_terminal defaults to a new app tab using the configured shell and current workspace/home.',
    exposure: { kind: 'shared' },
    inputSchema: openTerminalSchema,
    outputSchema: openTerminalOutputSchema,
    execution: resultSdkRendererTool(() => createOpenTerminalTool()),
  },
  open_tab: {
    name: 'open_tab',
    description: 'Open content in the DNAForge canvas.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    historyPresentation: { mode: 'reactivate', handler: 'open-tab', label: 'Show' },
    exposure: { kind: 'shared' },
    inputSchema: openTabSchema,
    outputSchema: openTabOutputSchema,
    execution: resultSdkRendererTool((context) => createOpenTabTool(context.folders)),
  },
  close_tab: {
    name: 'close_tab',
    description: 'Close the focused non-chat tab in the DNAForge canvas.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    emptyInputReason: 'close_tab intentionally operates on the focused canvas tab.',
    exposure: { kind: 'shared' },
    inputSchema: closeTabSchema,
    outputSchema: closeTabOutputSchema,
    execution: resultSdkRendererTool((_context) => closeTabTool),
  },
  get_remote_hosts: {
    name: 'get_remote_hosts',
    description: GET_REMOTE_HOSTS_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    emptyInputReason:
      'get_remote_hosts reads app-wide cached observations when no target is supplied.',
    exposure: { kind: 'shared' },
    inputSchema: getRemoteHostsSchema,
    outputSchema: getRemoteHostsOutputSchema,
    execution: resultSdkRendererTool(() => createGetRemoteHostsTool()),
  },
  manage_remote_host: {
    name: 'manage_remote_host',
    description: MANAGE_REMOTE_HOST_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['modify-settings'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: manageRemoteHostSchema,
    outputSchema: manageRemoteHostOutputSchema,
    execution: resultSdkRendererTool(() => createManageRemoteHostTool()),
  },
  report_app_feedback: {
    name: 'report_app_feedback',
    description: REPORT_APP_FEEDBACK_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['submit-feedback'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: agentFeedbackSchema,
    outputSchema: agentFeedbackReceiptSchema,
    mcpAnnotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execution: resultSdkRendererTool(() => createReportAppFeedbackTool()),
  },
  get_external_agent_access: {
    name: 'get_external_agent_access',
    description:
      'Read how outside AI apps connect to DNAForge: whether Claude Code and Codex are registered, whether the optional local web address is on, and copyable setup for other apps.',
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    emptyInputReason:
      'get_external_agent_access intentionally reads app-wide connection settings with no input.',
    exposure: { kind: 'shared' },
    inputSchema: getExternalAgentAccessSchema,
    outputSchema: externalAgentAccessOutputSchema,
    execution: resultSdkRendererTool(() => createGetExternalAgentAccessTool()),
  },
  configure_external_agent_access: {
    name: 'configure_external_agent_access',
    description:
      'Change the optional local web address that MCP clients can use instead of the `dnaforge mcp` command: turn it on or off, set its port, or set extra accepted host names for a relay such as Tailscale. Omitted fields keep their current value. Clients still need an access key that a person creates in Settings.',
    shape: 'app-action',
    required_capabilities: ['manage-agent-access'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: configureExternalAgentAccessSchema,
    outputSchema: configureExternalAgentAccessOutputSchema,
    execution: resultSdkRendererTool(() => createConfigureExternalAgentAccessTool()),
  },
  import_entities: {
    name: 'import_entities',
    description:
      'Import typed DNA oligo, RNA oligo, or protein entities from a workspace table or FASTA through the shared import plan and file-authoritative writers.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'create-entity'],
    conditional_required_capabilities: ['edit-primers'],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: importEntitiesSchema,
    outputSchema: importEntitiesOutputSchema,
    execution: resultSdkRendererTool((context) => createImportEntitiesTool(context.folders)),
    resolveInputAuthorization: resolveImportEntitiesAuthorization,
  },
  get_workspace: {
    name: 'get_workspace',
    description: GET_WORKSPACE_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    emptyInputReason: 'get_workspace intentionally snapshots the current canvas.',
    exposure: { kind: 'shared' },
    inputSchema: getWorkspaceSchema,
    outputSchema: getWorkspaceOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createGetWorkspaceTool(context.grantedCapabilities)
    ),
  },
  observe_app_state: {
    name: 'observe_app_state',
    description:
      'Read a compact app-owned snapshot of workspace, tab, design, and loaded sequence state for before/after tool-flow verification.',
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    emptyInputReason:
      'observe_app_state intentionally snapshots app state for closed-loop verification.',
    exposure: { kind: 'shared' },
    inputSchema: observeAppStateSchema,
    outputSchema: observeAppStateOutputSchema,
    execution: resultSdkRendererTool((_context) => observeAppStateTool),
  },
  'workspace.gitStatus': {
    name: 'workspace.gitStatus',
    description: 'Read git status and recent changes for the active workspace.',
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    providerAlias: 'workspace_git_status',
    exposure: { kind: 'shared' },
    inputSchema: getFileChangesSchema,
    outputSchema: getFileChangesOutputSchema,
    execution: resultSdkRendererTool((context) => createGetFileChangesTool(context.folders)),
  },
  'external.fetch': {
    name: 'external.fetch',
    description:
      'Fetch and persist an external biology database resource (e.g., UniProt entry) via the sidecar. Returns license + attribution + persisted external_resource id. Optional bind_to attaches the result to a workspace sequence/feature/project (requires workspace_id).',
    shape: 'data-service',
    required_capabilities: ['external-fetch:annotation'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    providerAlias: 'external_fetch',
    exposure: { kind: 'shared' },
    inputSchema: externalFetchSchema,
    outputSchema: externalFetchOutputSchema,
    execution: { ...customRendererTool(handleExternalFetch), resultContract: 'explicit-v1' },
  },
  'external.xref': {
    name: 'external.xref',
    description:
      'List cross-references for a previously-fetched external resource. Read-only against the local cache — does NOT trigger network fetches.',
    shape: 'data-service',
    required_capabilities: ['external-fetch:xref-resolution'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    providerAlias: 'external_xref',
    exposure: { kind: 'shared' },
    inputSchema: externalXrefSchema,
    outputSchema: externalXrefOutputSchema,
    execution: resultSdkRendererTool(() => externalXrefTool),
  },
  get_selection_bases: {
    name: 'get_selection_bases',
    description:
      'Last resort: return the raw bases for a bounded window (max 5000 bp). Provide EITHER an app selection (refId) OR raw bases (sequence). Prefer a selection_* compute tool, which returns the answer directly.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-ref-id',
    exposure: { kind: 'shared' },
    inputSchema: getSelectionBasesSchema,
    outputSchema: getSelectionBasesOutputSchema,
    execution: resultSdkRendererTool((context) => createGetSelectionBasesTool(context.folders)),
  },
  highlight_range: {
    name: 'highlight_range',
    description:
      'Highlight a 1-indexed inclusive coordinate range in an open sequence viewer so the user sees the exact span; opens the sequence beside the chat if it is not already open. Provide a single span (start + end) OR a regions array for a disjoint selection.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    historyPresentation: { mode: 'reactivate', handler: 'highlight-range', label: 'Show' },
    exposure: { kind: 'shared' },
    inputSchema: highlightRangeSchema,
    outputSchema: highlightRangeOutputSchema,
    execution: resultSdkRendererTool((context) => createHighlightRangeTool(context.folders)),
  },
});
