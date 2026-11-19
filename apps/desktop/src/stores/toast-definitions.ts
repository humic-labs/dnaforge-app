import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  toUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import {
  DESKTOP_ANALYTICS_OPT_IN_MESSAGE,
  DESKTOP_ANALYTICS_TOAST_MESSAGE,
} from '@waypoint/analytics-policy';
import { PRIVACY_POLICY_UPDATED_MESSAGE } from '../lib/privacy-policy-update';
export const TOAST_TYPES = ['info', 'success', 'warning', 'error'] as const;
export type ToastType = (typeof TOAST_TYPES)[number];
export type ToastDismissMode = 'control' | 'surface';

export const TOAST_TIMING_POLICIES = {
  confirmation: {
    duration: 4000,
    label: 'Confirmation',
    description: 'Brief acknowledgement of a completed action.',
  },
  notice: {
    duration: 8000,
    label: 'Notice',
    description: 'Information, a recoverable problem, or an optional next action.',
  },
  announcement: {
    duration: 10000,
    label: 'Announcement',
    description: 'A less frequent announcement with extra reading time.',
  },
  persistent: {
    duration: 0,
    label: 'Persistent',
    description: 'A decision, ongoing operation, or result that must remain available.',
  },
} as const;
export type ToastTiming = keyof typeof TOAST_TIMING_POLICIES;

export const TOAST_BEHAVIOR = {
  duration: TOAST_TIMING_POLICIES.confirmation.duration,
  dismissOn: 'control' as ToastDismissMode,
  pauseOnInteraction: true,
  closeButton: true,
  actionDismisses: true,
  exitDuration: 110,
  layoutDuration: 120,
  countdownLabelRefresh: 100,
};

export interface ToastPolicy {
  type: ToastType;
  message: UserMessage;
  timing: ToastTiming;
  duration: number;
  dismissOn: ToastDismissMode;
  pauseOnInteraction: boolean;
  closeButton: boolean;
  actionDismisses: boolean;
  actionLabels: readonly string[];
}
export interface ToastDefinition extends ToastPolicy {
  group?: string;
  oncePerKey?: boolean;

  keyScope?: 'session' | 'group';
  clearsGroups?: readonly string[];
  clearsKeys?: readonly string[];
  requiresVariant?: boolean;
  groupExit?: 'remove' | 'dismiss';
  category: string;
  source: string;
  variants: Readonly<Record<string, Partial<ToastPolicy>>>;
}

type ToastPolicyInput = Partial<Omit<ToastPolicy, 'duration'>>;
type ToastDefinitionInput = Pick<ToastDefinition, 'type' | 'message' | 'category' | 'source'> &
  Partial<Omit<ToastDefinition, 'duration' | 'variants'>> & {
    variants?: Readonly<Record<string, ToastPolicyInput>>;
  };

function timingFor(type: ToastType): ToastTiming {
  return type === 'success' ? 'confirmation' : 'notice';
}

function defineToast(input: ToastDefinitionInput): ToastDefinition {
  const timing = input.timing ?? timingFor(input.type);
  const variants = Object.fromEntries(
    Object.entries(input.variants ?? {}).map(([name, variant]) => {
      const variantTiming = variant.timing ?? input.timing ?? timingFor(variant.type ?? input.type);
      return [
        name,
        {
          ...variant,
          timing: variantTiming,
          duration: TOAST_TIMING_POLICIES[variantTiming].duration,
        },
      ];
    })
  );
  return {
    ...TOAST_BEHAVIOR,
    actionLabels: [],
    ...input,
    timing,
    duration: TOAST_TIMING_POLICIES[timing].duration,
    variants,
  };
}

export const TOAST_DEFINITIONS = {
  'markdown-notebook-adoption-failed': defineToast({
    category: 'Notebook',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('document.openFailed'),
  }),
  'terminal-shell-exited': defineToast({
    category: 'Terminal',
    source: 'features/terminal/TerminalDock.tsx',
    type: 'warning',
    message: userMessage('notice.terminal-shell-exited-with-code-7'),
    timing: 'notice',
    oncePerKey: true,
    keyScope: 'session',
  }),
  'update-current': defineToast({
    category: 'use Update Toasts',
    source: 'hooks/useUpdateToasts.ts',
    type: 'info',
    timing: 'confirmation',
    message: userMessage('notice.dnaforge-is-up-to-date-v9-9-9'),
    group: 'update-current',
    clearsGroups: ['update-error', 'update-downloading'],
    variants: {
      dev: {
        timing: 'notice',
        message: userMessage('notice.dev-build-v9-9-9-update-checks-are-disabled-in-development'),
      },
    },
  }),
  'update-downloading': defineToast({
    category: 'use Update Toasts',
    source: 'hooks/useUpdateToasts.ts',
    type: 'info',
    timing: 'persistent',
    message: userMessage('update.downloading'),
    group: 'update-downloading',
    clearsGroups: ['update-error', 'update-current'],
  }),
  'update-ready': defineToast({
    category: 'use Update Toasts',
    source: 'hooks/useUpdateToasts.ts',
    type: 'info',
    message: userMessage('notice.update-v9-9-9-ready-restart-to-apply'),
    timing: 'persistent',
    actionLabels: ['Restart now'],
    group: 'update-ready',
    oncePerKey: true,
    keyScope: 'group',
    clearsGroups: ['update-error', 'update-downloading', 'update-current'],
  }),
  'update-install-failed': defineToast({
    category: 'use Update Toasts',
    source: 'hooks/useUpdateToasts.ts',
    type: 'warning',
    message: userMessage(
      'notice.update-couldn-t-be-installed-download-the-latest-version-from-dnaforge'
    ),
    timing: 'persistent',
    group: 'update-error',
  }),
  'update-error': defineToast({
    category: 'use Update Toasts',
    source: 'hooks/useUpdateToasts.ts',
    type: 'info',
    message: userMessage('notice.update-check-failed-please-try-again-in-a-moment'),
    actionLabels: ['Retry'],
    variants: {
      unknown: {
        type: 'info',
        timing: 'notice',
        message: userMessage('notice.update-check-failed-please-try-again-in-a-moment'),
        actionLabels: ['Retry'],
      },
      network: {
        type: 'info',
        timing: 'notice',
        message: userMessage(
          'notice.couldn-t-reach-the-update-server-check-your-connection-or-try-again-la'
        ),
        actionLabels: ['Retry'],
      },
      'no-manifest': {
        type: 'info',
        timing: 'notice',
        message: userMessage(
          'notice.automatic-updates-aren-t-available-for-this-build-reinstall-from-dnafo'
        ),
        actionLabels: [],
      },
      download: {
        type: 'warning',
        timing: 'persistent',
        message: userMessage('notice.update-download-was-interrupted'),
        actionLabels: ['Retry'],
      },
      preparation: {
        type: 'warning',
        timing: 'persistent',
        message: userMessage('notice.the-downloaded-update-could-not-be-prepared'),
        actionLabels: ['Retry'],
      },
    },
    timing: 'notice',
    group: 'update-error',
    requiresVariant: true,
  }),
  'use-file-association-opportunities-dnaforge-is-now-the-default-app-for-these-files': defineToast(
    {
      category: 'use file association opportunities',
      source: 'hooks/use-file-association-opportunities.ts',
      type: 'success',
      message: userMessage('notice.dnaforge-is-now-the-default-app-for-these-files'),
    }
  ),
  'use-file-association-opportunities-choose-dnaforge-in-windows-default-apps-then-return-here':
    defineToast({
      category: 'use file association opportunities',
      source: 'hooks/use-file-association-opportunities.ts',
      type: 'info',
      message: userMessage('notice.choose-dnaforge-in-windows-default-apps-then-return-here'),
      timing: 'notice',
    }),
  'use-file-association-opportunities-change-the-default-app-in-system-settings': defineToast({
    category: 'use file association opportunities',
    source: 'hooks/use-file-association-opportunities.ts',
    type: 'info',
    message: userMessage('notice.change-the-default-app-in-system-settings'),
    timing: 'notice',
  }),
  'use-file-association-opportunities-the-request-completed-but-the-system-did-not-report-dnaforge-as-default':
    defineToast({
      category: 'use file association opportunities',
      source: 'hooks/use-file-association-opportunities.ts',
      type: 'warning',
      message: userMessage(
        'notice.the-request-completed-but-the-system-did-not-report-dnaforge-as-defaul'
      ),
    }),
  'use-file-association-opportunities-default-app-controls-are-unavailable': defineToast({
    category: 'use file association opportunities',
    source: 'hooks/use-file-association-opportunities.ts',
    type: 'error',
    message: userMessage('failure.default-app-controls-are-unavailable'),
  }),
  'use-file-association-opportunities-could-not-save-the-default-app-prompt-preference':
    defineToast({
      category: 'use file association opportunities',
      source: 'hooks/use-file-association-opportunities.ts',
      type: 'error',
      message: userMessage('notice.could-not-save-the-default-app-prompt-preference'),
    }),
  'use-file-association-opportunities-make-dnaforge-the-default-app-for-example-files': defineToast(
    {
      category: 'use file association opportunities',
      source: 'hooks/use-file-association-opportunities.ts',
      type: 'info',
      message: userMessage('notice.make-dnaforge-the-default-app-for-example-files'),
      timing: 'persistent',
      dismissOn: 'control',
      actionLabels: ['Make DNAForge default', 'Not now', "Don't ask again"],
    }
  ),
  'use-file-association-opportunities-could-not-change-the-default-app-example-error': defineToast({
    category: 'use file association opportunities',
    source: 'hooks/use-file-association-opportunities.ts',
    type: 'error',
    message: userMessage('notice.could-not-change-the-default-app-example-error'),
  }),
  'post-update': defineToast({
    category: 'use Post Update Toast',
    source: 'hooks/usePostUpdateToast.ts',
    type: 'info',
    message: userMessage('notice.updated-to-v9-9-9-see-what-changed'),
    timing: 'announcement',
    dismissOn: 'surface',
    actionLabels: ["What's new"],
  }),
  'file-browser-you-can-t-remove-your-only-project-dnaforge-always-keeps-at-least-one-open':
    defineToast({
      category: 'File Browser',
      source: 'components/FileBrowser.tsx',
      type: 'warning',
      message: userMessage(
        'notice.you-can-t-remove-your-only-project-dnaforge-always-keeps-at-least-one-'
      ),
    }),
  'file-browser-you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-keep':
    defineToast({
      category: 'File Browser',
      source: 'components/FileBrowser.tsx',
      type: 'warning',
      message: userMessage(
        'notice.you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-k'
      ),
    }),
  'file-browser-couldn-t-archive-example': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-archive-example'),
  }),
  'file-browser-couldn-t-archive-example-it-isn-t-a-managed-project-yet': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'warning',
    message: userMessage('notice.couldn-t-archive-example-it-isn-t-a-managed-project-yet'),
  }),
  'file-browser-this-record-has-no-exact-original-source-binding': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'warning',
    message: userMessage('notice.this-record-has-no-exact-original-source-binding'),
  }),
  'file-browser-reference-projects-are-read-only': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'warning',
    message: userMessage('notice.reference-projects-are-read-only'),
  }),
  'file-browser-couldn-t-duplicate-example-file': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-duplicate-example-file'),
  }),
  'file-browser-could-not-open-sequence-for-renaming': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'error',
    message: userMessage('notice.could-not-open-this-sequence-for-renaming'),
  }),
  'file-browser-move-item-into-dir': defineToast({
    requiresVariant: true,
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'info',
    message: userMessage('notice.the-file-could-not-be-moved'),
    variants: {
      info: {
        type: 'info',
        message: userMessage('notice.the-file-could-not-be-moved'),
      },
      error: {
        type: 'error',
        message: userMessage('notice.the-file-could-not-be-moved'),
      },
    },
  }),
  'file-browser-choose-a-writable-project-before-creating': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'warning',
    message: userMessage('notice.choose-a-writable-project-before-creating'),
  }),
  'file-operation-failed': defineToast({
    category: 'File Browser',
    source: 'components/FileBrowser.tsx',
    type: 'error',
    message: userMessage('notice.the-file-operation-failed-your-original-file-remains-available'),
    timing: 'persistent',
  }),
  'primer-reconcile-failed': defineToast({
    category: 'workspace reconcile report',
    source: 'services/workspace-reconcile-report.ts',
    type: 'error',
    message: userMessage(
      'notice.primer-file-example-primer-json-could-not-be-added-to-your-primer-regi'
    ),
  }),
  'entity-migration-needs-attention': defineToast({
    category: 'workspace reconcile report',
    source: 'services/workspace-reconcile-report.ts',
    type: 'warning',
    message: userMessageWithValues('project.entityMigrationSummary', {
      count: userMessageValue(1),
      target: userMessageValue('sequence.fa'),
      detail: userMessageValue('The sequence could not be converted.'),
    }),
    timing: 'persistent',
  }),
  'primer-library-file-recovery': defineToast({
    category: 'workspace reconcile report',
    source: 'services/workspace-reconcile-report.ts',
    type: 'info',
    timing: 'persistent',
    message: userMessage('primer.libraryFileRecoveryNeeded'),
    actionLabels: ['Save library primers as files'],
  }),
  'primer-library-file-recovery-running': defineToast({
    group: 'primer-library-file-recovery-state',
    category: 'workspace reconcile report',
    source: 'services/primer-library-file-recovery.ts',
    type: 'info',
    timing: 'persistent',
    message: userMessage('primer.libraryFileRecoveryRunning'),
  }),
  'primer-library-file-recovery-pending': defineToast({
    group: 'primer-library-file-recovery-state',
    category: 'workspace reconcile report',
    source: 'services/primer-library-file-recovery.ts',
    type: 'error',
    timing: 'persistent',
    message: userMessage('primer.libraryFileRecoveryPending'),
    actionLabels: ['Retry primer recovery'],
  }),
  'primer-library-file-recovery-complete': defineToast({
    group: 'primer-library-file-recovery-state',
    category: 'workspace reconcile report',
    source: 'services/primer-library-file-recovery.ts',
    type: 'success',
    message: userMessage('primer.libraryFileRecoveryComplete'),
  }),
  'primer-recovery-failed': defineToast({
    actionLabels: ['Restore saved copies'],
    category: 'workspace reconcile report',
    source: 'services/workspace-reconcile-report.ts',
    type: 'error',
    timing: 'persistent',
    message: userMessage(
      'notice.primer-recovery-could-not-finish-your-existing-records-have-been-prese'
    ),
  }),
  'original-project-recovery-needed': defineToast({
    category: 'workspace reconcile report',
    source: 'services/workspace-reconcile-report.ts',
    type: 'error',
    timing: 'persistent',
    actionDismisses: false,
    message: userMessage('notice.the-original-my-project-has-not-been-identified'),
    actionLabels: ['Identify original My Project'],
  }),
  'entity-reconcile-conflict': defineToast({
    actionDismisses: false,
    actionLabels: ['Compare versions'],
    category: 'workspace reconcile report',
    source: 'services/workspace-reconcile-report.ts',
    type: 'warning',
    message: userMessage(
      'notice.a-saved-document-differs-from-the-application-copy-both-versions-are-r'
    ),
    timing: 'persistent',
  }),
  'workspace-refresh-warning': defineToast({
    category: 'workspace renderer mutation',
    source: 'services/workspace-renderer-mutation.ts',
    type: 'warning',
    message: userMessage(
      'notice.the-shared-project-was-updated-but-one-document-still-needs-attention'
    ),
    timing: 'persistent',
  }),
  'root-folder-couldn-t-open-the-plasmid-in-example-file': defineToast({
    category: 'Root Folder',
    source: 'components/RootFolder.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-open-the-plasmid-in-example-file'),
  }),
  'migration-background': defineToast({
    category: 'Benchling Migration Wizard',
    source: 'features/benchling-migration/BenchlingMigrationWizard.tsx',
    type: 'info',
    message: userMessage(
      'notice.migration-continues-in-the-background-and-resumes-automatically-after-'
    ),
  }),
  'workspace-folder-picker-commit-rename': defineToast({
    category: 'Workspace Folder Picker',
    source: 'components/WorkspaceFolderPicker.tsx',
    type: 'error',
    message: userMessage('notice.the-project-folder-could-not-be-opened'),
  }),
  'migration-result': defineToast({
    requiresVariant: true,
    category: 'use Benchling Migration Notifications',
    source: 'features/benchling-migration/useBenchlingMigrationNotifications.ts',
    type: 'success',
    message: userMessage('notice.benchling-import-is-ready-open-it-to-review-the-result'),
    actionLabels: ['View migration'],
    variants: {
      success: {
        type: 'success',
        timing: 'notice',
        message: userMessage('notice.benchling-import-is-ready-open-it-to-review-the-result'),
      },
      warning: {
        type: 'warning',
        timing: 'persistent',
        message: userMessage('notice.benchling-migration-needs-attention-before-it-can-continue'),
      },
    },
    timing: 'notice',
    group: 'migration-result',
    groupExit: 'dismiss',
    oncePerKey: true,
    keyScope: 'group',
  }),
  'file-import-result': defineToast({
    requiresVariant: true,
    category: 'use Import Wizard',
    source: 'features/import-wizard/useImportWizard.ts',
    type: 'info',
    message: userMessage('notice.imported-3-files-into-your-project'),
    variants: {
      info: {
        type: 'info',
        message: userMessage('notice.imported-3-files-into-your-project'),
      },
      success: {
        type: 'success',
        message: userMessage('notice.imported-3-files-into-your-project'),
      },
      warning: {
        type: 'warning',
        message: userMessage('notice.imported-2-files-one-file-needs-attention'),
      },
      error: {
        type: 'error',
        message: userMessage('notice.no-files-could-be-imported'),
      },
    },
  }),
  'use-import-wizard-file-import-is-available-in-the-desktop-app': defineToast({
    category: 'use Import Wizard',
    source: 'features/import-wizard/useImportWizard.ts',
    type: 'info',
    message: userMessage('notice.file-import-is-available-in-the-desktop-app'),
  }),
  'use-import-wizard-project-import-is-available-in-the-desktop-app': defineToast({
    category: 'use Import Wizard',
    source: 'features/import-wizard/useImportWizard.ts',
    type: 'info',
    message: userMessage('notice.project-import-is-available-in-the-desktop-app'),
  }),
  'genetic-code-question': defineToast({
    category: 'use genetic code prompt',
    source: 'features/sequence/use-genetic-code-prompt.ts',
    type: 'warning',
    message: userMessage(
      'notice.this-record-s-source-says-organelle-but-no-feature-declares-a-genetic-'
    ),
    timing: 'persistent',
    dismissOn: 'surface',
  }),
  'tabular-import-partial-failure': defineToast({
    category: 'run tabular import flow',
    source: 'features/import-wizard/run-tabular-import-flow.ts',
    type: 'error',
    message: userMessage(
      'notice.registered-3-entities-before-the-remaining-import-failed-example-error'
    ),
    timing: 'persistent',
    actionLabels: [],
    variants: {
      'with-undo': {
        actionLabels: ['Undo'],
      },
    },
  }),
  'run-tabular-import-flow-import-undone': defineToast({
    category: 'run tabular import flow',
    source: 'features/import-wizard/run-tabular-import-flow.ts',
    type: 'info',
    message: userMessage('notice.import-undone'),
  }),
  'run-tabular-import-flow-nothing-was-registered-every-row-was-a-duplicate-or-needs-your-attention':
    defineToast({
      category: 'run tabular import flow',
      source: 'features/import-wizard/run-tabular-import-flow.ts',
      type: 'info',
      message: userMessage(
        'notice.nothing-was-registered-every-row-was-a-duplicate-or-needs-your-attenti'
      ),
    }),
  'tabular-import-registered': defineToast({
    category: 'run tabular import flow',
    source: 'features/import-wizard/run-tabular-import-flow.ts',
    type: 'success',
    message: userMessage('notice.registered-3-entities-to-the-registry'),
    timing: 'persistent',
    actionLabels: ['Undo'],
  }),
  'chat-document-notice': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'info',
    message: userMessage('notice.the-document-could-not-be-opened-in-this-chat'),
  }),
  'full-chat-view-the-alignment-viewer-is-not-available-yet': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'info',
    message: userMessage('notice.the-alignment-viewer-is-not-available-yet'),
  }),
  'full-chat-view-could-not-open-this-reference': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage('failure.could-not-open-this-reference'),
  }),
  'full-chat-view-could-not-target-reference': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage('failure.could-not-target-this-reference'),
  }),
  'structure-reference-target-failed': defineToast({
    category: 'Structure',
    source: 'features/page/embeds/structure3d/hooks/useStructureReferenceTarget.ts',
    type: 'error',
    message: userMessage('failure.could-not-target-this-reference'),
  }),
  'full-chat-view-handle-reference-reveal': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage('notice.the-reference-could-not-be-opened'),
  }),
  'full-chat-view-open-failed': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage('notice.the-reference-could-not-be-opened'),
  }),
  'full-chat-view-handle-inline-reference-action': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage('notice.the-reference-could-not-be-opened'),
  }),
  'full-chat-view-origin-unrecoverable': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage('notice.the-original-source-for-this-reference-could-not-be-recovered'),
  }),
  'full-chat-view-example-isn-t-inside-an-open-project-so-dnaforge-didn-t-attach-it': defineToast({
    category: 'Full Chat View',
    source: 'components/FullChatView.tsx',
    type: 'error',
    message: userMessage(
      'notice.example-isn-t-inside-an-open-project-so-dnaforge-didn-t-attach-it'
    ),
  }),
  'quick-look-import-host-imported-all-3-records-from-example-to-edit': defineToast({
    category: 'Quick Look Import Host',
    source: 'components/QuickLookImportHost.tsx',
    type: 'success',
    message: userMessage('notice.imported-all-3-records-from-example-to-edit'),
  }),
  'quick-look-import-host-imported-example-to-example-file-but-dnaforge-could-not-open-the-destinatio':
    defineToast({
      category: 'Quick Look Import Host',
      source: 'components/QuickLookImportHost.tsx',
      type: 'error',
      message: userMessage(
        'notice.imported-example-to-example-file-but-dnaforge-could-not-open-the-desti'
      ),
    }),
  'quick-look-import-host-promote': defineToast({
    category: 'Quick Look Import Host',
    source: 'components/QuickLookImportHost.tsx',
    type: 'error',
    message: userMessage('notice.the-quick-look-import-could-not-be-completed'),
  }),
  'open-quick-look-source-could-not-open-example-example-error': defineToast({
    category: 'open quick look source',
    source: 'lib/open-quick-look-source.ts',
    type: 'error',
    message: userMessage('notice.could-not-open-example-example-error'),
  }),
  'app-hosted-compute-job-stopped': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'success',
    message: userMessage('notice.hosted-compute-job-stopped'),
  }),
  'app-could-not-stop-the-job': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-stop-the-job'),
  }),
  'app-could-not-import-the-hosted-job-result': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-import-the-hosted-job-result'),
  }),
  'app-could-not-open-the-hosted-job-result': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-open-the-hosted-job-result'),
  }),
  'app-could-not-open-the-job-result': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-open-the-job-result'),
  }),
  'job-release-result': defineToast({
    requiresVariant: true,
    category: 'App',
    source: 'App.tsx',
    type: 'info',
    message: userMessage('notice.the-job-result-was-released'),
    variants: {
      error: {
        type: 'error',
        message: userMessage('notice.the-job-result-could-not-be-released'),
      },
      success: {
        type: 'success',
        message: userMessage('notice.the-job-result-was-released'),
      },
    },
  }),
  'app-could-not-release-the-job-result': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-release-the-job-result'),
  }),
  'app-could-not-reconnect-jobs': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-reconnect-jobs'),
  }),
  'app-completed-run-recorded-in-jobs': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'success',
    message: userMessage('notice.completed-run-recorded-in-jobs'),
  }),
  'app-could-not-record-the-completed-run': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-record-the-completed-run'),
  }),
  'app-failed-to-open-project': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.failed-to-open-project'),
  }),
  'sheet-sync-project-start-failed': defineToast({
    category: 'Registry',
    source: 'features/lims/use-sheet-sync-projects.ts',
    type: 'error',
    message: userMessage('notice.spreadsheet-sync-could-not-start-reopen-the-project-to-retry'),
  }),
  'app-couldn-t-start-a-new-chat-try-again': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-start-a-new-chat-try-again'),
  }),
  'app-choose-a-folder-inside-an-open-project-before-creating-an-oligo': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.choose-a-folder-inside-an-open-project-before-creating-an-oligo'),
  }),
  'app-choose-a-folder-inside-an-open-project-before-creating-a-protein': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.choose-a-folder-inside-an-open-project-before-creating-a-protein'),
  }),
  'app-failed-to-create-dna-sequence': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.failed-to-create-dna-sequence'),
  }),
  'app-the-project-file-could-not-be-verified': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.the-project-file-could-not-be-verified'),
  }),
  'project-verification-failed': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.the-project-file-could-not-be-verified'),
  }),
  'document-open-refused': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.this-document-could-not-be-opened-safely'),
  }),
  'app-project-opened-but-its-landing-document-could-not-be-opened': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage('notice.project-opened-but-its-landing-document-could-not-be-opened'),
  }),
  'app-replay-migration-complete': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'success',
    message: userMessage('notice.replay-migration-complete'),
  }),
  'app-migration-unlocked-but-its-project-could-not-be-opened': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage('notice.migration-unlocked-but-its-project-could-not-be-opened'),
  }),
  'app-migration-validated-and-project-opened': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'success',
    message: userMessage('notice.migration-validated-and-project-opened'),
  }),
  'app-the-current-samples-project-is-available-but-dnaforge-could-not-retire-an-old': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage(
      'notice.the-current-samples-project-is-available-but-dnaforge-could-not-retire'
    ),
  }),
  'app-dnaforge-couldn-t-create-your-first-project-create-one-from-the-projects-menu': defineToast({
    category: 'App',
    source: 'hooks/useFirstProjectBootstrap.ts',
    type: 'error',
    message: userMessage(
      'notice.dnaforge-couldn-t-create-your-first-project-create-one-from-the-projec'
    ),
  }),
  'app-could-not-create-the-project': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.could-not-create-the-project'),
  }),
  'app-couldn-t-read-example': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-read-example'),
  }),
  'app-failed-to-import-file': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('failure.failed-to-import-file'),
  }),
  'app-imported-example-but-couldn-t-open-it-it-remains-in-the-project': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.imported-example-but-couldn-t-open-it-it-remains-in-the-project'),
  }),
  'file-open-failed': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.the-file-open-request-failed'),
  }),
  'app-dnaforge-could-not-receive-the-file-open-request': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.dnaforge-could-not-receive-the-file-open-request'),
  }),
  'app-open-or-create-a-project-first-then-import-files-into-it': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'info',
    message: userMessage('notice.open-or-create-a-project-first-then-import-files-into-it'),
  }),
  'app-file-import-is-only-available-in-the-desktop-app': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'info',
    message: userMessage('notice.file-import-is-only-available-in-the-desktop-app'),
  }),
  'file-import-failed': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.the-file-could-not-be-imported'),
  }),
  'app-you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-keep': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage(
      'notice.you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-k'
    ),
  }),
  'app-couldn-t-archive-example': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-archive-example'),
  }),
  'app-couldn-t-archive-example-it-isn-t-a-managed-project-yet': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage('notice.couldn-t-archive-example-it-isn-t-a-managed-project-yet'),
  }),
  'app-you-can-t-move-example-to-trash-it-s-your-only-project-and-dnaforge-alway': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage(
      'notice.you-can-t-move-example-to-trash-it-s-your-only-project-and-dnaforge-al'
    ),
  }),
  'app-couldn-t-move-example-to-trash': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-move-example-to-trash'),
  }),
  'app-couldn-t-trash-example-it-isn-t-a-managed-project-yet': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage('notice.couldn-t-trash-example-it-isn-t-a-managed-project-yet'),
  }),
  'app-moved-example-to-trash': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'info',
    message: userMessage('notice.moved-example-to-trash'),
  }),
  'entity-creation-result': defineToast({
    requiresVariant: true,
    category: 'App',
    source: 'App.tsx',
    type: 'info',
    message: userMessage('notice.created-example-document'),
    variants: {
      info: {
        type: 'info',
        message: userMessage('notice.created-example-document'),
      },
      success: {
        type: 'success',
        message: userMessage('notice.created-example-document'),
      },
      warning: {
        type: 'warning',
        message: userMessage('notice.created-example-document'),
      },
      error: {
        type: 'error',
        message: userMessage('notice.created-example-document'),
      },
    },
  }),
  'app-the-notebook-could-not-be-created-try-again': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.the-notebook-could-not-be-created-try-again'),
  }),
  'app-the-assembly-could-not-be-created-try-again': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.the-assembly-could-not-be-created-try-again'),
  }),
  'app-choose-a-folder-inside-an-open-project-before-creating': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.choose-a-folder-inside-an-open-project-before-creating'),
  }),
  'app-open-a-writable-project-before-creating-an-assembly': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'warning',
    message: userMessage('notice.open-a-writable-project-before-creating-an-assembly'),
  }),
  'data-privacy': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'info',
    message: toUserMessage(DESKTOP_ANALYTICS_TOAST_MESSAGE),
    timing: 'persistent',
    dismissOn: 'surface',
    actionLabels: ['Privacy details'],
  }),
  'privacy-policy-updated': defineToast({
    category: 'App',
    source: 'hooks/useAppStartup.ts',
    type: 'info',
    message: toUserMessage(PRIVACY_POLICY_UPDATED_MESSAGE),
    timing: 'announcement',
    dismissOn: 'surface',
    actionLabels: ['Read it'],
  }),
  'data-privacy-opt-in': defineToast({
    category: 'App',
    source: 'hooks/useAppStartup.ts',
    type: 'info',
    message: toUserMessage(DESKTOP_ANALYTICS_OPT_IN_MESSAGE),
    timing: 'persistent',
    actionLabels: ['Share', "Don't share", 'Privacy details'],
  }),
  'app-couldn-t-show-example-because-its-project-is-unavailable': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-show-example-because-its-project-is-unavailable'),
  }),
  'app-could-not-show-that-item-in-its-project': defineToast({
    category: 'App',
    source: 'App.tsx',
    type: 'error',
    message: userMessage('notice.could-not-show-that-item-in-its-project'),
  }),
  'text-viewer-tab-save-failed': defineToast({
    category: 'Text editor',
    source: 'components/TextViewerTab.tsx',
    type: 'error',
    message: userMessage('notice.failed-to-save-file-your-changes-remain-in-the-editor'),
  }),
  'unsaved-draft-recovery-available': defineToast({
    category: 'Unsaved Draft Recovery',
    source: 'shared/unsaved-draft-recovery.ts',
    type: 'warning',
    message: userMessage(
      'notice.notes-txt-has-unsaved-changes-from-a-window-that-closed-unexpectedly'
    ),
    timing: 'persistent',
    actionLabels: ['Restore', 'Discard'],
  }),
  'unsaved-new-draft-recovery-available': defineToast({
    category: 'Unsaved Draft Recovery',
    source: 'shared/unsaved-draft-recovery.ts',
    type: 'warning',
    message: userMessage(
      'notice.unsaved-new-protein-gfp-variant-from-a-window-that-closed-unexpectedly'
    ),
    timing: 'persistent',
    actionLabels: ['Reopen', 'Discard'],
  }),
  'unsaved-draft-recovery-outdated': defineToast({
    category: 'Unsaved Draft Recovery',
    source: 'shared/unsaved-draft-recovery.ts',
    type: 'warning',
    message: userMessage(
      'notice.unsaved-changes-to-notes-txt-from-a-window-that-closed-unexpectedly-ca'
    ),
    timing: 'announcement',
  }),
  'unsaved-sequence-recovery-available': defineToast({
    category: 'Unsaved Sequence Recovery',
    source: 'features/sequence/unsaved-sequence-recovery.ts',
    type: 'warning',
    message: userMessage('notice.puc19-has-unsaved-changes-from-a-window-that-closed-unexpectedly'),
    timing: 'persistent',
    actionLabels: ['Restore', 'Discard'],
  }),
  'unsaved-sequence-recovery-outdated': defineToast({
    category: 'Unsaved Sequence Recovery',
    source: 'features/sequence/unsaved-sequence-recovery.ts',
    type: 'warning',
    message: userMessage(
      'notice.unsaved-changes-to-puc19-from-a-window-that-closed-unexpectedly-can-t-'
    ),
    timing: 'announcement',
  }),
  'dev-registry-seed': defineToast({
    category: 'use Dev Lims Seed Prompt',
    source: 'features/lims/useDevLimsSeedPrompt.ts',
    type: 'info',
    message: userMessage(
      'notice.dev-the-lims-seed-changed-reseed-demo-data-your-hand-made-rows-are-kep'
    ),
    timing: 'persistent',
    actionLabels: ['Reseed', 'Not now'],
  }),
  'use-dev-lims-seed-prompt-dev-lims-registry-reseeded-reopen-the-lims-panel-to-view': defineToast({
    category: 'use Dev Lims Seed Prompt',
    source: 'features/lims/useDevLimsSeedPrompt.ts',
    type: 'success',
    message: userMessage('notice.dev-lims-registry-reseeded-reopen-the-lims-panel-to-view'),
  }),
  'use-dev-lims-seed-prompt-reseed-failed': defineToast({
    category: 'use Dev Lims Seed Prompt',
    source: 'features/lims/useDevLimsSeedPrompt.ts',
    type: 'error',
    message: userMessage('notice.reseed-failed'),
  }),
  'registration-badge-registered-open-sequence': defineToast({
    category: 'registration badge',
    source: 'features/lims/registration-badge.tsx',
    type: 'success',
    message: userMessage('notice.registered-open-sequence'),
  }),
  'registration-badge-could-not-register-sequence-example-error': defineToast({
    category: 'registration badge',
    source: 'features/lims/registration-badge.tsx',
    type: 'error',
    message: userMessage('notice.could-not-register-sequence-example-error'),
    timing: 'persistent',
  }),
  'chat-history-failed': defineToast({
    category: 'Chat History Surface',
    source: 'components/chat/ChatHistorySurface.tsx',
    type: 'error',
    message: userMessage('notice.the-conversation-could-not-be-loaded'),
  }),
  'deep-share-enable-failed': defineToast({
    category: 'Deep Share Control',
    source: 'features/deep-share/DeepShareControl.tsx',
    type: 'error',
    message: userMessage('notice.deep-share-could-not-be-enabled'),
  }),
  'deep-share-failed': defineToast({
    category: 'Deep Share Control',
    source: 'features/deep-share/DeepShareControl.tsx',
    type: 'error',
    message: userMessage('notice.deep-share-could-not-be-published'),
  }),
  'deep-share-error': defineToast({
    category: 'Deep Share Control',
    source: 'features/deep-share/DeepShareControl.tsx',
    type: 'error',
    message: userMessage('notice.the-shared-item-could-not-be-updated'),
  }),
  'deep-share-disabled': defineToast({
    category: 'Deep Share Control',
    source: 'features/deep-share/DeepShareControl.tsx',
    type: 'info',
    message: userMessage('notice.save-this-item-before-sharing-it'),
  }),
  'deep-share-control-this-item-must-be-saved-in-a-managed-project-before-it-can-be-shared':
    defineToast({
      category: 'Deep Share Control',
      source: 'features/deep-share/DeepShareControl.tsx',
      type: 'info',
      message: userMessage(
        'notice.this-item-must-be-saved-in-a-managed-project-before-it-can-be-shared'
      ),
    }),
  'deep-share-preparation-failed': defineToast({
    category: 'Deep Share Control',
    source: 'features/deep-share/DeepShareControl.tsx',
    type: 'error',
    message: userMessage('notice.the-item-could-not-be-prepared-for-sharing'),
  }),
  'deep-share-control-deep-share-published-and-link-copied-version-9-9-9': defineToast({
    category: 'Deep Share Control',
    source: 'features/deep-share/DeepShareControl.tsx',
    type: 'success',
    message: userMessage('notice.deep-share-published-and-link-copied-version-9-9-9'),
  }),
  'project-switcher-popover-failed-to-load-your-projects': defineToast({
    category: 'Project Switcher Popover',
    source: 'components/ProjectSwitcherPopover.tsx',
    type: 'error',
    message: userMessage('notice.failed-to-load-your-projects'),
  }),
  'project-switcher-popover-couldn-t-restore-example-its-project-record-is-missing': defineToast({
    category: 'Project Switcher Popover',
    source: 'components/ProjectSwitcherPopover.tsx',
    type: 'warning',
    message: userMessage('notice.couldn-t-restore-example-its-project-record-is-missing'),
  }),
  'project-switcher-popover-couldn-t-restore-example': defineToast({
    category: 'Project Switcher Popover',
    source: 'components/ProjectSwitcherPopover.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-restore-example'),
  }),
  'project-switcher-popover-couldn-t-restore-example-it-may-already-be-purged': defineToast({
    category: 'Project Switcher Popover',
    source: 'components/ProjectSwitcherPopover.tsx',
    type: 'warning',
    message: userMessage('notice.couldn-t-restore-example-it-may-already-be-purged'),
  }),
  'project-switcher-popover-example-was-already-removed': defineToast({
    category: 'Project Switcher Popover',
    source: 'components/ProjectSwitcherPopover.tsx',
    type: 'warning',
    message: userMessage('notice.example-was-already-removed'),
  }),
  'project-switcher-popover-couldn-t-delete-example': defineToast({
    category: 'Project Switcher Popover',
    source: 'components/ProjectSwitcherPopover.tsx',
    type: 'error',
    message: userMessage('notice.couldn-t-delete-example'),
  }),
  'primer-creation-tab-created-primer-example': defineToast({
    category: 'Primer Creation Tab',
    source: 'features/primers/components/PrimerCreationTab.tsx',
    type: 'success',
    message: userMessage('notice.created-primer-example'),
    pauseOnInteraction: false,
  }),
  'primer-creation-tab-updated-primer-example': defineToast({
    category: 'Primer Creation Tab',
    source: 'features/primers/components/PrimerCreationTab.tsx',
    type: 'success',
    message: userMessage('notice.saved-primer-example'),
    pauseOnInteraction: false,
  }),
  'assembly-parts-section-could-not-open-the-source-sequence': defineToast({
    category: 'Assembly Parts Section',
    source: 'features/assembly-panel/components/AssemblyPartsSection.tsx',
    type: 'error',
    message: userMessage('failure.could-not-open-the-source-sequence'),
  }),
  'use-sequence-persistence-example-was-written-but-copied-primer-bindings-were-not-attached-example-erro':
    defineToast({
      category: 'use Sequence Persistence',
      source: 'features/sequence/hooks/useSequencePersistence.ts',
      type: 'error',
      message: userMessage(
        'notice.example-was-written-but-copied-primer-bindings-were-not-attached-examp'
      ),
      timing: 'persistent',
    }),
  'use-sequence-persistence-failed-to-save-example-example-error-your-changes-are-still-in-memory-but-were':
    defineToast({
      category: 'use Sequence Persistence',
      source: 'features/sequence/hooks/useSequencePersistence.ts',
      type: 'error',
      message: userMessage(
        'notice.failed-to-save-example-example-error-your-changes-are-still-in-memory-'
      ),
      timing: 'persistent',
    }),
  'use-git-history-created-initial-version-for-git-tracking': defineToast({
    category: 'use Git History',
    source: 'features/sequence/hooks/useGitHistory.ts',
    type: 'info',
    message: userMessage('notice.created-initial-version-for-git-tracking'),
  }),
  'inline-agent-confirmation-agent-request-denied-because-its-chat-was-closed': defineToast({
    category: 'Inline Agent Confirmation',
    source: 'features/ai/agent-confirm/InlineAgentConfirmation.tsx',
    type: 'warning',
    message: userMessage('notice.agent-request-denied-because-its-chat-was-closed'),
  }),
  'inline-agent-confirmation-agent-turn-cancelled-because-its-chat-was-closed': defineToast({
    category: 'Inline Agent Confirmation',
    source: 'features/ai/agent-confirm/InlineAgentConfirmation.tsx',
    type: 'warning',
    message: userMessage('notice.agent-turn-cancelled-because-its-chat-was-closed'),
  }),
  'file-handling-settings-choose-dnaforge-in-windows-default-apps-then-return-here': defineToast({
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'info',
    message: userMessage('notice.choose-dnaforge-in-windows-default-apps-then-return-here'),
    timing: 'notice',
  }),
  'file-handling-settings-change-the-default-app-in-finder-get-info': defineToast({
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'info',
    message: userMessage('failure.change-the-default-app-in-finder-get-info'),
    timing: 'notice',
  }),
  'file-handling-settings-default-app-controls-are-unavailable': defineToast({
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'error',
    message: userMessage('failure.default-app-controls-are-unavailable'),
  }),
  'file-handling-settings-the-system-did-not-report-dnaforge-as-the-default-app': defineToast({
    requiresVariant: true,
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'info',
    message: userMessage('notice.the-system-did-not-report-dnaforge-as-the-default-app'),
    variants: {
      success: {
        type: 'success',
        message: userMessage('notice.the-system-did-not-report-dnaforge-as-the-default-app'),
      },
      warning: {
        type: 'warning',
        message: userMessage('notice.the-system-did-not-report-dnaforge-as-the-default-app'),
      },
    },
  }),
  'file-handling-settings-could-not-change-the-default-app-example-error': defineToast({
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'error',
    message: userMessage('notice.could-not-change-the-default-app-example-error'),
  }),
  'file-handling-settings-choose-a-example-file-example': defineToast({
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'error',
    message: userMessage('notice.choose-a-example-file-example'),
  }),
  'file-handling-settings-could-not-preview-the-file-example-error': defineToast({
    category: 'File Handling Settings',
    source: 'features/file-associations/FileHandlingSettings.tsx',
    type: 'error',
    message: userMessage('notice.could-not-preview-the-file-example-error'),
  }),
  'clipboard-paste-warning': defineToast({
    category: 'use rich sequence clipboard',
    source: 'features/sequence-clipboard/use-rich-sequence-clipboard.ts',
    type: 'warning',
    message: userMessage(
      'notice.the-copied-sequence-cannot-be-pasted-here-without-changing-its-meaning'
    ),
    timing: 'persistent',
    dismissOn: 'surface',
  }),
  'accepted-finalization-workflow-plasmid-package-was-written-but-git-history-was-not-recorded-the-construct-i':
    defineToast({
      category: 'accepted finalization workflow',
      source: 'features/assembly/accepted-finalization-workflow.ts',
      type: 'warning',
      message: userMessage(
        'notice.plasmid-package-was-written-but-git-history-was-not-recorded-the-const'
      ),
    }),
  'accepted-finalization-workflow-no-project-is-available-for-saving-assembly-primers': defineToast(
    {
      category: 'accepted finalization workflow',
      source: 'features/assembly/accepted-finalization-workflow.ts',
      type: 'warning',
      message: userMessage('notice.no-project-is-available-for-saving-assembly-primers'),
    }
  ),
  'accepted-finalization-workflow-assembly-primers-recorded-but-committing-them-failed':
    defineToast({
      category: 'accepted finalization workflow',
      source: 'features/assembly/accepted-finalization-workflow.ts',
      type: 'error',
      message: userMessage('notice.assembly-primers-recorded-but-committing-them-failed'),
    }),
  'accepted-finalization-workflow-3-assembly-primers-could-not-be-recorded': defineToast({
    category: 'accepted finalization workflow',
    source: 'features/assembly/accepted-finalization-workflow.ts',
    type: 'error',
    message: userMessage('notice.3-assembly-primers-could-not-be-recorded'),
  }),
  'accepted-finalization-workflow-assembly-primers-could-not-be-recorded': defineToast({
    category: 'accepted finalization workflow',
    source: 'features/assembly/accepted-finalization-workflow.ts',
    type: 'error',
    message: userMessage('notice.assembly-primers-could-not-be-recorded'),
  }),
  'sign-in-error': defineToast({
    category: 'auth store',
    source: 'stores/auth-store.ts',
    type: 'error',
    message: userMessage('notice.sign-in-failed-please-try-again'),
  }),
  'sign-in-encryption-unavailable': defineToast({
    category: 'auth store',
    source: 'stores/auth-store.ts',
    type: 'error',
    message: userMessage(
      'notice.encrypted-storage-is-unavailable-on-this-system-sign-in-is-not-support'
    ),
    timing: 'persistent',
  }),
  'auth-store-signed-in-as-example': defineToast({
    category: 'auth store',
    source: 'stores/auth-store.ts',
    type: 'success',
    message: userMessage('notice.signed-in-as-example'),
  }),
  'auth-store-sign-in-is-unavailable-in-this-environment': defineToast({
    category: 'auth store',
    source: 'stores/auth-store.ts',
    type: 'error',
    message: userMessage('notice.sign-in-is-unavailable-in-this-environment'),
  }),
  'backtranslate-result-dialog-copied-backtranslated-dna-to-clipboard': defineToast({
    category: 'Backtranslate Result Dialog',
    source: 'features/proteins/components/BacktranslateResultDialog.tsx',
    type: 'success',
    message: userMessage('notice.copied-backtranslated-dna-to-clipboard'),
  }),
  'protein-sequence-tab-copied-3-residues': defineToast({
    category: 'Protein Sequence Tab',
    source: 'features/proteins/components/ProteinSequenceTab.tsx',
    type: 'success',
    message: userMessage('notice.copied-3-residues'),
  }),
  'protein-sequence-tab-protein-sequence-saved': defineToast({
    category: 'Protein Sequence Tab',
    source: 'features/proteins/components/ProteinSequenceTab.tsx',
    type: 'success',
    message: userMessage('notice.protein-sequence-saved'),
  }),
  'protein-sequence-tab-handle-save': defineToast({
    category: 'Protein Sequence Tab',
    source: 'features/proteins/components/ProteinSequenceTab.tsx',
    type: 'error',
    message: userMessage('notice.the-protein-sequence-could-not-be-saved'),
  }),
  'protein-creation-tab-created-protein-example': defineToast({
    category: 'Protein Creation Tab',
    source: 'features/proteins/components/ProteinCreationTab.tsx',
    type: 'success',
    message: userMessage('notice.created-protein-example'),
  }),
  'protein-creation-tab-save': defineToast({
    category: 'Protein Creation Tab',
    source: 'features/proteins/components/ProteinCreationTab.tsx',
    type: 'error',
    message: userMessage('notice.the-protein-could-not-be-created'),
  }),
  'use-organization-settings-created-example': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.created-example'),
  }),
  'use-organization-settings-invited-example-example-com': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.invited-example-example-com'),
  }),
  'use-organization-settings-invited-example-example-com-email-was-not-sent': defineToast({
    requiresVariant: true,
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'info',
    message: userMessage('notice.invited-example-example-com-email-was-not-sent'),
    variants: {
      success: {
        type: 'success',
        message: userMessage('notice.invited-example-example-com-email-was-not-sent'),
      },
      warning: {
        type: 'warning',
        message: userMessage('notice.invited-example-example-com-email-was-not-sent'),
      },
    },
  }),
  'use-organization-settings-handle-role-change': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.revoked-2-pending-invites'),
  }),
  'use-organization-settings-handle-remove': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.revoked-2-pending-invites'),
  }),
  'use-organization-settings-you-left-the-organization': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.you-left-the-organization'),
  }),
  'use-organization-settings-ownership-transferred-you-are-now-an-admin': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.ownership-transferred-you-are-now-an-admin'),
  }),
  'use-organization-settings-invite-link-copied': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.invite-link-copied'),
  }),
  'use-organization-settings-saved-organization-settings': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.saved-organization-settings'),
  }),
  'use-organization-settings-deleted-example': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.deleted-example'),
  }),
  'use-organization-settings-directory-setup-opened-in-your-browser': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.directory-setup-opened-in-your-browser'),
  }),
  'use-organization-settings-directory-group-role-saved': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.directory-group-role-saved'),
  }),
  'use-organization-settings-organization-registry-configured': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.organization-registry-configured'),
  }),
  'use-organization-settings-registry-change-synchronized': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.registry-change-synchronized'),
  }),
  'use-organization-settings-registry-change-queued-for-retry': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'warning',
    message: userMessage('notice.registry-change-queued-for-retry'),
  }),
  'use-organization-settings-queued-the-revised-local-change': defineToast({
    category: 'use Organization Settings',
    source: 'features/auth/useOrganizationSettings.ts',
    type: 'success',
    message: userMessage('notice.queued-the-revised-local-change'),
  }),
  'use-cloud-workspace-controller-opened-example': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.opened-example'),
  }),
  'cloud-project-warning': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'warning',
    message: userMessage('notice.the-cloud-project-is-open-but-an-item-needs-attention'),
  }),
  'use-cloud-workspace-controller-could-not-load-sync-status': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.could-not-load-sync-status'),
  }),
  'cloud-action-completed': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.the-project-was-synchronized'),
  }),
  'cloud-action-failed': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.the-cloud-operation-failed'),
  }),
  'use-cloud-workspace-controller-some-items-need-your-decision-before-they-can-sync': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'warning',
    message: userMessage('notice.some-items-need-your-decision-before-they-can-sync'),
  }),
  'use-cloud-workspace-controller-combined-changes-from-example-with-yours-syncing-now':
    defineToast({
      category: 'use Cloud Workspace Controller',
      source: 'features/auth/useCloudWorkspaceController.ts',
      type: 'success',
      message: userMessage('notice.combined-changes-from-example-with-yours-syncing-now'),
    }),
  'use-cloud-workspace-controller-nothing-new-to-combine-syncing-now': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.nothing-new-to-combine-syncing-now'),
  }),
  'use-cloud-workspace-controller-could-not-combine-changes': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.could-not-combine-changes'),
  }),
  'use-cloud-workspace-controller-a-newer-shared-version-arrived-while-you-were-choosing-a-few-items-still-need':
    defineToast({
      category: 'use Cloud Workspace Controller',
      source: 'features/auth/useCloudWorkspaceController.ts',
      type: 'warning',
      message: userMessage(
        'notice.a-newer-shared-version-arrived-while-you-were-choosing-a-few-items-sti'
      ),
    }),
  'use-cloud-workspace-controller-your-choices-were-applied-syncing-now': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.your-choices-were-applied-syncing-now'),
  }),
  'use-cloud-workspace-controller-could-not-apply-your-choices': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.could-not-apply-your-choices'),
  }),
  'use-cloud-workspace-controller-cloud-copy-removed-this-project-is-now-local-only': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.cloud-copy-removed-this-project-is-now-local-only'),
  }),
  'share-snapshot-edit-blocked': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'info',
    message: userMessage('notice.finish-or-discard-your-edits-before-sharing-a-snapshot'),
  }),
  'cloud-share-result': defineToast({
    requiresVariant: true,
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'info',
    message: userMessage('notice.snapshot-shared-version-3-link-copied'),
    variants: {
      success: {
        type: 'success',
        message: userMessage('notice.snapshot-shared-version-3-link-copied'),
      },
      warning: {
        type: 'warning',
        message: userMessage(
          'notice.snapshot-shared-version-3-copy-the-link-from-sharing-settings'
        ),
      },
    },
  }),
  'use-cloud-workspace-controller-sync-requested': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.sync-requested'),
  }),
  'use-cloud-workspace-controller-sync-action-failed': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.sync-action-failed'),
  }),
  'use-cloud-workspace-controller-local-changes-queued-for-backup': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    message: userMessage('notice.local-changes-queued-for-backup'),
  }),
  'use-cloud-workspace-controller-conflict-resolution-failed': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.conflict-resolution-failed'),
  }),
  'use-cloud-workspace-controller-could-not-open-cloud-project': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.could-not-open-cloud-project'),
  }),
  'scientific-cloud-recovery-complete': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'success',
    timing: 'persistent',
    message: userMessage(
      'notice.recovered-accepted-scientific-history-in-a-separate-profile-opening-in'
    ),
  }),
  'scientific-cloud-recovery-failed': defineToast({
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'error',
    message: userMessage('notice.could-not-recover-scientific-history'),
  }),
  'cloud-backup-result': defineToast({
    requiresVariant: true,
    category: 'use Cloud Workspace Controller',
    source: 'features/auth/useCloudWorkspaceController.ts',
    type: 'info',
    message: userMessage('failure.cloud-backup-action-is-not-available-yet'),
    variants: {
      info: {
        type: 'info',
        message: userMessage('failure.cloud-backup-action-is-not-available-yet'),
      },
      error: {
        type: 'error',
        message: userMessage('failure.cloud-backup-action-is-not-available-yet'),
      },
    },
  }),
  'profile-photo-invalid': defineToast({
    category: 'Account Settings Content',
    source: 'features/auth/AccountSettingsContent.tsx',
    type: 'error',
    message: userMessage('notice.choose-a-supported-profile-photo'),
  }),
  'account-settings-content-could-not-save-photo': defineToast({
    category: 'Account Settings Content',
    source: 'features/auth/AccountSettingsContent.tsx',
    type: 'error',
    message: userMessage('notice.could-not-save-photo'),
  }),
  'account-settings-content-photo-updated': defineToast({
    category: 'Account Settings Content',
    source: 'features/auth/AccountSettingsContent.tsx',
    type: 'success',
    message: userMessage('notice.photo-updated'),
  }),
  'account-settings-content-could-not-save-profile': defineToast({
    category: 'Account Settings Content',
    source: 'features/auth/AccountSettingsContent.tsx',
    type: 'error',
    message: userMessage('failure.could-not-save-profile'),
  }),
  'account-settings-content-profile-saved': defineToast({
    category: 'Account Settings Content',
    source: 'features/auth/AccountSettingsContent.tsx',
    type: 'success',
    message: userMessage('notice.profile-saved'),
  }),
  'profile-error': defineToast({
    category: 'Account Settings Content',
    source: 'features/auth/AccountSettingsContent.tsx',
    type: 'error',
    message: userMessage('notice.the-account-change-could-not-be-saved'),
  }),
  'share-snapshot-disabled': defineToast({
    category: 'Share Snapshot Control',
    source: 'features/auth/ShareSnapshotControl.tsx',
    type: 'info',
    message: userMessage('notice.save-this-project-before-sharing-a-snapshot'),
  }),
  'share-snapshot-failed': defineToast({
    category: 'Share Snapshot Control',
    source: 'features/auth/ShareSnapshotControl.tsx',
    type: 'error',
    message: userMessage('notice.the-snapshot-could-not-be-shared'),
  }),
  'share-snapshot-control-on-share': defineToast({
    category: 'Share Snapshot Control',
    source: 'features/auth/ShareSnapshotControl.tsx',
    type: 'success',
    message: userMessage('notice.snapshot-shared-version-3-link-copied'),
  }),
  'share-snapshot-control-could-not-share-snapshot': defineToast({
    category: 'Share Snapshot Control',
    source: 'features/auth/ShareSnapshotControl.tsx',
    type: 'error',
    message: userMessage('failure.could-not-share-snapshot'),
  }),
  'entity-creation-host-created-example': defineToast({
    category: 'Entity Creation Host',
    source: 'features/entity-creation/EntityCreationHost.tsx',
    type: 'success',
    message: userMessage('notice.saved-example'),
  }),
  'sequence-tab-could-not-open-that-quick-look-record': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'error',
    message: userMessage('notice.could-not-open-that-quick-look-record'),
  }),
  'sequence-tab-could-not-copy-the-primer': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'error',
    message: userMessage('failure.could-not-copy-the-primer'),
  }),
  'sequence-metadata-finish-edits-before-switching-views': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'warning',
    message: userMessage(
      'notice.save-or-cancel-the-unfinished-metadata-edits-before-switching-views'
    ),
  }),
  'assembly-working-copy-save-failed': defineToast({
    category: 'Assembly Working Copy',
    source: 'features/design/components/useEmbeddedAssemblyWorkingCopyOwner.ts',
    type: 'error',
    message: userMessage('failure.could-not-save-the-assembly-working-copy'),
    timing: 'persistent',
  }),
  'sequence-restore-git-delivery-incomplete': defineToast({
    category: 'Sequence Restore',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'warning',
    message: userMessage(
      'notice.restore-published-but-git-history-delivery-is-incomplete-or-unverified'
    ),
    timing: 'persistent',
  }),
  'sequence-save-close-metadata-draft-must-be-resolved': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'warning',
    message: userMessage(
      'notice.save-or-cancel-the-unfinished-metadata-edits-in-its-drawer-before-clos'
    ),
  }),
  'sequence-tab-open-this-file-inside-a-project-to-create-a-protein': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'error',
    message: userMessage('notice.open-this-file-inside-a-project-to-create-a-protein'),
  }),
  'sequence-tab-registered-protein-example-example-at-example-file': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'success',
    message: userMessage('notice.registered-protein-example-example-at-example-file'),
  }),
  'sequence-tab-failed-to-create-amino-acid-sequence': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'error',
    message: userMessage('failure.failed-to-create-amino-acid-sequence'),
  }),
  'sequence-tab-the-annotation-file-could-not-be-imported': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'error',
    message: userMessage('failure.the-annotation-file-could-not-be-imported'),
    timing: 'notice',
  }),
  'sequence-tab-handle-commit': defineToast({
    requiresVariant: true,
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'info',
    message: userMessage('notice.annotation-import-is-blocked-until-your-sequence-edits-are-saved'),
    timing: 'notice',
    variants: {
      warning: {
        type: 'warning',
        message: userMessage(
          'notice.annotation-import-is-blocked-until-your-sequence-edits-are-saved'
        ),
      },
      error: {
        type: 'error',
        message: userMessage(
          'notice.annotation-import-is-blocked-until-your-sequence-edits-are-saved'
        ),
      },
    },
  }),
  'sequence-tab-the-result-was-saved-but-its-version-history-checkpoint-failed-check-the-job':
    defineToast({
      category: 'Sequence Tab',
      source: 'features/sequence/components/SequenceTab.tsx',
      type: 'warning',
      message: userMessage(
        'notice.the-result-was-saved-but-its-version-history-checkpoint-failed-check-t'
      ),
      timing: 'notice',
    }),
  'sequence-tab-the-result-was-saved-its-document-view-still-needs-to-refresh': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'warning',
    message: userMessage(
      'notice.the-result-was-saved-its-current-view-is-not-confirmed-reopen-the-save'
    ),
    timing: 'persistent',
    actionLabels: ['Reopen saved document'],
    actionDismisses: false,
  }),
  'sequence-tab-saved-annotation-reopen-blocked': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/annotation-save-recovery.ts',
    type: 'warning',
    message: userMessage(
      'notice.the-result-was-saved-save-or-cancel-any-current-edits-then-reopen-the-'
    ),
    timing: 'notice',
  }),
  'sequence-tab-commit-or-discard-your-sequence-edits-before-applying-annotations': defineToast({
    category: 'Sequence Tab',
    source: 'features/sequence/components/SequenceTab.tsx',
    type: 'warning',
    message: userMessage(
      'notice.commit-or-discard-your-sequence-edits-before-applying-annotations'
    ),
    timing: 'notice',
  }),
  'use-sequence-clipboard-actions-copied-3-bp-forward': defineToast({
    category: 'use Sequence Clipboard Actions',
    source: 'features/sequence/components/useSequenceClipboardActions.ts',
    type: 'success',
    message: userMessage('notice.copied-3-bp-forward'),
  }),
  'reference-view-open-attention': defineToast({
    requiresVariant: true,
    category: 'Reference Genome Picker',
    source: 'features/sequence/components/ReferenceGenomePicker.tsx',
    type: 'info',
    message: userMessage('notice.one-track-in-this-view-could-not-be-opened'),
    variants: {
      error: {
        type: 'error',
        message: userMessage('notice.one-track-in-this-view-could-not-be-opened'),
        timing: 'persistent',
      },
      warning: {
        type: 'warning',
        message: userMessage('notice.the-saved-reference-needs-attention'),
        timing: 'persistent',
      },
    },
  }),
  'workspace-loader-unconverted-sequence-files': defineToast({
    category: 'Workspace loader',
    source: 'features/workspace-loader/unconverted-sequence-notice.ts',
    type: 'warning',
    message: userMessage(
      'notice.2-sequence-files-were-kept-as-plain-files-protein-fasta-guide-fa-open-'
    ),
  }),
  'loose-sequence-package-notice-refresh-after-convert-failed': defineToast({
    category: 'Loose Sequence Package Notice',
    source: 'features/sequence/components/LooseSequencePackageNotice.tsx',
    type: 'warning',
    message: userMessage('notice.converted-the-file-but-the-project-view-could-not-refresh'),
  }),
  'loose-sequence-package-notice-open-after-convert-failed': defineToast({
    category: 'Loose Sequence Package Notice',
    source: 'features/sequence/components/LooseSequencePackageNotice.tsx',
    type: 'warning',
    message: userMessage('notice.converted-the-file-but-1-of-its-2-sequences-could-not-be-opened'),
  }),
  'copy-translation-dialog-handle-copy': defineToast({
    category: 'Copy Translation Dialog',
    source: 'features/sequence/components/CopyTranslationDialog.tsx',
    type: 'success',
    message: userMessage('notice.copied-translation-to-clipboard'),
  }),
  'copy-translation-dialog-failed-to-copy-translation': defineToast({
    category: 'Copy Translation Dialog',
    source: 'features/sequence/components/CopyTranslationDialog.tsx',
    type: 'error',
    message: userMessage('notice.failed-to-copy-translation'),
  }),
  'indexed-genome-tab-saved-example': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.saved-example'),
  }),
  'indexed-genome-tab-could-not-save-this-genome-view': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('failure.could-not-save-this-genome-view'),
    timing: 'persistent',
  }),
  'indexed-genome-tab-enter-one-assembly-coordinate-using-numbers-only': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.enter-one-assembly-coordinate-using-numbers-only'),
  }),
  'track-view-result': defineToast({
    requiresVariant: true,
    category: 'Track View Actions',
    source: 'features/sequence/components/TrackViewActions.tsx',
    type: 'info',
    message: userMessage('notice.view-saved'),
    variants: {
      warning: {
        type: 'warning',
        message: userMessage('notice.the-view-was-saved-but-one-setting-needs-attention'),
      },
      success: {
        type: 'success',
        message: userMessage('notice.view-saved'),
      },
    },
  }),
  'track-view-failed': defineToast({
    category: 'Track View Actions',
    source: 'features/sequence/components/TrackViewActions.tsx',
    type: 'error',
    message: userMessage('notice.the-view-could-not-be-saved'),
  }),
  'assistant-route-fallback': defineToast({
    category: 'AI route fallback',
    source: 'features/ai/orchestration/assistant-route-fallback-notice.ts',
    type: 'warning',
    message: userMessage('notice.claude-code-is-signed-out-sent-with-codex-cli-openai'),
  }),
  'paste-copied-sequence-could-not-attach-the-copied-sequence': defineToast({
    category: 'paste copied sequence',
    source: 'features/ai/paste-copied-sequence.ts',
    type: 'error',
    message: userMessage('notice.could-not-attach-the-copied-sequence'),
  }),
  'compute-job-ready': defineToast({
    category: 'job terminal adapter',
    source: 'features/compute/job-terminal-adapter.ts',
    type: 'success',
    message: userMessage(
      'notice.example-compute-job-finished-on-your-provider-import-it-into-your-work'
    ),
    timing: 'persistent',
    actionLabels: ['Import'],
  }),
  'structure-prediction-result': defineToast({
    requiresVariant: true,
    category: 'predict structure',
    source: 'features/compute/predict-structure.ts',
    type: 'info',
    message: userMessage(
      'notice.structure-prediction-submitted-the-result-will-be-imported-when-it-fin'
    ),
    variants: {
      info: {
        type: 'info',
        message: userMessage(
          'notice.structure-prediction-submitted-the-result-will-be-imported-when-it-fin'
        ),
      },
      success: {
        type: 'success',
        message: userMessage('notice.the-predicted-structure-is-saved-in-your-workspace'),
      },
      error: {
        type: 'error',
        message: userMessage(
          'notice.the-structure-prediction-failed-please-review-the-job-and-try-again'
        ),
        timing: 'persistent',
      },
    },
  }),
  'page-reference-open-failed': defineToast({
    category: 'Notebook references',
    source: 'features/page/editor/components/SavedReferenceChip.tsx',
    type: 'error',
    message: userMessage('failure.could-not-open-saved-result'),
    timing: 'notice',
  }),
  'page-molecular-view-open-failed': defineToast({
    category: 'Molecular views',
    source: 'features/page/components/PageEditor.tsx',
    type: 'error',
    message: userMessage('notice.could-not-open-molecular-view'),
    timing: 'notice',
  }),
  'debug-snapshot-saved': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.snapshot-saved'),
    timing: 'confirmation',
    type: 'success',
  }),
  'debug-snapshot-failed': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.snapshot-failed-example-error'),
    timing: 'notice',
    type: 'error',
  }),
  'debug-webgl-recording': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.webgl-trace-recording-press-cmd-shift-7-to-stop'),
    timing: 'notice',
    type: 'info',
  }),
  'debug-webgl-saved': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.webgl-trace-saved-example-trace-json'),
    timing: 'notice',
    type: 'success',
  }),
  'debug-cpu-unavailable': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.cpu-profile-unavailable-not-in-electron'),
    timing: 'notice',
    type: 'warning',
  }),
  'debug-cpu-recording': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.cpu-profile-recording-press-cmd-shift-0-to-stop'),
    timing: 'notice',
    type: 'info',
  }),
  'debug-cpu-saved': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.cpu-profile-saved-1000ms-example-profile-cpuprofile'),
    timing: 'notice',
    type: 'success',
  }),
  'debug-cpu-failed': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.cpu-profile-failed-example-error'),
    timing: 'notice',
    type: 'error',
  }),
  'debug-chat-saved': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.chat-snapshot-saved'),
    timing: 'confirmation',
    type: 'success',
  }),
  'debug-chat-failed': defineToast({
    category: 'Debug',
    source: 'App.tsx',
    group: 'debug-capture',
    message: userMessage('notice.chat-snapshot-failed-example-error'),
    timing: 'notice',
    type: 'error',
  }),
  'sequence-evidence-save-failed': defineToast({
    category: 'Sequence evidence',
    source: 'features/alignment-manager/store/store.ts',
    group: 'sequence-evidence-save',
    message: userMessage(
      'notice.sequencing-review-changes-could-not-be-saved-keep-this-entity-open-and'
    ),
    timing: 'persistent',
    type: 'error',
  }),
  'sequence-evidence-retained': defineToast({
    category: 'Sequence evidence',
    source: 'features/alignment-manager/store/store.ts',
    group: 'sequence-evidence-retained',
    message: userMessage('notice.sequencing-evidence-is-retained-in-this-entity-history'),
    timing: 'notice',
    type: 'info',
  }),
  'sequence-save-failed': defineToast({
    category: 'Sequence',
    source: 'features/sequence/sequence-document-client.ts',
    type: 'error',
    message: userMessage('notice.the-sequence-could-not-be-saved'),
  }),
  'native-notebook-reload-failed': defineToast({
    category: 'Notebook',
    source: 'features/page/components/PageEditor.tsx',
    type: 'error',
    message: userMessage('failure.the-notebook-could-not-reload'),
  }),
  'native-notebook-load-failed': defineToast({
    category: 'Notebook',
    source: 'features/page/components/PageEditor.tsx',
    type: 'error',
    message: userMessage('notice.the-notebook-owner-could-not-load'),
  }),
  'native-notebook-discard-failed': defineToast({
    category: 'Notebook',
    source: 'features/page/components/PageEditor.tsx',
    type: 'error',
    message: userMessage('failure.the-notebook-could-not-be-discarded'),
  }),
  'native-notebook-table-view-failed': defineToast({
    category: 'Notebook',
    source: 'features/page/hooks/useNativeNotebookTable.ts',
    type: 'error',
    message: userMessage('failure.the-notebook-table-view-could-not-update'),
  }),
  'indexed-genome-tab-source-unavailable': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.the-indexed-source-for-chriv-is-not-available'),
  }),
  'indexed-genome-tab-reference-action-failed': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.the-indexed-reference-action-failed'),
  }),
  'indexed-genome-tab-select-one-chromosome': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.select-bases-within-one-chromosome-before-using-sequence-actions'),
  }),
  'indexed-genome-tab-interval-no-bases': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.the-indexed-interval-returned-no-bases'),
  }),
  'indexed-genome-tab-copy-sequence-failed': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.failed-to-write-the-sequence-to-the-clipboard'),
  }),
  'indexed-genome-tab-transcript-no-exon-bases': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.the-transcript-returned-no-exon-bases'),
  }),
  'indexed-genome-tab-copied-transcript': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.copied-1-234-bp-dna-nm-000001'),
  }),
  'indexed-genome-tab-copy-transcript-failed': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.failed-to-write-the-transcript-dna-to-the-clipboard'),
  }),
  'indexed-genome-tab-copied-translation': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.copied-412-amino-acids'),
  }),
  'indexed-genome-tab-copy-translation-failed': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.failed-to-write-the-translation-to-the-clipboard'),
  }),
  'indexed-genome-tab-protein-needs-project': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.open-this-reference-inside-a-project-to-create-a-protein'),
  }),
  'indexed-genome-tab-cds-incomplete-codon': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage(
      'notice.this-cds-cannot-create-a-protein-because-it-has-an-incomplete-codon-or'
    ),
  }),
  'indexed-genome-tab-protein-registered': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.registered-protein-jun-prt-0001-at-proteins-jun-json'),
  }),
  'indexed-genome-tab-protein-create-failed': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('failure.failed-to-create-amino-acid-sequence'),
  }),
  'indexed-genome-tab-annotation-deleted': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.deleted-annotation-promoter'),
  }),
  'indexed-genome-tab-annotation-added': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.added-annotation-promoter'),
  }),
  'indexed-genome-tab-annotation-updated': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'success',
    message: userMessage('notice.updated-annotation-promoter'),
  }),
  'indexed-genome-tab-tool-error': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('failure.could-not-read-the-reference'),
  }),
  'indexed-genome-tab-cds-not-complete-protein': defineToast({
    category: 'Indexed Genome Tab',
    source: 'features/sequence/components/IndexedGenomeTab.tsx',
    type: 'error',
    message: userMessage('notice.this-cds-does-not-translate-to-a-complete-protein'),
  }),
} as const;

export type ToastDefinitionId = keyof typeof TOAST_DEFINITIONS;
export interface ToastSelection {
  definition: ToastDefinitionId;
  variant?: string;

  key?: string;
}

export function resolveToastDefinition(selection: ToastSelection): ToastDefinition {
  const definition = TOAST_DEFINITIONS[selection.definition];
  if (!definition) throw new Error('Unknown toast definition: ' + selection.definition);
  const variant = selection.variant ?? 'default';
  if (definition.requiresVariant && variant === 'default')
    throw new Error('Toast requires a declared variant: ' + selection.definition);
  if (
    variant !== 'default' &&
    !Object.prototype.hasOwnProperty.call(definition.variants, variant)
  ) {
    throw new Error('Unknown toast variant: ' + selection.definition + '/' + variant);
  }
  return { ...definition, ...(variant === 'default' ? {} : definition.variants[variant]) };
}

export const TOAST_REVIEW_ENTRIES = Object.entries(TOAST_DEFINITIONS).flatMap(
  ([definition, value]) =>
    [...(value.requiresVariant ? [] : ['default']), ...Object.keys(value.variants)].map(
      (variant) => {
        const selection: ToastSelection = { definition: definition as ToastDefinitionId, variant };
        return {
          ...resolveToastDefinition(selection),
          ...selection,
          id: definition + '/' + variant,
        };
      }
    )
);
