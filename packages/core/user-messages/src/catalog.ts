export const USER_MESSAGES = {
  'notice.file-change-saved-project-update-incomplete':
    'The file change was saved, but the project update did not finish. Reopen the project to refresh it.',
  'project.relink.unbound-file-document':
    'This project has retained file recovery identities that cannot follow a folder move yet. The original project and recovery records have been kept.',
  'project.relink.scientific-document':
    'This project contains scientific documents or notebooks whose recovery records cannot follow a folder move yet. The original project and recovery records have been kept.',
  'project.relink.unsaved-document':
    'This project has unsaved or recovered changes. Save, discard, or recover them before linking a different folder.',

  'project.relink.identity-unavailable':
    'This project has no retained folder identity. Its records have been kept.',
  'project.relink.source-present':
    'The original folder is present or cannot be checked. Refresh projects before trying again.',
  'project.relink.invalid-target':
    'Select the original project folder with its project identity and history intact.',
  'project.relink.identity-mismatch':
    'That folder belongs to a different project. Select the original project folder.',
  'project.relink.compute-dependency':
    'This project has retained compute results tied to its original folder. Locate cannot move those records yet; the existing records have been kept.',
  'project.relink.pending-sync-delivery':
    'This project has an unfinished sync delivery. Resolve it before linking a different folder.',
  'project.relink.path-conflict':
    'That folder is already registered to another project. No records were changed.',
  'project.relink.linked-refresh': 'The project folder was linked. Refresh projects to reopen it.',
  'project.relink.failed':
    'The project folder could not be linked. Its existing records have been kept.',

  'account.inviteRevoked': '1 pending invite they issued was revoked.',
  'registry.import.notSelected': 'not imported',
  'sheetSync.syncing': 'Syncing…',
  'sheetSync.paused': 'Paused',
  'sheetSync.authorizeWorkbook': 'Choose this workbook on this device to enable sync.',
  'registry.schema.keyFormat':
    'Schema key must start with a letter and contain only lowercase letters, numbers, or underscores.',
  'registry.schema.needsField': 'An independent record needs at least one field.',
  'registry.schema.fieldLabelRequired': 'Every field needs a label.',
  'registry.schema.fieldKeyFormat':
    'Field keys must start with a letter and contain only letters, numbers, or underscores.',
  'primer.sequenceRequired': 'Enter an oligo sequence.',
  'primer.sequenceInvalid': 'The oligo sequence is invalid.',
  'primer.unclosedModification': 'Close the modification code with a slash.',
  'primer.nameRequired': 'Enter a name for this primer.',
  'primer.targetUnavailable':
    'Reopen the target sequence from its project before attaching this primer.',
  'primer.firstSaveFolderChanged':
    'Your first save reached the original folder. Choose that folder to save the newer edits to the same primer.',
  'primer.saveLocationInvalid':
    'Choose a save folder in this project and try again. Your primer draft is still here.',
  'primer.save.open-a-sequence-from-a-project-before-saving-a-primer':
    'Open a sequence from a project before saving a primer.',
  'primer.save.the-selected-template-region-is-not-available':
    'The selected template region is not available.',
  'primer.save.primer-binding-site-runs-past-the-loaded-template-shorten-the-primer-or-adjust-the-selection':
    'Primer binding site runs past the loaded template — shorten the primer or adjust the selection.',
  'primer.save.primer-binding-site-runs-past-the-template-shorten-the-primer-or-adjust-the-selection':
    'Primer binding site runs past the template — shorten the primer or adjust the selection.',
  'primer.save.choose-a-save-folder-in-an-open-project-your-primer-draft-is-still-here':
    'Choose a save folder in an open project. Your primer draft is still here.',
  'primer.save.this-primer-belongs-to-a-different-project-now-keep-this-draft-and-reopen-the-primer-from-its-owning-project-b':
    'This primer belongs to a different project now. Keep this draft and reopen the primer from its owning project before saving.',
  'primer.save.save-this-bound-primer-in-the-same-project-as-its-target-sequence-choose-that-project-in-the-save-location-you':
    'Save this bound primer in the same project as its target sequence. Choose that project in the save location. Your draft is still here.',
  'update.downloading': 'Download in progress',
  'update.downloadProgress': 'Update download progress',
  'sharing.people.access-removed': 'Access removed.',
  'sharing.people.access-unchanged': 'Access unchanged.',
  'sharing.people.access-updated': 'Access updated.',
  'sharing.people.organization-wide-access-removed-people-with-their-own-invitation-keep-access':
    'Organization-wide access removed. People with their own invitation keep access.',
  'sharing.people.organization-wide-access-unchanged': 'Organization-wide access unchanged.',
  'sharing.people.everyone-in-the-organization-can-now-open-this-project':
    'Everyone in the organization can now open this project.',
  'sharing.people.invitation-revoked': 'Invitation revoked.',
  'sharing.people.a-fresh-invitation-was-created-email-delivery-could-not-be-confirmed-you-can-share-the-invitation-li':
    'A fresh invitation was created. Email delivery could not be confirmed; you can share the invitation link.',
  'sharing.people.a-fresh-invitation-was-created-but-the-email-could-not-be-sent':
    'A fresh invitation was created, but the email could not be sent.',
  'sharing.snapshotWarning': 'Anyone with this link can view and download this snapshot.',
  'sharing.snapshotEditBlocked': 'Exit edit mode before sharing a snapshot.',
  'sharing.snapshotSignIn': 'Sign in to share a snapshot link.',
  'sharing.snapshotTitle': 'Share snapshot',
  'sharing.snapshotConfirm':
    'Anyone with this link can view and download this snapshot.\n\nThis backs up the latest project state, pins that version, and copies a link. Recipients open an editable local copy — it never updates with your later edits.',
  'account.monthlyAllowanceUsed': 'Monthly allowance used',
  'approval.commandDestructive': 'This command can delete files or directories.',
  'approval.commandReadOnly': 'This command reads data and does not modify files.',
  'approval.commandMutating':
    'This command changes files. Review the command and destination before continuing.',
  'approval.commandUnknown': 'DNAForge could not prove whether this command changes files.',
  'approval.fileReplace': 'Overwrite file',
  'approval.deleteFile': 'Delete file',
  'approval.deleteFolder': 'Delete folder',
  'approval.deleteDirectory': 'Delete directory',
  'approval.editFile': 'Edit file',
  'approval.writeFile': 'Write file',
  'approval.createFile': 'Create file',
  'compute.provider': 'connected compute service',
  'compute.tamarind': 'Tamarind',
  'compute.genericTool': 'Compute job',
  'compute.alphaFold': 'AlphaFold',
  'compute.esmFold': 'ESMFold',
  'compute.boltz2': 'Boltz-2',
  'approval.commandRule': 'this command',
  'approval.fileRule': 'this file',
  'compute.run': 'Run job',
  'compute.notNow': 'Not now',
  'compute.costUnknown': 'Cost estimate not available from the provider.',
  'assistant.readiness.unavailable': 'Unavailable',
  'assistant.readiness.checking': 'Checking',
  'assistant.readiness.needs-login': 'Needs login',
  'assistant.readiness.not-configured-in-this-build': 'Not configured in this build',
  'assistant.readiness.hosted-ai-is-paused': 'Hosted AI is paused',
  'assistant.readiness.account-not-enabled': 'Account not enabled',
  'assistant.readiness.hosted-workflow-unavailable': 'Hosted workflow unavailable',
  'assistant.readiness.ai-provider-unavailable': 'AI provider unavailable',
  'assistant.readiness.hosted-gateway-not-ready': 'Hosted gateway not ready',
  'assistant.readiness.hosted-browser-agent-unavailable': 'Hosted browser agent unavailable',
  'assistant.readiness.hosted-gateway-unreachable': 'Hosted gateway unreachable',
  'assistant.readiness.invalid-gateway-response': 'Invalid gateway response',
  'assistant.readiness.desktop-bridge-unavailable': 'Desktop bridge unavailable',
  'assistant.readiness.install-cli': 'Install CLI',
  'assistant.readiness.needs-key': 'Needs key',
  'assistant.readiness.check-failed': 'Check failed',
  'assistant.readiness.sign-in-required': 'Sign in required',
  'guidance.sequence-property-keys-cannot-be-schema-fields':
    'Sequence property keys cannot be schema fields.',
  'guidance.terminal-could-not-be-opened-check-that-a-supported-terminal-is-installed-then-try-again':
    'Terminal could not be opened. Check that a supported terminal is installed, then try again.',
  'guidance.ssh-connected-but-its-private-local-port-forward-could-not-be-started-retry-the-connection':
    'SSH connected, but its private local port forward could not be started. Retry the connection.',
  'guidance.dnaforge-could-not-prove-whether-this-command-changes-files':
    'DNAForge could not prove whether this command changes files.',
  'guidance.the-kit-needs-a-name': 'The kit needs a name.',
  'guidance.finalization-failed': 'Finalization failed',
  'guidance.molecule-type-unspecified': 'Molecule type unspecified',
  'guidance.not-a-dna-sequence': 'Not a DNA sequence',
  'guidance.already-imported': 'Already imported',
  'guidance.the-selected-project-identity-changed-refresh-the-project-list':
    'The selected project identity changed. Refresh the project list.',
  'guidance.the-save-location-belongs-to-a-different-project-choose-a-folder-in-the-owning-project-and-save':
    'The save location belongs to a different project. Choose a folder in the owning project and save again. Your primer draft is still here.',
  'guidance.dnaforge-ai-could-not-load-the-current-contribution-policy':
    'DNAForge AI could not load the current contribution policy.',
  'guidance.drop-a-benchling-zip-or-html-export': 'Drop a Benchling ZIP or HTML export.',
  'guidance.ucsc-returned-no-assemblies-for-this-track-hub':
    'UCSC returned no assemblies for this track hub.',
  'guidance.this-saved-molecular-view-is-missing': 'This saved molecular view is missing.',
  'guidance.sign-in-required': 'Sign in required',
  'guidance.sync-your-saved-changes-before-sharing-the-server-does-not-yet-have-your-current-draft':
    'Sync your saved changes before sharing. The server does not yet have your current draft.',
  'guidance.sign-up-to-run-this': 'Sign up to run this',
  'guidance.sign-up-to-search': 'Sign up to search',
  'guidance.sign-up-to-share': 'Sign up to share',
  'guidance.the-requested-molecular-document-revision-is-unavailable':
    'The requested molecular document revision is unavailable.',
  'guidance.field-keys-must-be-unique-including-inherited-fields':
    'Field keys must be unique, including inherited fields.',
  'guidance.source-statements-question-or-contradict-the-role':
    'Source statements question or contradict the role.',
  'auth.requestTimedOut': 'Sign-in timed out. Try again.',
  'auth.codeExpired': 'That code is invalid or expired. Try again.',
  'auth.emailSendFailed': 'Could not send the code. Try again, or continue with Google or GitHub.',
  'auth.guidance.01': 'Authentication refresh is offline.',
  'auth.guidance.02': 'Signed out elsewhere — sign in again.',
  'auth.guidance.03': 'Your session expired — sign in again.',
  'auth.guidance.04': 'Signed out — please sign in again.',
  'auth.guidance.06': 'Could not reach the sign-in service.',
  'auth.guidance.08': 'Sign-in is temporarily unavailable. Please try again in a little while.',
  'auth.guidance.09': 'Unsupported sign-in provider.',
  'auth.guidance.10': 'Sign-in expired. Start again.',
  'auth.guidance.11': 'A sign-in is already in progress. Cancel and try again.',
  'auth.guidance.12': 'Sign-in expired. Start again.',
  'auth.guidance.13': 'Could not start sign-in. Try again.',
  'auth.guidance.14': 'Could not reach the sign-in service.',
  'auth.guidance.15': 'The sign-in service returned an unsafe destination. Try again.',
  'auth.guidance.16': 'Sign-in timed out. Start again.',
  'auth.guidance.17': 'Enter your organization email to continue with SSO.',
  'auth.guidance.18': 'Sign-in expired. Start again.',
  'auth.guidance.19': 'A sign-in is already in progress. Cancel and try again.',
  'auth.guidance.20': 'Sign-in expired. Start again.',
  'auth.guidance.21': 'Could not start sign-in. Try again.',
  'auth.guidance.22': 'Could not reach the sign-in service.',
  'auth.guidance.23': 'No SSO is configured for that email domain. Try Google or GitHub.',
  'auth.guidance.24': 'The sign-in service returned an unsafe destination. Try again.',
  'auth.guidance.25': 'Sign-in timed out. Start again.',
  'auth.guidance.26': 'Sign-in was cancelled or denied. Try again.',
  'auth.guidance.27': 'Sign-in is not available right now.',
  'auth.guidance.28':
    'This email is already used with another sign-in method. Try Google, GitHub, or email.',
  'auth.guidance.29': 'Your organization could not be verified. Try another sign-in method.',
  'auth.guidance.30': 'Sign-in expired. Start again.',
  'auth.guidance.31':
    'Organization sign-in is temporarily unavailable. Try Google, GitHub, or email.',
  'auth.guidance.32': 'Sign-in could not be completed. Please try again.',
  'auth.guidance.33': 'Could not finish signing in. Please try again.',
  'auth.guidance.34': 'Sign-in did not complete. Please try again.',
  'auth.guidance.35': 'Could not reach the sign-in service. Try again.',
  'auth.guidance.36': 'Sign-in request expired. Start again.',
  'auth.guidance.37': 'Sign-in request expired. Start again.',
  'auth.guidance.38': 'Network error. Try again.',
  'auth.guidance.39': 'That code is invalid or expired. Try again.',
  'auth.guidance.40': 'Could not complete sign-in (network).',
  'auth.guidance.41': 'Sign-in could not be completed.',
  'auth.guidance.42': 'Could not update profile.',
  'auth.guidance.43': 'The active session changed.',
  'auth.guidance.44': 'The active session changed.',
  'auth.guidance.45': 'Could not save profile locally.',
  'auth.guidance.46': 'The active session changed.',
  'assembly.replaceProduct':
    'This plasmid file was edited after the last accepted construction. Finalizing will replace that DNA with the new assembly product.',
  'jobs.cancelConfirm':
    'The service will be asked to cancel this job. Work it already completed may still be billed.',
  'startup.reloadWindow': 'Try again, or quit and reopen DNAForge.',
  'registry.recoveryNeeded':
    'Your registry needs attention before it can be used. Reopen DNAForge and try again.',
  'attachments.refreshFailed':
    'The attachment was saved, but the view could not refresh. Reopen the sequence to see it.',
  'attachments.changeFailed': 'We couldn’t update the attachments. Try again.',
  'genome.searchFailed': 'We couldn’t search this reference. Try again.',
  'file.defaultAppFailed': 'Could not change the default app. Try again.',
  'file.previewFailed': 'Could not preview this file. Try again.',
  'document.referenceUnavailable': 'This project reference could not be opened. Try again.',
  'sequence.parseFailed': 'We couldn’t read this sequence. Check the file format and try again.',
  'workspace.editorSaving':
    'An editor is still saving. Wait for it to finish before changing this project.',
  'workspace.editorUnsaved':
    'An editor has unsaved changes. Save or cancel them before changing this project.',

  'permissions.all': 'All permissions',
  'permissions.allScopes': 'All scopes',
  'permission.read-workspace.label': 'Read workspace',
  'permission.read-workspace.description': 'Read project files and state',
  'permission.write-workspace.label': 'Write workspace',
  'permission.write-workspace.description': 'Write files in this project',
  'permission.edit-primers.label': 'Edit primers',
  'permission.edit-primers.description': 'Save primers and edit their binding records',
  'permission.edit-protocols.label': 'Edit protocols',
  'permission.edit-protocols.description': 'Revise native protocol steps with reversible history',
  'permission.finalize-protocol.label': 'Finalize protocols',
  'permission.finalize-protocol.description':
    'Accept an exact reviewed protocol version as immutable',
  'permission.modify-tabs.label': 'Manage tabs',
  'permission.modify-tabs.description': 'Open and close canvas tabs',
  'permission.create-entity.label': 'Create entities',
  'permission.create-entity.description': 'Create references, designs, and imported entities',
  'permission.read-sequences.label': 'Read sequences',
  'permission.read-sequences.description': 'Read sequence content and annotations',
  'permission.edit-assembly.label': 'Edit assemblies',
  'permission.edit-assembly.description': 'Edit assembly workbench fields',
  'permission.finalize-assembly.label': 'Finalize assemblies',
  'permission.finalize-assembly.description':
    'Create accepted plasmid packages from validated assembly designs',
  'permission.modify-settings.label': 'Modify settings',
  'permission.modify-settings.description': 'Change supported DNAForge settings',
  'permission.submit-feedback.label': 'Send app feedback',
  'permission.submit-feedback.description':
    'Send bug reports and product feedback to the DNAForge team',
  'permission.manage-agent-access.label': 'Manage agent access',
  'permission.manage-agent-access.description':
    'Turn on or change the local web address other AI apps use to reach DNAForge',
  'permission.external-fetch:annotation.label': 'Fetch annotations',
  'permission.external-fetch:annotation.description':
    'Fetch annotation data from external providers',
  'permission.external-fetch:xref-resolution.label': 'Resolve biological IDs',
  'permission.external-fetch:xref-resolution.description':
    'Resolve external biological identifiers',
  'permission.external-fetch:structure.label': 'Fetch structures',
  'permission.external-fetch:structure.description': 'Fetch structure data from external providers',
  'permission.external-fetch:paper.label': 'Capture paper sources',
  'permission.external-fetch:paper.description':
    'Fetch bounded public PDF, HTML, text, or JATS paper sources',
  'permission.external-fetch:homology-search.label': 'Run homology searches',
  'permission.external-fetch:homology-search.description':
    'Send sequence queries to external homology providers',
  'permission.external-fetch:bulk-download.label': 'Download external datasets',
  'permission.external-fetch:bulk-download.description':
    'Download and cache large external datasets',
  'permission.external-compute:tm.label': 'Calculate primer Tm externally',
  'permission.external-compute:tm.description':
    'Send primer sequences to an external melting-temperature calculator',
  'permission.external-compute:discover.label': 'Browse connected compute providers',
  'permission.external-compute:discover.description':
    'List tools, read schemas, validate inputs, estimate cost, and read job status on compute providers the user connected',
  'permission.external-compute:submit.label': 'Submit compute jobs',
  'permission.external-compute:submit.description':
    "Submit jobs that send sequences to a connected compute provider and spend that account's budget",
  'permission.external-compute:manage.label': 'Stop compute jobs',
  'permission.external-compute:manage.description':
    'Cancel a running job on a connected compute provider. Spends nothing, and destroys work already in progress',
  'permissions.unknown': 'Other permission',
  'validation.compatible.01':
    'The file operation could not finish. Inspect File Trash before retrying; a move may have completed.',
  'validation.compatible.02': "Couldn't open that chat — try again.",
  'validation.compatible.03': "Chat deleted, but the replacement couldn't be saved — try again.",
  'validation.compatible.04': "Couldn't delete that chat — try again.",
  'validation.compatible.05':
    'Could not prepare the complete thread. Reopen the chat, then try again.',
  'validation.compatible.06': 'Could not copy. Check clipboard permission, then try again.',
  'validation.compatible.07':
    'Reopen this legacy result through its verified molecular document reference before editing or saving it.',
  'validation.compatible.08':
    'Installation outcome unknown. Refresh installed skills before trying again.',
  'validation.compatible.09': 'Some skill sources could not be loaded.',
  'validation.compatible.10': 'Available skills are unavailable.',
  'validation.compatible.11': 'Mutation details are unavailable. Re-run this alignment.',
  'validation.compatible.12': '1 MoClo kit definition could not be loaded.',
  'validation.compatible.13': 'Project parts could not be loaded.',
  'validation.compatible.14': 'Choose a project before finalizing.',
  'validation.compatible.15': 'Fill the empty parts before finalizing.',
  'validation.compatible.16': 'Review the parts and junctions above before finalizing.',
  'validation.compatible.17': 'Photo must be PNG, JPEG, or WebP.',
  'validation.compatible.18': 'Could not load cloud projects. Sign out and sign in again.',
  'validation.compatible.19': 'Cloud project opened but the local project record was not found.',
  'validation.compatible.20': 'This is not a Benchling HTML export.',
  'validation.compatible.21':
    'In Benchling, choose All Items and HTML, then select the downloaded ZIP.',
  'validation.compatible.22': 'This export could not be checked',
  'validation.compatible.23': 'Validation report unavailable',
  'validation.compatible.24': 'Some of your notebook did not come across',
  'validation.compatible.25': 'The kit changed. Read the current kit revision before saving.',
  'validation.compatible.26': 'Job status is unavailable.',
  'validation.compatible.27': 'Discard changes to this import plan?',
  'validation.compatible.28':
    'The record or evidence changed. Review the current information and choose again.',
  'validation.compatible.29':
    'This sequence is circular. Oligo classification requires a linear sequence.',
  'validation.compatible.30': 'This reference does not have a supported destination.',
  'validation.compatible.31': "Couldn't load this source.",
  'validation.compatible.32':
    'Saved substitutions overlap this candidate; identity and coverage were not recalculated.',
  'validation.compatible.33': 'Search index is unavailable for this reference.',
  'validation.compatible.34': 'DNAForge could not read this coordinate file.',
  'validation.compatible.35': 'Save or discard the affected document draft first.',
  'validation.compatible.36': 'Retry approved removal',
  'validation.compatible.37': 'The browser-safe workspace read is unavailable.',
  'validation.compatible.38': 'Review this skill again before installing it.',
  'validation.compatible.39': 'This command reads data and does not modify files.',
  'validation.compatible.40': 'DNAForge does not preview this original source format.',
  'validation.compatible.41': 'Schema changed elsewhere. Reopen it before saving.',
  'validation.compatible.42': 'The original My Project is unavailable on this device.',
  'validation.compatible.43': 'A project name cannot be empty.',
  'validation.compatible.44': 'Could not store avatar',
  'validation.compatible.45':
    'IDT documents adjacent DTPA series of 2 or 3; this is guidance, not a published hard maximum.',
  'validation.compatible.46':
    'IDT allows up to 3 Spacer 18 modifications between a terminal biotin and the oligo sequence.',
  'validation.compatible.47': 'IDT does not allow Yakima Yellow and TAMRA in the same oligo.',
  'validation.compatible.48':
    'IDT requires a 3′ blocking group on an adenylated oligo; use 3′ Spacer C3 or Dideoxy-C.',
  'validation.compatible.49': 'IDT allows at most 20 Affinity Plus bases in a DNA or RNA oligo.',
  'validation.compatible.50':
    'IDT allows at most 6 Affinity Plus bases in an Affinity Plus qPCR probe.',
  'validation.compatible.51': 'Unclosed IDT modification token.',
  'workspace.unsavedEdits': 'Save or discard unsaved sequence edits before editing the assembly.',
  'workspace.unsavedMetadata': 'Finish or cancel unsaved Metadata edits before continuing.',

  'validation.invalid': 'Check this value and try again.',
  'metadata.saveFailed': 'We couldn’t save this field. Try again.',
  'metadata.revisionsNeedDesktop': 'Sequence package revisions require the desktop app.',
  'primer.modification.check': 'Check the highlighted modification and its position.',
  'sequence.registrationFailed': 'We couldn’t register this sequence. Try again.',
  'remote.connectionFailed':
    'We couldn’t complete this remote connection action. Check the connection and try again.',
  'remote.hostTrustFailed':
    'OpenSSH rejected this host identity. Update the saved SSH host key in Terminal, then retry.',
  'remote.authenticationRequired':
    'Authenticate in your terminal using your institution’s supported login procedure, then reconnect. Use its SSH credentials or enable OpenSSH connection sharing to reuse a terminal login.',
  'remote.hostUnreachable':
    'OpenSSH could not reach the endpoint. Check the alias, VPN, network, and jump-host configuration.',
  'remote.pythonUnavailable':
    'The remote endpoint does not provide Python 3, which this streaming helper requires.',
  'remote.pythonMissingOnHost': 'Python 3 is not available on this host.',
  'remote.portInUse':
    'A port needed by this SSH connection is already in use. Retry the connection.',
  'remote.tunnelFailed':
    'OpenSSH could not establish the private loopback tunnel. Check endpoint forwarding policy and retry.',
  'remote.localForwardFailed': 'SSH connected, but local port forwarding did not work.',
  'remote.connectionClosed': 'The SSH connection closed during the test.',
  'remote.explorerUnavailable':
    'SSH connected, but DNAForge could not reach the remote explorer. Check that SSH TCP forwarding is allowed.',
  'remote.directoryUnresponsive':
    'The remote directory did not respond. Retry, or check host access in Remote hosts.',
  'remote.browserCloseFailed': 'Could not close the file browser. Try again.',
  'remote.connectionRenameFailed': 'The connection name could not be saved. Try again.',
  'remote.connectionForgetFailed': 'The recent connection could not be forgotten. Try again.',
  'remote.helperFailed': 'The remote DNAForge streaming helper exited before it became ready.',
  'genome.searchUnavailable': 'Search index is unavailable for this reference.',

  'sync.unavailable': 'Sync is temporarily unavailable. Try again.',
  'sync.saveFailed': 'Could not save your changes. Try again.',
  'sync.retryPending': 'Sync will retry shortly.',
  'identity.user': 'User',
  'identity.agent': 'Assistant',
  'identity.service': 'Service',
  'jobs.owner.web': 'DNAForge web app',
  'jobs.owner.local': 'This computer',
  'jobs.action.unknown': 'Job action',
  'jobs.action.import': 'Import recorded',
  'jobs.action.release': 'Release result',
  'jobs.action.start': 'Start',
  'jobs.action.stop': 'Stop',
  'jobs.outcome.imported': 'Imported',
  'jobs.outcome.released': 'Released',
  'jobs.outcome.updated': 'Updated',
  'dialog.unsavedNotResponding':
    "The window isn't responding, so these changes can't be saved right now. Available recovery copies are kept. DNAForge offers retained recovery when those documents are reopened.",

  'assistant.approval.command': 'The assistant wants to run a command',
  'assistant.approval.file': 'The assistant wants to change files',
  'assistant.approval.permission': 'The assistant wants additional access',
  'assistant.approval.detail': 'Review this request before allowing it.',
  'assistant.approval.rule': 'this assistant action',
  'assistant.approval.codexCommand': 'Codex wants to run a command',
  'assistant.approval.codexFiles': 'Codex wants to change files',
  'assistant.approval.codexNetwork': 'Codex wants network access',
  'assistant.approval.codexFileAccess': 'Codex wants file system access',
  'assistant.approval.codexNetworkFiles': 'Codex wants network and file system access',
  'assistant.approval.codexMore': 'Codex wants more access',
  'assistant.approval.grokTool': 'Grok wants to use a tool',

  'registry.importFailed': 'We couldn’t import these items. Check the source and try again.',
  'registry.refreshFailed':
    'Your items were saved, but the registry could not refresh. Refresh the list.',
  'registry.provenanceFailed':
    'Your items were saved, but the spreadsheet link could not be recorded.',
  'project.operationUnconfirmed':
    'We couldn’t confirm this project change. Refresh before trying again.',

  'assistant.trace.error': 'Assistant action failed',
  'assistant.trace.permissionDenied': 'Action not allowed',
  'assistant.trace.permissionDetail':
    'The assistant does not have permission to perform this action.',
  'assistant.trace.notification': 'Assistant update',
  'assistant.trace.message': 'Assistant',
  'assistant.trace.reasoning': 'Reasoning',
  'assistant.trace.command': 'Command',
  'assistant.trace.fileChange': 'File changes',
  'assistant.trace.plan': 'Plan',
  'assistant.trace.search': 'Web search',
  'assistant.trace.completed': 'Completed',
  'assistant.trace.running': 'In progress',
  'assistant.trace.requested': 'Waiting',
  'assistant.trace.modified': 'Modified',
  'assistant.trace.failed': 'Failed',
  'assistant.trace.statusUnavailable': 'Status unavailable',
  'assistant.trace.activityUnavailable':
    'Some assistant activity details could not be loaded. The action may have completed; check its result before trying again.',

  'assistant.notice': 'The assistant has an update. Open the conversation to continue.',
  'project.recoveryNeeded': 'Choose your original project to restore its saved files.',
  'startup.databaseFailed':
    'DNAForge could not open your local data. Restart the app. If this continues, contact support before changing any files.',
  'startup.reinstall':
    'DNAForge could not open. Reinstall the latest version from dnaforge.com/download, then try again. Your projects are preserved.',
  'sharing.openFailed': 'We couldn’t open this shared project. Try again.',
  'sharing.openedWithWarnings':
    'The project opened, but some items need attention. Check the project before continuing.',
  'recovery.failed':
    'We couldn’t finish this recovery action. Your existing files have been preserved. Contact support before changing them.',
  'assistant.needsLogin': 'Needs login',
  'assistant.installCli': 'Install CLI',
  'assistant.editorHost': 'Editor agent host',
  'reference.preparedOpenFailed': 'The reference was prepared but could not be opened.',
  'reference.assemblyInput': 'Paste an assembly link or a reference assembly accession.',
  'reference.dropInput': 'Drop one FASTA file, one NCBI Datasets ZIP, or one reference folder.',
  'reference.dropUnavailable':
    'We couldn’t open that dropped source. Try choosing it with the file picker.',
  'reference.openedWithWarnings':
    'The genome view opened, but some tracks could not be restored. Check the tracks before continuing.',
  'document.saveRefreshPending':
    'Your changes were saved, but the project refresh is pending. Retry to finish the save.',
  'document.sequenceSaveDeliveryPending':
    'This Save was accepted; file delivery remains pending. Keep this draft open and try Save again after resolving the file change.',
  'document.sequenceSaveSuperseded':
    'This Save was accepted, but a newer version is now current. Check the current version before saving again.',
  'document.saveUnconfirmed':
    'The save could not be confirmed. Your draft is still here. Retry the same change or reload the saved record.',
  'protein.registrationPending':
    'Your protein file was saved, but its registry entry could not be updated. Retry registration.',
  'alignment.invalidInterval': 'This change has no valid reference interval.',
  'alignment.referenceChanged':
    'The reference sequence no longer matches this change. Re-run the alignment first.',
  'alignment.noCompleteCodon': 'This change does not map to a complete coding codon.',
  'alignment.multipleCodingFeatures':
    'This change overlaps more than one coding feature. Open the intended protein from its coding annotation.',
  'alignment.undefinedStrand': 'The coding feature has no defined strand.',
  'alignment.unjoinedProtein':
    'The order of these coding segments does not define a joined protein.',
  'alignment.translationUnavailable': 'This coding feature has no resolvable protein translation.',
  'alignment.indelBoundary':
    'This indel crosses a coding boundary or untranslated gap. Its protein consequence needs a transcript-aware alignment.',
  'alignment.translationMismatch':
    'The protein translation and current coding DNA disagree. Resolve the coding annotation before mapping this change.',
  'alignment.noProteinResidue':
    'This change maps to a stop or incomplete codon, not a reference protein residue.',
  'alignment.codonUntranslatable':
    'The changed codon could not be translated with this coding annotation.',
  'alignment.selectCloneAndMutation': 'Select a clone and mutation to inspect its protein.',
  'alignment.staleProteinMapping':
    'Re-run this alignment before mapping changes to the current protein.',
  'alignment.groupedProteinMapping':
    'Grouped changes need a protein-alignment mapping. Select an individual substitution to inspect its reference protein.',
  'alignment.measurementChanged':
    'The selected protein or measurement changed. Select the evidence again.',
  'alignment.countsChanged': 'The source analysis no longer matches these saved counts.',
  'benchling.invalidExport':
    'This is not a Benchling HTML export. In Benchling, choose All Items and HTML, then select the downloaded ZIP.',
  'benchling.failed': 'The export could not be imported. Check the selected files and try again.',
  'benchling.linkedItemsFailed':
    'DNAForge could not add those linked-item exports. Check the ZIP files or folders and try again.',
  'benchling.checkFailed':
    'The export could not be checked safely. Check the selected files and try again.',
  'benchling.openFailed': 'The imported notebook could not be opened. Try opening it again.',
  'record.changedWhileEditing':
    'The saved record changed while you were editing. Review its current version before saving.',
  'record.schemaWrongType': 'Choose a schema for this data type.',
  'record.saveBeforeClosing':
    'The changes are saved, but this save still needs completion. Retry it before closing.',
  'record.confirmBeforeClosing':
    'The save is not confirmed. Retry the same change or reload the saved record before closing.',
  'record.finishBeforeClosing': 'Update the entity or discard your changes before closing.',
  'record.previousSaveUnconfirmed':
    'The previous save is not confirmed. Retry the same change or reload the saved record.',
  'record.finishSavedChanges': 'Finish the saved changes before this action.',
  'record.finishBeforeAction': 'Update the entity or discard your changes before this action.',
  'record.finishNameDraft':
    'Finish saving the name or cancel its draft before updating the entity.',
  'record.readOnly': 'This record cannot be edited here. Open its saved source to review it.',
  'record.validationFailed': 'Check the record fields before saving.',
  'recovery.projectRequired':
    'Choose an active project folder from the list of projects with recovery checkpoints.',
  'recovery.dataChanged':
    'The active project data changed. Open Scientific Storage Recovery again.',
  'recovery.ownerChanged':
    'The selected project owner changed. Open Scientific Storage Recovery again.',
  'recovery.checkpointUnavailable':
    'This project no longer has the required recovery checkpoint. Open Scientific Storage Recovery again.',
  'recovery.ambiguousProject':
    'The selected folder belongs to more than one project. Choose an unambiguous project folder.',
  'legacySource.changed':
    'The legacy migration destination changed. Open its current index entry again.',
  'legacySource.multipleRecords':
    'This source contains multiple records. Open its index entry to choose one record.',
  'attachments.guard.the-current-package-is-not-ready-for-an-attachment-change-save-refresh-and-select-current':
    'The current package is not ready for an attachment change. Save, refresh, and select Current.',
  'attachments.guard.this-attachment-has-no-verified-current-bytes-it-cannot-be-replaced-or-detached-here':
    'This attachment has no verified current bytes; it cannot be replaced or detached here.',
  'attachments.guard.the-selected-attachment-has-no-file-name':
    'The selected attachment has no file name.',
  'attachments.guard.the-package-view-changed-while-preparing-this-attachment-preview-again':
    'The package view changed while preparing this attachment. Preview again.',
  'attachments.guard.the-package-changed-while-preparing-this-attachment-refresh-and-preview-again':
    'The package changed while preparing this attachment. Refresh and preview again.',
  'attachments.guard.unfinished-edits-or-a-historical-view-now-block-the-attachment-change':
    'Unfinished edits or a historical view now block the attachment change.',
  'attachments.guard.the-history-view-changed-preview-the-attachment-again':
    'The History view changed. Preview the attachment again.',
  'attachments.guard.the-package-changed-after-preview-refresh-and-preview-again':
    'The package changed after preview. Refresh and preview again.',
  'attachments.guard.the-chosen-file-changed-after-preview-choose-it-again':
    'The chosen file changed after preview. Choose it again.',
  'attachments.guard.save-or-discard-unfinished-package-edits-before-changing-attachments':
    'Save or discard unfinished package edits before changing attachments.',
  'attachments.guard.this-package-needs-controlled-migration-before-attachments-can-change':
    'This package needs controlled migration before attachments can change.',
  'attachments.guard.the-package-changed-since-history-loaded-refresh-it-and-preview-again':
    'The package changed since History loaded. Refresh it and preview again.',
  'attachments.guard.the-current-product-is-not-the-verified-saved-version':
    'The current product is not the verified saved version.',
  'attachments.guard.the-package-changed-while-it-was-being-checked-preview-again':
    'The package changed while it was being checked. Preview again.',
  'registry.duplicateRowKey':
    'Spreadsheet row key is duplicated. Give each row a unique key before connecting.',
  'registry.organizationHomeRequired':
    'Registration requires an existing organization home project for this account. Set up its project through the project sharing controls first.',
  'registry.undoChanged':
    'This import cannot be undone because an imported record changed. Your records have been preserved.',
  'compute.unknown_provider': 'DNAForge does not know this provider.',
  'compute.capability_denied': 'This session is not allowed to use compute providers.',
  'compute.sidecar_unavailable':
    'The DNAForge background service is not running yet. Try again in a few seconds.',
  'compute.keychain_unavailable':
    'Encrypted storage is unavailable on this system, so the key cannot be saved.',
  'source.verified': 'Verified against the original export.',
  'source.previewTruncated':
    'Preview truncated. The original export and complete entry remain unchanged.',
  'structure.predictionNotice': 'Review this prediction before using it.',
  'sharing.syncRequired':
    'Sync your saved changes before sharing. The server does not yet have your current draft.',
  'sharing.signInRequired': 'Sign in to the displayed account before sharing.',
  'registry.availability.not_on_device': 'No saved copy is available on this device.',
  'registry.availability.home_mismatch':
    'The saved record and its home project no longer agree. Refresh the record.',
  'registry.availability.project_unavailable':
    'Open the saved record’s project on this device before opening the record.',
  'registry.availability.no_saved_document': 'This record has no saved document to open.',
  'registry.availability.source_unavailable':
    'The saved source could not be opened. Refresh the record and try again.',
  'annotation.connecting': 'Connecting to job service…',
  'annotation.unavailable': 'The job service is unavailable. Check Jobs before starting a run.',
  'annotation.unsupported':
    'Starting annotation jobs is not available. Check Jobs for existing results.',
  'annotation.historyUnavailable':
    'This run is not in the connected job history. Check Jobs before starting another run.',
  'annotation.resultMismatch':
    'The returned result belongs to a different job. Check Jobs before applying it.',
  'annotation.resultUnavailable':
    'This result is no longer available. Check Jobs for its retained output.',
  'annotation.invalidResult':
    'The annotation result could not be read. Check Jobs before trying again.',
  'annotation.canceled': 'Annotation was canceled.',
  'annotation.interrupted': 'Annotation was interrupted. Check Jobs before trying again.',
  'annotation.reviewApplied': 'This result has already been applied.',
  'annotation.reviewDismissed': 'This result was dismissed.',
  'primer.scopeIntervalRequired': 'Enter an interval like chr1:1,000-2,000.',
  'primer.scopeOrderInvalid': 'The interval start must be at least 1 and not after its end.',
  'primer.scopeSelectionRequired': 'Select a region on the map first.',
  'primer.scopeTooWide': 'Zoom in, select a region, or enter an interval to search.',
  'link.invalid': 'Invalid DNAForge entity link. Check its target and try again.',
  'assembly.outsideProject':
    'This assembly is outside its owning project. Choose a folder in that project before saving.',
  'link.refusal.the-reference-did-not-reach-its-intended-document-check-its-target-and-try-again':
    'The reference did not reach its intended document. Check its target and try again.',
  'link.refusal.the-reference-has-no-available-target-check-its-project-and-try-again':
    'The reference has no available target. Check its project and try again.',
  'link.refusal.this-reference-does-not-have-a-supported-destination':
    'This reference does not have a supported destination.',
  'link.refusal.this-reference-is-not-valid-check-its-target-and-try-again':
    'This reference is not valid. Check its target and try again.',
  'link.refusal.project-reference-unavailable-check-its-project-and-try-again':
    'Project reference unavailable. Check its project and try again.',
  'assembly.finding.the-saved-assembly-is-read-only': 'The saved assembly is read-only.',
  'assembly.finding.restriction-digest-physical-ends-use-method-specific-resection-fields':
    'Restriction-digest physical ends use method-specific resection fields.',
  'assembly.finding.editing-outside-the-copied-region-requires-source-context-for-this-template':
    'Editing outside the copied region requires source context for this template.',
  'assembly.finding.compute-homology-regions-and-primers-before-editing-junction-details':
    'Compute homology regions and primers before editing junction details.',
  'assembly.finding.compute-golden-gate-overhangs-and-primers-before-editing-offsets':
    'Compute Golden Gate overhangs and primers before editing offsets.',
  'tracks.cannotAdd': 'This track cannot be added in this view. Choose another track.',
  'readDetails.notFound': 'This read could not be found. Reload the track and choose it again.',
  'readDetails.failed': 'Could not load the read details. Reload the track and try again.',
  'readDetails.sourceUnavailable': 'The alignment source for this read is unavailable.',
  'readDetails.invalidQualities':
    'The read has invalid base qualities. Reload the track before using these qualities.',
  'assembly.armConstrained': 'Homology arm is constrained by the junction source.',
  'operation.failed': 'We couldn’t complete that action. Try again.',
  'pdf.loadFailed':
    'This PDF could not be loaded. Your page, zoom and selected evidence are kept for retry.',
  'pdf.pageFailed': 'The PDF page could not be loaded.',
  'pdf.canvasFailed': 'The PDF page could not be painted.',
  'pdf.textFailed': 'The PDF text layer could not be rendered.',
  'service.unavailable': 'We couldn’t connect to the service. Try again in a moment.',
  'tracks.unavailable': 'Saved genome views are not available in the web app yet.',
  'tracks.loadFailed': 'We couldn’t load genome tracks. Try again.',
  'tracks.statusHidden': 'Hidden',
  'tracks.statusLoading': 'Loading…',
  'variant.sourceChanged':
    'The variant source changed. Remove it and add the current source again.',
  'variant.assemblyMismatch':
    'The call file does not match this reference. Choose a matching call file or reference.',
  'variant.preparationCanceled': 'Variant source preparation was canceled.',
  'variant.preparationInterrupted': 'Variant source preparation was interrupted. Try again.',
  'variant.preparationFailed':
    'The variant source could not be prepared. Choose it again or try another file.',
  'variant.queryFailed': 'Could not read the variants. Try again or choose another file.',
  'jobs.resultReleased': 'The retained result was released. Execution history remains.',
  'jobs.statusStale': 'This job has not reported its status recently. Refresh Jobs to check it.',
  'jobs.interrupted': 'This job was interrupted. Review its saved result before retrying.',
  'jobs.reviewPending': 'Result is awaiting review',
  'jobs.reviewInProgress': 'Result review is in progress',
  'jobs.reviewBlocked': 'Result review is blocked',
  'jobs.reviewAnnotations': 'Choose annotations to apply',
  'jobs.retentionEnded': 'Retention period ended',
  'jobs.resultUnavailable': 'The job result is unavailable.',
  'assistant.trace.planMode': 'Plan mode',
  'assistant.trace.entered': 'Entered',
  'assistant.trace.awaitingDecision': 'Awaiting decision',
  'assembly.schemaId': 'Schema ID is required.',
  'assembly.schemaName': 'Schema name is required.',
  'assembly.schemaRevision': 'Schema revision must be a positive integer.',
  'assembly.schemaSlots': 'Schema must contain at least one slot.',
  'assembly.linearJunction': 'The final slot in a linear schema cannot own a closing junction.',
  'assembly.kitDescription': 'The kit needs a description.',
  'assembly.kitNameCharacters': 'The kit name needs at least one letter or number.',
  'assembly.layoutName': 'Every layout needs a name.',
  'assembly.layoutDuplicate': 'Two layouts share an identifier. Rename one layout.',
  'workspace.updateInProgress':
    'A project update is in progress. Your changes have not been saved yet.',
  'protein.destinationOutsideProject': 'Protein sequences must be saved inside the owning project.',
  'protein.nativeDnaSource':
    'This FASTA source is not available in the protein view. Open its current native destination.',
  'molecular.projectRequired':
    'Open a writable project before saving. Your result remains in chat.',
  'molecular.destinationRequired':
    'Select a folder in the project where this molecular document should be saved.',
  'molecular.documentUnlinked':
    'This older result is not linked to a saved molecular document. Reopen it from its original document.',
  'annotation.openSequence': 'Open the sequence before reviewing this result.',
  'annotation.unsavedEdits': 'Commit or discard your sequence edits before applying annotations.',
  'annotation.changedDuringReview':
    'The sequence changed during review. Check the current revision before applying.',
  'annotation.revisionChanged':
    'The sequence differs from the analyzed revision. These results are retained, but cannot be applied at unverified coordinates.',
  'structure.unsupportedCoordinates':
    'This file does not contain supported molecular coordinates. Open it as text to inspect it.',
  'source.originalUnavailable': 'The original source is unavailable.',
  'source.originalChanged': 'The original source changed after it was imported.',
  'source.originalUnverified': 'The original source could not be verified.',
  'sequence.isoformIncomplete':
    'The feature closure is incomplete, so alternative isoforms cannot be listed.',
  'import.label.unsupported-format': 'Unsupported format',
  'import.label.unsupported-source-kind': 'Select sequence files',
  'import.label.read-failure': 'File cannot be read',
  'import.label.parse-failure': 'File could not be parsed',
  'import.label.unconfirmed-molecule-identity': 'Molecule type unspecified',
  'import.label.non-dna-content': 'Not a DNA sequence',
  'import.label.lossless-conversion-blocked': 'Conversion would discard data',
  'import.label.source-too-large': 'File exceeds the import limit',
  'import.label.automatic-split-required': 'Review before splitting',
  'import.label.record-name-conflict': 'Duplicate record names',
  'import.label.multipleRecords': 'Multiple sequences — use DNA import',
  'import.nothing': 'Nothing to import',
  'import.chooseDestination': 'Choose a destination',
  'import.selectAtLeastOneFile': 'Select at least one file',
  'import.nothingImportable': 'Nothing importable',
  'import.alreadyImported':
    'These files are already imported. Choose Import anyway to add another copy.',
  'import.resolveCollision': 'Resolve the name conflict',
  'import.unsupportedFormat': 'This file format cannot be imported as a DNA sequence.',
  'import.unsupportedSource': 'Select individual sequence files from this folder.',
  'import.readFailed': 'The file could not be read. Check that it is still available and readable.',
  'import.parseFailed': 'The file could not be parsed as a supported sequence.',
  'import.identityUnconfirmed':
    'The molecule identity is ambiguous. Confirm that this sequence contains DNA.',
  'import.notDna': 'This source contains protein or RNA rather than DNA.',
  'import.losslessBlocked': 'This file cannot be converted without losing sequence data.',
  'import.tooLarge': 'This file exceeds the import limit. Export smaller sequence files.',
  'import.automaticSplitRequired':
    'Review this file before splitting its records into separate sequences.',
  'import.recordNames': 'The records have duplicate names. Give each record a distinct name.',
  'importResult.nothingImported': "Couldn't import these files",
  'import.multipleRecords':
    'This FASTA contains multiple records. Import the records as separate DNA sequences.',
  'assistant.modelsUnavailable':
    'Models are unavailable for this account. Retry model discovery in the chat controls before sending.',
  'assistant.routeNotReady':
    'The selected assistant is not configured or ready. Configure it before sending.',
  'assistant.routeUnavailable':
    'No assistant is available here. Choose another assistant or try again later.',
  'primer.saturationTemplate':
    'The template must contain only A, C, G and T. Resolve ambiguous bases first.',
  'primer.saturationCoordinates':
    'Coordinates, residue numbers and flank length must be whole numbers.',
  'primer.saturationCds': 'Choose a CDS within the template whose length is a multiple of three.',
  'primer.saturationResidues': 'Choose a residue interval within the CDS, numbered from one.',
  'primer.saturationLimit': 'Design at most 10,000 residues in one library.',
  'primer.saturationFlanks': 'Choose 15 to 50 matching bases on each side of the degenerate codon.',
  'remote.connectionClosing': 'Closing the DNAForge connection…',
  'remote.connectionEnded': 'DNAForge connection closed. Your saved host and tracks are kept.',
  'remote.terminalOpening': 'Opening Terminal…',
  'remote.terminalRequested':
    'Terminal requested. Continue there, then use Check access. If no window is visible, select Terminal from your Dock or taskbar.',
  'remote.accessChecking': 'Checking SSH access…',
  'remote.accessChecked': 'Access check passed. Your SSH connection can run remote commands.',
  'remote.signInThenCheck': 'Finish signing in through Terminal, then check access again.',
  'remote.signInToEstablish':
    'Sign in through Terminal to establish a reusable SSH connection, then check access.',
  'remote.terminalLoginUnverified':
    'The terminal login has not been verified. Finish the institution’s procedure in Terminal and check access, or cancel and sign in again.',
  'remote.terminalLoginNotStarted':
    'DNAForge has not seen Terminal start the login. Check Terminal for any message, then try signing in again.',
  'remote.remoteCommandFailed':
    'The SSH connection is present, but the host did not complete a remote command. Check the host’s supported procedures in Terminal. File and compute access were not tested.',
  'remote.accessUnverified':
    'SSH access could not be verified. Check the institution’s login in Terminal, then sign in again. File and compute access were not tested.',
  'assistant.hostedUnavailable': 'DNAForge AI is unavailable right now. Please try again shortly.',
  'assistant.connectionInterrupted':
    'The assistant connection was interrupted. Check the conversation before trying again.',
  'assistant.hostedAppServerCrash':
    'DNAForge AI stopped unexpectedly. Your work is saved. Please try again.',
  'assistant.hostedRendererTeardown':
    'DNAForge AI was interrupted before it finished. Please try again.',
  'assistant.hostedAppRestart': 'DNAForge restarted while AI was working. Your work is saved.',
  'assistant.hostedStopped':
    'You stopped this response. Anything written before you stopped is kept.',
  'assistant.hostedRateLimited':
    'DNAForge AI is temporarily rate limited. Please retry in a moment.',
  'assistant.hostedAllowanceExhausted': 'This account has used its current DNAForge AI allowance.',
  'assistant.hostedContextTooLarge':
    'This request contains more conversation or project context than DNAForge AI can process. Start a new chat or reduce the request.',
  'assistant.hostedRequestTooLarge':
    'This response accumulated more context than DNAForge AI can send safely. Start a new chat or narrow the request.',
  'assistant.hostedTurnBudgetExhausted':
    'This response reached its safety limit for model steps or tool calls. Narrow the request before trying again.',
  'assistant.hostedServiceOverloaded':
    'The AI service is overloaded right now. Wait a moment, then retry this message.',
  'assistant.hostedPolicyBlocked':
    'The AI service declined this request because of a service policy. Reword the request or contact support if this seems wrong.',
  'assistant.hostedConnectionFailed':
    'The connection to the AI service ended before the response finished. Your project changes and partial response are kept.',
  'assistant.hostedAuthenticationFailed':
    'DNAForge could not authenticate this AI request. Sign out and sign in again before retrying.',
  'assistant.hostedLegalAcceptanceRequired':
    'Review the current Terms and Privacy Policy, then sign out and sign in again to use DNAForge AI. Your prompt has not been sent.',
  'assistant.hostedContributionPolicyChanged':
    'The Research Contribution policy changed while the choice was open. Review it again before making your choice. No AI request was started.',
  'assistant.hostedContributionChoiceRejected':
    'Your Research Contribution choice could not be saved. Your prompt has not been sent. Report the reference ID to support.',
  'assistant.hostedInvalidRequest':
    'DNAForge AI rejected the request format. Your project was not changed. Report the reference ID to support.',
  'assistant.hostedResponseContractFailed':
    'DNAForge AI received a response format it could not safely continue. Your project was not changed. Report the reference ID to support.',
  'assistant.hostedCompletionUngrounded':
    'DNAForge AI stopped before it completed and verified the requested app action. Any project changes shown above are kept. Please retry.',
  'assistant.hostedLocalToolFailed':
    'A local DNAForge project tool failed before the AI response could finish. Review any tool result shown above, then retry if it is safe.',
  'assistant.hostedTurnStateFailed':
    'DNAForge AI could not restore this chat after the failed response. Anything already shown or saved is kept. Start a new chat before trying again.',
  'assistant.hostedApprovalDeclined': 'That change was not approved, so nothing was modified.',
  'assistant.hostedReconciliationRequired':
    'DNAForge AI could not confirm whether that change was applied, so it stopped instead of guessing. Check the affected item before retrying.',
  'assistant.hostedProviderExposureReconciliationRequired':
    'DNAForge AI cannot start a new request because earlier provider charges are still being reconciled. Retrying will not help yet. Report the reference ID to support.',
  'settings.notAvailableYet': 'Not available yet',
  'settings.unavailableHere': 'Unavailable in this window',
  'settings.managedByOrganization': 'Managed by your organization',
  'recovery.fileVerificationFailed': 'The recovery file did not match its saved size and digest.',
  'recovery.expired': 'This recovery capture has expired.',
  'recovery.accountUnavailable':
    'This recovery capture is no longer available to the active account.',
  'assistant.unavailable': 'DNAForge AI is unavailable here. Choose another assistant.',
  'assistant.contributionRequired':
    'DNAForge AI needs your contribution choice. Choose Join in Settings → AI → Hosted AI, or pick another model to send this message.',
  'assistant.contributionCheckFailed':
    'We couldn’t check your contribution choice. Review it in Settings and try again.',
  'assistant.contributionSaveFailed':
    'Your contribution choice could not be saved. Try again before sending.',
  'assistant.legalReviewRequired':
    'Review the required terms in Settings before using DNAForge AI.',
  'assistant.turnBindingFailed':
    'DNAForge AI could not start this conversation. Sign in again and retry.',
  'assistant.queuedRouteMissing':
    'Queued message has no validated assistant route. Submit it again.',
  'assistant.host.cli': 'Command-line agent host',
  'assistant.host.provider': 'Configured provider model',
  'assistant.host.everyday': 'Everyday AI workflow',
  'assistant.host.deep': 'Harder AI workflow',
  'assistant.source.custom': 'Custom harness',
  'assistant.source.local': 'Local CLI login',
  'assistant.source.hosted': 'DNAForge-hosted',
  'assistant.tools.appSupervised': 'DNAForge-only tools',
  'assistant.tools.native': 'Local CLI tools',
  'assistant.route.deep': 'Deep',
  'assistant.route.auto': 'Auto',
  'assistant.directApi': 'Direct API',
  'assistant.provider': 'AI provider',
  'sync.legacyDataKept':
    'This older snapshot contains registry records. Its files were preserved, but the records were not imported because the snapshot did not record which project owned them.',
  'sync.backupNotStarted':
    'The cloud project opened, but automatic backup could not start. Restart DNAForge or turn cloud backup off and on to retry.',
  'sync.repositoryRebuilt':
    'The missing repository was rebuilt from your retained accepted scientific history. Local history and cloud conflict state are preserved.',
  'sync.storageLimitReached': 'Your cloud storage limit has been reached.',
  'sync.cloudUnreachable': 'Could not reach cloud backup.',
  'sync.backupPaused': 'Cloud backup is paused right now.',
  'sharing.invitationUnconfirmed': 'Could not confirm the invitation. Refresh before trying again.',
  'sharing.accessUnconfirmed': 'Could not confirm the access change. Refresh before trying again.',
  'sharing.revokeUnconfirmed':
    'Could not confirm that the invitation was revoked. Refresh before trying again.',
  'sharing.resendUnconfirmed':
    'Could not confirm that the invitation was resent. Refresh before trying again.',
  'tracks.localSourceUnavailable':
    'The local track file is missing or unavailable. Locate it or add the file again.',
  'tracks.relinkFailed':
    'This file could not be used for the track. Check that it is the same type and belongs to the same reference. The existing track is preserved.',
  'sequenceSearch.noAnnotations':
    'AA and feature search is unavailable because this reference has no annotations.',
  'sequenceSearch.annotationsPending':
    'AA and feature search becomes available after annotation indexes are prepared.',
  'sequenceSearch.invalidPattern': 'Invalid pattern',
  'sequenceSearch.tooManyMatches': 'Too many matches',
  'reference.locationUnsafe':
    'DNAForge blocked this reference because its saved location is unsafe.',
  'reference.originConflict':
    'DNAForge blocked this reference because its saved location changed unexpectedly.',
  'startup.failed': 'DNAForge could not open. Restart the app to try again.',
  'startup.hostedPlatformFailed': 'The web app could not open your project. Reload to try again.',
  'project.untitled': 'Untitled project',
  'document.untitled': 'Untitled file',
  'document.untitledSequence': 'Untitled sequence',
  'file.moveDestinationExists': 'An item with that name already exists in that folder.',
  'document.quickLookTooLarge': 'The file is too large for Quick Look.',
  'document.openFailed': 'We couldn’t open this file. Try again.',
  'document.saveFailed': 'We couldn’t save your changes. Keep this file open and try again.',
  'document.renderFailed': 'We couldn’t display this sequence. Try opening it again.',
  'hosted.unavailable': 'This action is not available in the web app yet.',
  'hosted.localFilesUnavailable': 'Open the desktop app to use files on your computer.',
  'hosted.agentUnavailable': 'This assistant feature is available in the desktop app.',
  'hosted.signUpRequired': 'Sign up to use this feature.',
  'failure.failed-to-open-project': 'Failed to open project',
  'failure.failed-to-create-dna-sequence': 'Failed to create DNA sequence.',
  'failure.restart-failed': 'Restart failed',
  'failure.could-not-open-protein-run-comparison': 'Could not open protein run comparison.',
  'failure.copy-accepted':
    'We couldn’t finish copying the file. Check the destination before trying again.',
  'assistant.failed': 'The assistant could not complete that action. Try again.',
  'failure.could-not-target-this-reference': 'Could not target this reference.',
  'failure.could-not-open-this-reference': 'Could not open this reference.',
  'failure.file-attachments-currently-require-a-local-cli-agent-route-choose-clau':
    'To attach files, choose Claude Code, Codex or Grok before sending your message.',
  'failure.attachments-must-be-4-mib-or-smaller-in-total':
    'Attachments must be 4 MiB or smaller in total.',
  'structure.failed': 'We couldn’t display this structure. Try opening it again.',
  'failure.failed-to-read-file': 'Failed to read file',
  'failure.could-not-save-api-key': 'Could not save API key.',
  'failure.could-not-save-the-endpoint': 'Could not save the endpoint.',
  'failure.failed-to-load-table-file': 'Failed to load table file',
  'failure.failed-to-save-table-file': 'Failed to save table file',
  'failure.preserved-source-verification-failed': 'Preserved source verification failed.',
  'failure.failed-to-load-file': 'Failed to load file',
  'failure.failed-to-save-file': 'Failed to save file',
  'failure.that-key-didn-t-work-double-check-it-and-try-again':
    'That key didn’t work — double-check it and try again.',
  'failure.could-not-connect': 'Could not connect.',
  'failure.sign-in-did-not-complete-try-again': 'Sign-in did not complete. Try again.',
  'failure.enter-a-key-to-connect': 'Enter a key to connect.',
  'failure.could-not-restore-this-view': 'Could not restore this view.',
  'failure.entity-search-could-not-load': 'Entity search could not load.',
  'failure.the-entity-link-could-not-be-saved': 'The entity link could not be saved.',
  'failure.the-linked-entity-could-not-be-opened': 'The linked entity could not be opened.',
  'failure.unknown-error': 'We couldn’t complete that action. Try again.',
  'failure.failed-to-materialize-internal-fixture-library':
    'We couldn’t prepare the example library. Try again.',
  'failure.failed-to-load-cached-internal-fixture-graph':
    'We couldn’t open the example assembly graph. Try again.',
  'failure.failed-to-save-graph': 'Failed to save graph',
  'failure.failed-to-load-graph': 'Failed to load graph',
  'failure.the-legacy-adjacency-heuristic-only-accepts-genbank-sequence-files':
    'Choose a GenBank sequence file for this assembly graph.',
  'assembly.exportDraftChanged':
    'The assembly changed since its last draft. Click Update draft, review the result, then Finalize again.',
  'assembly.exportOutputExists':
    'An assembly output already exists here. Choose another save folder or create a new folder, then Finalize again.',
  'assembly.failed': 'We couldn’t complete this assembly action. Check your inputs and try again.',
  'assembly.projectionFailed':
    'The plasmid package was written, but its workspace records could not be rebuilt. Finalize again to finish.',
  'failure.could-not-load-skill-sources': 'Could not load skill sources.',
  'failure.could-not-load-some-skills': 'Could not load some skills.',
  'failure.could-not-load-this-skill-source': 'Could not load this skill source.',
  'failure.the-agent-extension-change-failed': 'The agent extension change failed.',
  'failure.could-not-import-the-skill-folder': 'Could not import the skill folder.',
  'failure.could-not-load-the-complete-skill': 'Could not load the complete skill.',
  'failure.could-not-read-the-complete-skill': 'Could not read the complete skill.',
  'failure.the-installation-outcome-could-not-be-read':
    'The installation outcome could not be read.',
  'failure.could-not-load-scheduled-tasks': 'Could not load scheduled tasks.',
  'failure.could-not-cancel-the-scheduled-task': 'Could not cancel the scheduled task.',
  'failure.could-not-save-this-harness': 'We couldn’t save these assistant settings. Try again.',
  'failure.could-not-update-this-harness':
    'We couldn’t update these assistant settings. Try again.',
  'failure.failed-to-load-agent-access': 'Failed to load agent access',
  'failure.failed-to-load-more-agent-access': 'Failed to load more agent access',
  'failure.failed-to-revoke-grant': 'Failed to revoke grant',
  'failure.failed-to-create-external-access-key': 'Failed to create external access key',
  'failure.choose-an-absolute-executable-path': 'Choose an absolute executable path.',
  'failure.the-always-allowed-list-is-unavailable': 'The always-allowed list is unavailable.',
  'failure.dnaforge-agent-could-not-be-selected': 'DNAForge agent could not be selected.',
  'failure.could-not-change-mode': 'Could not change mode.',
  'failure.capability-discovery-failed':
    'We couldn’t load the available assistant actions. Try again.',
  'failure.could-not-select-this-action': 'Could not select this action.',
  'failure.cli-authentication-failed': 'The assistant could not sign in. Try signing in again.',
  'failure.queued-assistant-route-capture-is-incomplete-submit-the-message-again':
    'We couldn’t prepare your message. Send it again.',
  'failure.still-checking-available-ai-routes-try-again-in-a-moment':
    'We’re still checking which assistants are available. Try again in a moment.',
  'failure.the-selected-agent-action-does-not-belong-to-the-active-cli-route':
    'This action belongs to a different assistant. Choose the assistant again.',
  'failure.dnaforge-agent-could-not-start-this-message-try-again-or-choose-anothe':
    'DNAForge agent could not start this message. Try again or choose another host.',
  'alignment.failed':
    'We couldn’t complete this alignment action. Check your inputs and try again.',
  'failure.session-name-is-required': 'Session name is required',
  'failure.failed-to-create-session': 'Failed to create session',
  'failure.source-sequence-could-not-be-opened': 'Source sequence could not be opened.',
  'failure.could-not-open-the-source-sequence': 'Could not open the source sequence.',
  'failure.could-not-load-moclo-kit-definitions': 'Could not load MoClo kit definitions.',
  'failure.could-not-search-the-component-catalog': 'Could not search the component catalog.',
  'failure.schema-change-was-rejected': 'Schema change was rejected.',
  'failure.could-not-save-this-kit': 'Could not save this kit.',
  'failure.could-not-load-assembly-schemas': 'Could not load assembly schemas.',
  'failure.could-not-search-project-parts': 'Could not search project parts.',
  'failure.unable-to-check-accepted-assembly-sidecar':
    'We couldn’t check the saved assembly. Try opening it again.',
  'failure.unable-to-reopen-accepted-assembly': 'Unable to reopen accepted assembly.',
  'account.failed': 'We couldn’t complete this account action. Try again.',
  'failure.could-not-save-profile': 'Could not save profile.',
  'failure.enter-a-valid-organization-email': 'Enter a valid organization email.',
  'failure.id-width-must-be-an-integer-from-2-through-12':
    'ID width must be an integer from 2 through 12.',
  'failure.could-not-share-snapshot': 'Could not share snapshot.',
  'failure.cloud-backup-action-is-not-available-yet': 'Cloud backup action is not available yet.',
  'failure.could-not-verify-that-this-organization-is-empty':
    'Could not verify that this organization is empty.',
  'failure.could-not-load-organizations': 'Could not load organizations.',
  'failure.could-not-load-members': 'Could not load members.',
  'failure.could-not-load-the-audit-log': 'Could not load the audit log.',
  'failure.could-not-load-the-organization-registry': 'Could not load the organization Registry.',
  'failure.could-not-load-directory-provisioning': 'Could not load directory provisioning.',
  'failure.could-not-copy-the-invite-link': 'Could not copy the invite link.',
  'failure.type-the-organization-name-exactly-to-confirm':
    'Type the organization name exactly to confirm.',
  'failure.transfer-or-archive-organization-projects-and-registry-records-before-':
    'Transfer or archive organization projects and Registry records before deletion.',
  'failure.could-not-open-the-notebook': 'Could not open the notebook.',
  'failure.dnaforge-could-not-finish-checking-every-entity-in-this-export-your-ex':
    'DNAForge could not finish checking every entity in this export. Your existing project was preserved.',
  'failure.could-not-add-those-linked-item-exports': 'Could not add those linked-item exports.',
  'failure.dnaforge-could-not-finish-reading-those-exports':
    'DNAForge could not finish reading those exports.',
  'failure.that-drop-did-not-contain-an-export-use-the-button-below-instead':
    'That drop did not contain an export. Use the button below instead.',
  'failure.could-not-read-one-file-s-location-use-the-button-below-instead':
    'Could not read one file’s location. Use the button below instead.',
  'failure.could-not-read-that-export': 'Could not read that export.',
  'failure.that-drop-carried-no-file-or-folder-try-the-button-below':
    'That drop carried no file or folder. Try the button below.',
  'failure.could-not-read-that-item-s-location-use-the-button-below-instead':
    'Could not read that item’s location. Use the button below instead.',
  'failure.resolve-the-blocking-condition-then-retry-this-step':
    'Resolve the blocking condition, then retry this step.',
  'failure.the-migration-stopped-because-an-internal-invariant-failed-preserved-s':
    'The import stopped because its safety checks failed. Your source data is preserved in the import project.',
  'failure.migration-history-is-unavailable': 'Migration history is unavailable.',
  'failure.the-sequence-document-could-not-open': 'The sequence document could not open.',
  'failure.the-saved-molecular-view-could-not-open': 'The saved molecular view could not open.',
  'failure.opening-saved-prediction': 'Opening saved prediction…',
  'failure.opening-saved-molecular-view': 'Opening saved molecular view…',
  'failure.registry-registration-could-not-be-checked':
    'Registry registration could not be checked.',
  'failure.the-registration-could-not-be-opened': 'The registration could not be opened.',
  'sharing.failed': 'We couldn’t update sharing. Try again.',
  'sharing.deepShareSignInRequired': 'Sign in before creating a Deep Share.',
  'sharing.deepShareEditing': 'Save or cancel sequence editing before sharing.',
  'sharing.share': 'Share',
  'sharing.preparing': 'Preparing…',
  'sharing.copyPublishedLink': 'Copy published link',
  'sharing.copyingPublishedLink': 'Copying published link…',
  'failure.could-not-prepare-the-native-share':
    'We couldn’t prepare this project for sharing. Try again.',
  'failure.could-not-publish-deep-share': 'Could not publish Deep Share.',
  'failure.could-not-save-the-assembly-working-copy': 'Could not save the assembly working copy.',
  'failure.schemas-could-not-be-loaded': 'Schemas could not be loaded.',
  'failure.registry-retry-failed': 'Registry retry failed.',
  'failure.choose-a-folder-inside-an-open-project': 'Choose a folder inside an open project.',
  'failure.the-sequence-registration-could-not-be-resolved':
    'The sequence registration could not be resolved.',
  'failure.the-entity-could-not-be-opened': 'The entity could not be opened.',
  'failure.change-the-default-app-in-finder-get-info': 'Change the default app in Finder Get Info.',
  'failure.default-app-controls-are-unavailable': 'Default-app controls are unavailable.',
  'failure.the-file-could-not-be-revalidated-select-it-again':
    'The file could not be revalidated. Select it again.',
  'failure.could-not-create-the-strain':
    'The strain creation could not be confirmed. Your draft is still here. Try again.',
  'failure.select-a-record-to-view-details': 'Select a record to view Details.',
  'failure.saved-records-could-not-be-loaded': 'Saved records could not be loaded.',
  'failure.the-local-claim-preview-could-not-load': 'We couldn’t preview these records. Try again.',
  'failure.the-records-could-not-be-claimed': 'The records could not be claimed.',
  'failure.the-metadata-editor-could-not-be-opened': 'The metadata editor could not be opened.',
  'failure.the-approved-change-could-not-be-reopened': 'The approved change could not be reopened.',
  'failure.the-record-could-not-be-saved-your-draft-is-still-here':
    'The save could not be confirmed. Your draft is still here.',
  'failure.enter-a-name': 'Enter a name.',
  'failure.refresh-this-record-before-editing-its-saved-version-is-missing':
    'Refresh this record before editing. Its saved version is missing.',
  'failure.could-not-load-records-try-again': 'Could not load records. Try again.',
  'failure.schema-could-not-be-saved': 'Schema could not be saved.',
  'failure.the-organization-changed-select-the-schema-again-to-continue-editing':
    'The organization changed. Select the schema again to continue editing.',
  'failure.this-schema-changed-cancel-and-edit-its-current-version-before-saving':
    'This schema changed. Cancel and edit its current version before saving.',
  'failure.the-organization-version-could-not-be-read':
    'The organization version could not be read.',
  'failure.organization-synchronization-is-unavailable':
    'Organization synchronization is unavailable.',
  'failure.saved-on-this-device-organization-synchronization-is-pending':
    'Saved on this device; organization synchronization is pending.',
  'failure.the-approved-change-could-not-finish': 'The approved change could not finish.',
  'failure.the-approved-change-belongs-to-a-different-record-refresh-its-organiza':
    'The approved change belongs to a different record. Refresh its organization status.',
  'failure.the-saved-record-identity-changed-reload-the-record-before-continuing':
    'The saved record identity changed. Reload the record before continuing.',
  'failure.details-could-not-be-loaded': 'Details could not be loaded.',
  'failure.the-organization-registry-could-not-synchronize':
    'The organization Registry could not synchronize.',
  'failure.the-organization-registry-could-not-load': 'The organization Registry could not load.',
  'failure.registry-access-changed-refresh-this-organization-before-opening-detai':
    'Registry access changed. Refresh this organization before opening Details.',
  'failure.this-organization-registry-is-unavailable-for-the-current-account':
    'This organization Registry is unavailable for the current account.',
  'failure.loading-notebooks': 'Loading notebooks…',
  'failure.the-notebook-could-not-reload': 'The notebook could not reload.',
  'failure.could-not-open-notebook-reference': 'Could not open notebook reference.',
  'failure.the-notebook-owner-could-not-load': 'We couldn’t open this notebook. Try again.',
  'failure.the-notebook-could-not-be-discarded': 'The notebook could not be discarded.',
  'failure.could-not-open-saved-result': 'Could not open saved result.',
  'failure.captured-attachment-is-unavailable': 'Captured attachment is unavailable',
  'failure.checking-captured-attachment': 'Checking captured attachment…',
  'failure.file-must-be-an-image-png-jpg-gif-webp': 'File must be an image (PNG, JPG, GIF, WebP)',
  'failure.image-too-large-max-50mb': 'Image too large (max 50MB)',
  'failure.failed-to-read-file-please-try-again': 'Failed to read file. Please try again.',
  'failure.please-enter-a-valid-url': 'Please enter a valid URL',
  'failure.could-not-load-image-from-url': 'Could not load image from URL',
  'failure.could-not-list-saved-structures': 'Could not list saved structures.',
  'failure.could-not-save-prompt-variant': 'Could not save prompt variant.',
  'failure.the-prompt-batch-stopped': 'The prompt batch stopped.',
  'failure.the-comparison-could-not-open': 'The comparison could not open.',
  'failure.the-structure-could-not-open': 'The structure could not open.',
  'failure.could-not-load-protein-run-history': 'Could not load protein run history.',
  'failure.could-not-update-the-run-notebook': 'Could not update the run notebook.',
  'failure.could-not-export-corpus-evidence': 'Could not export corpus evidence.',
  'failure.could-not-open-this-recorded-run': 'Could not open this recorded run.',
  'failure.clipboard-is-unavailable': 'Clipboard is unavailable.',
  'failure.could-not-copy-the-run-id': 'Could not copy the run ID.',
  'failure.the-saved-version-could-not-open': 'The saved version could not open.',
  'failure.3d-viewer-stub': 'The structure preview is not available.',
  'failure.could-not-update-the-framing': 'Could not update the framing.',
  'failure.failed-to-validate-id-please-try-again': 'Failed to validate ID. Please try again.',
  'failure.file-must-be-pdb-or-cif-format': 'File must be .pdb or .cif format',
  'failure.opening-saved-structure': 'Opening saved structure…',
  'failure.could-not-load-saved-presentation': 'Could not load saved presentation.',
  'failure.could-not-load-the-saved-view': 'Could not load the saved view.',
  'failure.could-not-save-the-molecular-view': 'Could not save the molecular view.',
  'failure.could-not-load-notebooks': 'Could not load notebooks.',
  'failure.could-not-record-the-molecular-view': 'Could not record the molecular view.',
  'failure.the-saved-presentation-is-unavailable': 'The saved presentation is unavailable.',
  'failure.saved-structure-data-could-not-be-verified':
    'Saved structure data could not be verified.',
  'failure.could-not-open-agent-chat': 'Could not open agent chat.',
  'failure.this-selection-is-not-ready-to-attach-wait-for-the-structure-to-finish':
    'This selection is not ready to attach. Wait for the structure to finish loading.',
  'failure.the-notebook-table-view-could-not-update': 'The notebook table view could not update.',
  'primer.libraryFileRecoveryNeeded':
    'Your existing library primers are stored only in this application. Save them as project files so they can be backed up and restored with the project.',
  'primer.libraryFileRecoveryRunning':
    'Saving your library primers as project files. Your original records are preserved.',
  'primer.libraryFileRecoveryComplete':
    'Your library primers are saved in the Recovered primers project.',
  'primer.libraryFileRecoveryPending':
    'Some primer files still need recovery. Your original records and recovery progress are preserved. Retry to continue.',
  'primer.failed': 'We couldn’t complete this primer action. Check your inputs and try again.',
  'primer.recoveryFileMissing':
    'The saved primer file is missing. Restore it from project history or a backup.',
  'primer.recoveryRestoreFailed':
    'A saved primer copy could not be restored. Review the current project and try again.',
  'primer.recoverySavedCopyAvailable':
    'The primer file is missing. A verified saved copy is available to restore.',
  'primer.recoveryFileOutside': 'The saved primer document is outside its recorded project.',
  'primer.recoveryProjectUnavailable':
    'The primer’s project folder is unavailable. Reconnect the project before recovery.',
  'primer.recoveryReview': 'Review the saved primer files in the owning project.',
  'failure.could-not-load-this-binding-site': 'Could not load this binding site.',
  'failure.could-not-save-this-binding-site': 'Could not save this binding site.',
  'failure.open-this-sequence-in-its-project-to-edit-the-binding-site':
    'Open this sequence in its project to edit the binding site.',
  'failure.this-library-primer-needs-a-project-file-before-its-binding-site-can-b':
    'This library primer needs a project file before its binding site can be edited.',
  'failure.this-binding-site-has-changed-reopen-it-from-the-sequence':
    'This binding site has changed. Reopen it from the sequence.',
  'failure.failed-to-open-primer': 'Failed to open primer.',
  'failure.the-saved-oligo-could-not-be-refreshed': 'The saved oligo could not be refreshed.',
  'failure.the-primer-save-could-not-finish': 'The primer save could not finish.',
  'failure.this-primer-has-an-unfinished-save': 'This primer has an unfinished save.',
  'failure.the-approved-primer-could-not-be-reopened': 'The approved primer could not be reopened.',
  'failure.search-failed': 'Search failed',
  'failure.failed-to-load-primers': 'Failed to load primers',
  'failure.backtranslation-failed': 'Backtranslation failed.',
  'failure.invalid-destination-folder': 'Invalid destination folder.',
  'failure.protein-metadata-could-not-be-refreshed': 'Protein metadata could not be refreshed.',
  'failure.reference-lookup-failed': 'Reference lookup failed.',
  'failure.failed-to-open-document': 'Failed to open document.',
  'failure.document-is-invalid': 'Document is invalid.',
  'failure.failed-to-reload-the-externally-changed-document':
    'Failed to reload the externally changed document.',
  'failure.failed-to-save-document': 'Failed to save document.',
  'failure.failed-to-add-amendment': 'Failed to add amendment.',
  'failure.failed-to-add-protocol-step': 'Failed to add protocol step.',
  'failure.failed-to-delete-protocol-step': 'Failed to delete protocol step.',
  'failure.document-unavailable': 'Document unavailable.',
  'failure.unlock-the-migrated-project-before-editing-this-document':
    'Unlock the migrated project before editing this document.',
  'failure.the-prepared-reference-could-not-be-admitted':
    'We couldn’t open the prepared reference genome. Try preparing it again.',
  'failure.the-hosted-reference-catalog-could-not-be-checked':
    'We couldn’t check the available reference genomes. Try again.',
  'failure.prepared-annotation-detail-could-not-be-admitted':
    'We couldn’t open these annotations. Try preparing the reference genome again.',
  'failure.could-not-save-this-genome-view': 'Could not save this genome view.',
  'failure.prepared-genome-capabilities-could-not-be-admitted':
    'We couldn’t open this prepared genome. Try preparing it again.',
  'failure.the-indexed-reference-action-failed':
    'We couldn’t complete this reference genome action. Try again.',
  'failure.the-transcript-isoforms-could-not-be-loaded':
    'The transcript isoforms could not be loaded.',
  'failure.failed-to-create-amino-acid-sequence': 'Failed to create amino acid sequence',
  'failure.open-a-project-containing-this-genome-before-indexing-it':
    'Open a project containing this genome before indexing it.',
  'failure.remote-histogram': 'Remote histogram',
  'failure.managed-registry-status-could-not-be-loaded':
    'Managed Registry status could not be loaded.',
  'failure.could-not-load-saved-views': 'Could not load saved views.',
  'failure.could-not-open-the-saved-view': 'Could not open the saved view.',
  'failure.remote-cluster-connections-are-available-only-in-the-desktop-app':
    'Remote cluster connections are available only in the desktop app.',
  'failure.enter-a-valid-ssh-target-and-an-absolute-bigwig-path':
    'Enter a valid SSH target and an absolute BigWig path.',
  'failure.an-unexpected-error-occurred-while-rendering-the-sequence':
    'An unexpected error occurred while rendering the sequence.',
  'failure.the-approved-sequence-could-not-be-reopened':
    'The approved sequence could not be reopened.',
  'failure.the-current-sequence-could-not-be-saved-restore-was-not-applied':
    'The current sequence could not be saved. Restore was not applied.',
  'failure.finish-or-cancel-the-unfinished-metadata-edits-before-discarding-seque':
    'Finish or cancel the unfinished Metadata edits before discarding sequence edits for Restore.',
  'failure.current-edits-were-resolved-preview-restore-again-against-the-new-curr':
    'Current edits were resolved. Preview Restore again against the new current version.',
  'failure.the-assembly-editor-could-not-open': 'The assembly editor could not open.',
  'failure.could-not-copy-the-primer': 'Could not copy the primer.',
  'failure.the-annotation-file-could-not-be-imported': 'The annotation file could not be imported.',
  'failure.cut-sites': 'Cut sites',
  'failure.restriction-enzymes': 'Restriction enzymes',
  'failure.could-not-load-save-locations': 'Could not load save locations.',
  'failure.annotation-failed': 'Annotation failed',
  'failure.could-not-read-the-reference': 'Could not read the reference.',
  'failure.primer-search-failed': 'Primer search failed.',
  'failure.this-saved-mutation-source-must-be-prepared-again-before-more-calls-ca':
    'This saved mutation source must be prepared again before more calls can load.',
  'failure.could-not-open-structure-chat': 'Could not open structure chat.',
  'failure.terminal-history-could-not-be-loaded': 'Terminal history could not be loaded.',
  'failure.no-matches': 'No matches',
  'failure.failed-to-read-directory': 'Failed to read directory',
  'failure.could-not-stop-the-job': 'Could not stop the job.',
  'failure.could-not-import-the-hosted-job-result': 'Could not import the hosted job result.',
  'failure.could-not-open-the-hosted-job-result': 'Could not open the hosted job result.',
  'failure.could-not-open-the-job-result': 'Could not open the job result.',
  'failure.could-not-release-the-job-result': 'Could not release the job result.',
  'failure.could-not-reconnect-jobs': 'Could not reconnect Jobs.',
  'failure.could-not-record-the-completed-run': 'Could not record the completed run.',
  'failure.dnaforge-could-not-restore-your-projects': 'DNAForge could not restore your projects.',
  'failure.could-not-create-the-project': 'Could not create the project.',
  'failure.failed-to-import-file': 'Failed to import file',
  'failure.the-browser-safe-workspace-read-is-unavailable':
    'We couldn’t open your project in the web app. Reload to try again.',
  'failure.the-browser-proposal-service-is-unavailable':
    'We couldn’t prepare this suggested change. Try again.',
  'failure.the-browser-proposal-decision-was-unavailable':
    'We couldn’t save your decision about this change. Try again.',
  'failure.the-browser-question-service-is-unavailable':
    'We couldn’t answer this project question. Try again.',
  'failure.the-browser-mutation-proposal-service-is-unavailable':
    'We couldn’t prepare this suggested change. Try again.',
  'failure.the-approved-browser-effect-could-not-be-executed':
    'We couldn’t apply the change you approved. Try again.',
  'failure.the-browser-mutation-decision-was-unavailable':
    'We couldn’t save your decision about this change. Try again.',
  'failure.the-compared-content-changed-or-still-conflicts-review-the-current-ver':
    'The compared content changed or still conflicts. Review the current versions and choose again.',
  'failure.could-not-load-revision-history': 'Could not load revision history.',
  'failure.restore-failed': 'Restore failed.',
  'failure.this-project-changed-in-another-session-reload-before-restoring':
    'This project changed in another session. Reload before restoring.',
  'failure.sign-up-to-keep-your-work': 'Sign up to keep your work',
  'failure.could-not-publish-the-sequence-link': 'Could not publish the sequence link.',
  'failure.clipboard-access-is-unavailable-select-the-url-and-copy-it-manually':
    'Clipboard access is unavailable. Select the URL and copy it manually.',
  'failure.retry-failed': 'Retry failed.',
  'failure.an-unexpected-error-occurred': 'An unexpected error occurred',
  'failure.editing-is-unavailable-for-this-record-retry-when-its-project-becomes-':
    'Editing is unavailable for this record. Retry when its project becomes editable.',
  'failure.could-not-save-your-name-try-again': 'Could not save your name. Try again.',
  'failure.could-not-update-your-photo': 'Could not update your photo.',
  'failure.could-not-remove-your-photo': 'Could not remove your photo.',
  'failure.could-not-create-share': 'Could not create share.',
  'failure.could-not-revoke-share': 'Could not revoke share.',
  'failure.choose-a-workspace-first': 'Choose a workspace first.',
  'failure.recipient-shares-need-at-least-one-email': 'Recipient shares need at least one email.',
  'failure.could-not-create-share-check-your-connection-and-try-again':
    'Could not create share. Check your connection and try again.',
  'failure.could-not-revoke-share-check-your-connection-and-try-again':
    'Could not revoke share. Check your connection and try again.',
  'failure.could-not-copy-the-link-select-the-url-and-copy-it-manually':
    'Could not copy the link. Select the URL and copy it manually.',
  'failure.your-account-is-not-eligible-to-download-contact-support':
    'Your account is not eligible to download. Contact support.',
  'failure.too-many-download-attempts-please-wait-and-try-again':
    'Too many download attempts. Please wait and try again.',
  'failure.download-temporarily-unavailable-try-again-in-a-moment':
    'Download temporarily unavailable. Try again in a moment.',
  'failure.network-error-try-again': 'Network error. Try again.',
  'failure.could-not-sign-out-try-again': 'Could not sign out. Try again.',
  'failure.could-not-start-organization-sso':
    'We couldn’t start your organization’s sign-in. Try again.',
  'failure.could-not-send-the-link-try-again': 'Could not send the link. Try again.',
  'failure.could-not-reach-the-sign-in-service': 'Could not reach the sign-in service.',
  'failure.enter-a-valid-email-address': 'Enter a valid email address.',
  'failure.complete-the-security-check': 'Complete the security check.',
  'failure.could-not-reach-the-sign-in-service-try-again':
    'Could not reach the sign-in service. Try again.',
  'failure.display-name-must-be-1-80-characters': 'Display name must be 1–80 characters.',
  'failure.something-went-wrong': 'Something went wrong.',
  'failure.could-not-resend-the-invitation-try-again':
    'Could not resend the invitation. Try again.',
  'failure.field-definitions-must-be-valid-json': 'Field definitions must be valid JSON.',
  'failure.field-definitions-must-be-a-json-array': 'Field definitions must be a JSON array.',
  'failure.choose-a-schema-first': 'Choose a schema first.',
  'failure.choose-an-existing-writable-containing-project':
    'Choose an existing writable containing project.',
  'failure.entity-fields-must-be-valid-json': 'Entity fields must be valid JSON.',
  'failure.entity-fields-must-be-a-json-object': 'Entity fields must be a JSON object.',
  'failure.username-3-30-chars-lowercase-letters-numbers-hyphens-underscores':
    'Username: 3-30 chars, lowercase letters, numbers, hyphens, underscores.',
  'failure.username-already-taken': 'Username already taken.',
  'failure.failed-to-save-please-try-again': 'Failed to save. Please try again.',
  'failure.something-went-wrong-please-try-again': 'Something went wrong. Please try again.',
  'failure.could-not-load-applications': 'Could not load applications',
  'failure.could-not-save-decision': 'Could not save decision',
  'failure.enter-the-review-secret-and-your-reviewer-identity':
    'Enter the review secret and your reviewer identity.',
  'failure.failed-to-load-enzymes': 'Failed to load enzymes',
  'failure.failed-to-parse-file': 'Failed to parse file',
  'failure.unsupported-format-currently-supports-genbank-gb-gbk':
    'Unsupported format. Currently supports GenBank (.gb, .gbk)',
  'sequence.failed': 'We couldn’t complete this sequence action. Try again.',
  'sequence.loadFailed': 'We couldn’t open this sequence file.',
  'genome.failed': 'We couldn’t complete this genome action. Try again.',
  'notice.snapshot-saved': 'Snapshot saved',
  'notice.webgl-trace-recording-press-cmd-shift-7-to-stop':
    'WebGL trace: RECORDING — press Cmd+Shift+7 to stop',
  'notice.cpu-profile-unavailable-not-in-electron': 'CPU profile unavailable (not in Electron?)',
  'notice.cpu-profile-recording-press-cmd-shift-0-to-stop':
    'CPU profile: RECORDING — press Cmd+Shift+0 to stop',
  'notice.chat-snapshot-saved': 'Chat snapshot saved',
  'notice.couldn-t-start-a-new-chat-try-again': "Couldn't start a new chat — try again.",
  'notice.choose-a-folder-inside-an-open-project-before-creating-an-oligo':
    'Choose a folder inside an open project before creating an oligo.',
  'notice.choose-a-folder-inside-an-open-project-before-creating-a-protein':
    'Choose a folder inside an open project before creating a protein.',
  'notice.you-can-t-remove-your-only-project-dnaforge-always-keeps-at-least-one-':
    "You can't remove your only project — DNAForge always keeps at least one open. Open another project first.",
  'notice.this-record-has-no-exact-original-source-binding':
    'This record has no exact original-source binding.',
  'notice.reference-projects-are-read-only': 'Reference projects are read-only.',
  'notice.choose-a-writable-project-before-creating': 'Choose a writable project before creating.',
  'notice.the-alignment-viewer-is-not-available-yet': 'The alignment viewer is not available yet.',
  'notice.could-not-load-your-projects-try-again': 'Could not load your projects. Try again.',
  'notice.this-file-has-an-unsaved-native-working-copy-from-a-previous-session':
    'This file has an unsaved native working copy from a previous session.',
  'notice.could-not-open-this-sequence-for-renaming': 'Could not open this sequence for renaming.',
  'notice.agent-request-denied-because-its-chat-was-closed':
    'Agent request denied because its chat was closed.',
  'notice.agent-turn-cancelled-because-its-chat-was-closed':
    'Agent turn cancelled because its chat was closed.',
  'notice.could-not-attach-the-copied-sequence': 'Could not attach the copied sequence.',
  'notice.this-session-has-retained-sequencing-evidence-so-it-was-archived-inste':
    'This session has retained sequencing evidence, so it was archived instead of deleted.',
  'notice.this-read-belongs-to-retained-sequencing-evidence-hide-it-in-the-viewe':
    'This read belongs to retained sequencing evidence. Hide it in the viewer or archive its session.',
  'notice.sequencing-review-changes-could-not-be-saved-keep-this-entity-open-and':
    'Sequencing review changes could not be saved. Keep this entity open and retry.',
  'notice.plasmid-package-was-written-but-git-history-was-not-recorded-the-const':
    'Plasmid package was written, but git history was not recorded. The construct is on disk.',
  'notice.no-project-is-available-for-saving-assembly-primers':
    'No project is available for saving assembly primers',
  'notice.assembly-primers-recorded-but-committing-them-failed':
    'Assembly primers recorded, but committing them failed',
  'notice.assembly-primers-could-not-be-recorded': 'Assembly primers could not be recorded',
  'notice.photo-updated': 'Photo updated.',
  'notice.profile-saved': 'Profile saved.',
  'notice.snapshot-published-but-copy-failed-use-copy-snapshot-link-to-retry':
    'Snapshot published, but Copy failed. Use Copy snapshot link to retry.',
  'notice.some-items-need-your-decision-before-they-can-sync':
    'Some items need your decision before they can sync.',
  'notice.nothing-new-to-combine-syncing-now': 'Nothing new to combine. Syncing now.',
  'notice.a-newer-shared-version-arrived-while-you-were-choosing-a-few-items-sti':
    'A newer shared version arrived while you were choosing. A few items still need a decision.',
  'notice.your-choices-were-applied-syncing-now': 'Your choices were applied. Syncing now.',
  'notice.cloud-copy-removed-this-project-is-now-local-only':
    'Cloud copy removed. This project is now local only.',
  'notice.sync-enabled-this-project-is-managed-by-your-organization':
    'Sync enabled. This project is managed by your organization.',
  'notice.sync-enabled': 'Sync enabled.',
  'notice.sync-requested': 'Sync requested.',
  'notice.local-changes-queued-for-backup': 'Local changes queued for backup.',
  'notice.you-left-the-organization': 'You left the organization.',
  'notice.ownership-transferred-you-are-now-an-admin':
    'Ownership transferred. You are now an admin.',
  'notice.invite-link-copied': 'Invite link copied.',
  'notice.saved-organization-settings': 'Saved organization settings.',
  'notice.directory-setup-opened-in-your-browser': 'Directory setup opened in your browser.',
  'notice.directory-group-role-saved': 'Directory group role saved.',
  'notice.organization-registry-configured': 'Organization Registry configured.',
  'notice.registry-change-synchronized': 'Registry change synchronized.',
  'notice.registry-change-queued-for-retry': 'Registry change queued for retry.',
  'notice.kept-the-organization-version': 'Kept the organization version.',
  'notice.queued-the-revised-local-change': 'Queued the revised local change.',
  'notice.migration-continues-in-the-background-and-resumes-automatically-after-':
    'Migration continues in the background and resumes automatically after DNAForge restarts. Track it in Settings → Migrations.',
  'notice.benchling-import-is-ready-open-it-to-review-the-result':
    'Benchling import is ready. Open it to review the result.',
  'notice.benchling-migration-needs-attention-before-it-can-continue':
    'Benchling migration needs attention before it can continue.',
  'notice.deep-share-published-but-copy-failed-use-copy-published-link-to-retry':
    'Deep Share published, but Copy failed. Use Copy published link to retry.',
  'notice.this-item-must-be-saved-in-a-managed-project-before-it-can-be-shared':
    'This item must be saved in a managed project before it can be shared.',
  'notice.could-not-save-the-assembly-keep-it-open-and-try-again':
    'Could not save the assembly. Keep it open and try again.',
  'notice.choose-dnaforge-in-windows-default-apps-then-return-here':
    'Choose DNAForge in Windows Default Apps, then return here.',
  'notice.the-system-did-not-report-dnaforge-as-the-default-app':
    'The system did not report DNAForge as the default app.',
  'notice.import-undone': 'Import undone.',
  'notice.nothing-was-registered-every-row-was-a-duplicate-or-needs-your-attenti':
    'Nothing was registered — every row was a duplicate or needs your attention.',
  'notice.file-import-is-available-in-the-desktop-app':
    'File import is available in the desktop app.',
  'notice.project-import-is-available-in-the-desktop-app':
    'Project import is available in the desktop app.',
  'notice.sequence-already-registered': 'Sequence already registered',
  'notice.registered-open-sequence': 'Registered open sequence',
  'notice.spreadsheet-sync-could-not-start-reopen-the-project-to-retry':
    'Spreadsheet sync could not start. Reopen the project to retry.',
  'notice.dev-load-the-default-lims-registry-mock-primers':
    'Dev: load the default LIMS registry (mock primers)?',
  'notice.dev-the-lims-seed-changed-reseed-demo-data-your-hand-made-rows-are-kep':
    'Dev: the LIMS seed changed — reseed demo data? Your hand-made rows are kept.',
  'notice.dev-lims-registry-reseeded-reopen-the-lims-panel-to-view':
    'Dev LIMS registry reseeded — reopen the LIMS panel to view.',
  'notice.the-referenced-document-could-not-be-loaded-check-its-location-and-try':
    'The referenced document could not be loaded. Check its location and try again.',
  'notice.a-retained-notebook-draft-and-its-package-changed-independently-both-r':
    'A retained notebook draft and its package changed independently. Both remain preserved.',
  'notice.copied-backtranslated-dna-to-clipboard': 'Copied backtranslated DNA to clipboard',
  'notice.protein-sequence-saved': 'Protein sequence saved',
  'notice.the-result-was-saved-but-its-version-history-checkpoint-failed-check-t':
    'The result was saved, but its version-history checkpoint failed. Check the job’s action history.',
  'notice.the-result-was-saved-save-or-cancel-any-current-edits-then-reopen-the-':
    'The result was saved. Save or cancel any current edits, then reopen the original document from Files. Do not apply it again.',
  'notice.failed-to-copy-translation': 'Failed to copy translation',
  'notice.enter-one-assembly-coordinate-using-numbers-only':
    'Enter one assembly coordinate using numbers only.',
  'notice.select-bases-within-one-chromosome-before-using-sequence-actions':
    'Select bases within one chromosome before using sequence actions.',
  'notice.the-indexed-interval-returned-no-bases': 'The indexed interval returned no bases.',
  'notice.failed-to-write-the-sequence-to-the-clipboard':
    'Failed to write the sequence to the clipboard.',
  'notice.the-transcript-returned-no-exon-bases': 'The transcript returned no exon bases.',
  'notice.failed-to-write-the-translation-to-the-clipboard':
    'Failed to write the translation to the clipboard.',
  'notice.open-this-reference-inside-a-project-to-create-a-protein':
    'Open this reference inside a project to create a protein.',
  'notice.this-cds-cannot-create-a-protein-because-it-has-an-incomplete-codon-or':
    'This CDS cannot create a protein because it has an incomplete codon or internal stop.',
  'notice.this-cds-does-not-translate-to-a-complete-protein':
    'This CDS does not translate to a complete protein.',
  'notice.converted-the-file-but-the-project-view-could-not-refresh':
    'Converted the file, but the project view could not refresh.',
  'notice.could-not-open-that-quick-look-record': 'Could not open that Quick Look record.',
  'notice.save-or-cancel-the-unfinished-metadata-edits-before-switching-views':
    'Save or cancel the unfinished Metadata edits before switching views.',
  'notice.update-entity-or-discard-the-unfinished-metadata-changes-before-editin':
    'Update entity or discard the unfinished Metadata changes before editing the assembly.',
  'notice.restore-was-already-published-its-git-delivery-could-not-be-verified-w':
    'Restore was already published. Its Git delivery could not be verified without a receipt.',
  'notice.open-this-file-inside-a-project-to-create-a-protein':
    'Open this file inside a project to create a protein.',
  'notice.commit-or-discard-your-sequence-edits-before-applying-annotations':
    'Commit or discard your sequence edits before applying annotations.',
  'notice.created-initial-version-for-git-tracking': 'Created initial version for git tracking',
  'notice.dnaforge-is-now-the-default-app-for-these-files':
    'DNAForge is now the default app for these files.',
  'notice.the-request-completed-but-the-system-did-not-report-dnaforge-as-defaul':
    'The request completed, but the system did not report DNAForge as default.',
  'notice.could-not-save-the-default-app-prompt-preference':
    'Could not save the default-app prompt preference.',
  'notice.could-not-show-that-item-in-its-project': 'Could not show that item in its project.',
  'notice.replay-migration-complete': 'Replay migration complete.',
  'notice.migration-unlocked-but-its-project-could-not-be-opened':
    'Migration unlocked, but its project could not be opened.',
  'notice.project-opened-but-its-landing-document-could-not-be-opened':
    'Project opened, but its landing document could not be opened.',
  'notice.migration-validated-and-project-opened': 'Migration validated and project opened.',
  'notice.hosted-compute-job-stopped': 'Hosted compute job stopped.',
  'notice.completed-run-recorded-in-jobs': 'Completed run recorded in Jobs.',
  'notice.the-notebook-was-created-but-its-project-file-could-not-be-created-it-':
    'The notebook was created, but its project file could not be created. It is open so your work is not hidden.',
  'notice.the-notebook-could-not-be-created-try-again':
    'The notebook could not be created. Try again.',
  'notice.the-assembly-was-created-but-its-project-file-could-not-be-created-it-':
    'The assembly was created, but its project file could not be created. It is open so your work is not hidden.',
  'notice.the-assembly-could-not-be-created-try-again':
    'The assembly could not be created. Try again.',
  'notice.choose-a-folder-inside-an-open-project-before-creating':
    'Choose a folder inside an open project before creating.',
  'notice.choose-a-folder-inside-an-open-writable-project':
    'Choose a folder inside an open writable project.',
  'notice.open-a-writable-project-before-creating-an-assembly':
    'Open a writable project before creating an assembly.',
  'notice.the-current-samples-project-is-available-but-dnaforge-could-not-retire':
    'The current Samples project is available, but DNAForge could not retire an older duplicate.',
  'notice.dnaforge-could-not-receive-the-file-open-request':
    'DNAForge could not receive the file-open request.',
  'notice.click-into-the-project-you-want-to-import-the-file-into-first':
    'Click into the project you want to import the file into first.',
  'notice.open-or-create-a-project-first-then-import-files-into-it':
    'Open or create a project first, then import files into it.',
  'notice.file-import-is-only-available-in-the-desktop-app':
    'File import is only available in the desktop app.',
  'notice.encrypted-storage-is-unavailable-on-this-system-sign-in-is-not-support':
    'Encrypted storage is unavailable on this system — sign-in is not supported here.',
  'notice.sign-in-is-unavailable-in-this-environment':
    'Sign-in is unavailable in this environment.',
  'notice.terminal-shell-exited-with-code-7': 'Terminal shell exited with code 7.',
  'notice.dnaforge-is-up-to-date-v9-9-9': 'DNAForge is up to date (v9.9.9).',
  'notice.dev-build-v9-9-9-update-checks-are-disabled-in-development':
    'Dev build (v9.9.9). Update checks are disabled in development.',
  'notice.update-v9-9-9-ready-restart-to-apply': 'Update v9.9.9 ready. Restart to apply.',
  'notice.update-couldn-t-be-installed-download-the-latest-version-from-dnaforge':
    "Update couldn't be installed. Download the latest version from dnaforge.com/download.",
  'notice.update-check-failed-please-try-again-in-a-moment':
    'Update check failed. Please try again in a moment.',
  'notice.couldn-t-reach-the-update-server-check-your-connection-or-try-again-la':
    "Couldn't reach the update server. Check your connection or try again later.",
  'notice.automatic-updates-aren-t-available-for-this-build-reinstall-from-dnafo':
    "Automatic updates aren't available for this build. Reinstall from dnaforge.com to receive updates.",
  'notice.update-download-was-interrupted': 'Update download was interrupted.',
  'notice.the-downloaded-update-could-not-be-prepared':
    'The downloaded update could not be prepared.',
  'notice.change-the-default-app-in-system-settings': 'Change the default app in system settings.',
  'notice.make-dnaforge-the-default-app-for-example-files':
    'Make DNAForge the default app for Example files?',
  'notice.could-not-change-the-default-app-example-error':
    'We couldn’t change the default app. Try again.',
  'notice.updated-to-v9-9-9-see-what-changed': 'Updated to v9.9.9. See what changed.',
  'notice.you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-k':
    'You can\'t archive "Example" — it\'s your only project, and DNAForge always keeps at least one open. Open another project first.',
  'notice.couldn-t-archive-example': 'Couldn\'t archive "Example".',
  'notice.couldn-t-archive-example-it-isn-t-a-managed-project-yet':
    'Couldn\'t archive "Example" — it isn\'t a managed project yet.',
  'notice.couldn-t-duplicate-example-file': 'Couldn\'t duplicate "example/file".',
  'notice.the-file-could-not-be-moved': 'The file could not be moved.',
  'notice.the-file-operation-failed-your-original-file-remains-available':
    'The file operation failed. Your original file remains available.',
  'notice.primer-file-example-primer-json-could-not-be-added-to-your-primer-regi':
    'Primer file "example.primer.json" could not be added to your primer registry. Fix or remove it, then reopen the project.',
  'notice.primer-recovery-could-not-finish-your-existing-records-have-been-prese':
    'Primer recovery could not finish. Your existing records have been preserved. Review the reported issue before retrying.',
  'notice.the-original-my-project-has-not-been-identified':
    'The original My Project has not been identified.',
  'notice.a-saved-document-differs-from-the-application-copy-both-versions-are-r':
    'A saved document differs from the application copy. Both versions are retained. Compare them before saving or retrying.',
  'notice.the-shared-project-was-updated-but-one-document-still-needs-attention':
    'The shared project was updated, but one document still needs attention.',
  'notice.couldn-t-open-the-plasmid-in-example-file': "Couldn't open the plasmid in example/file.",
  'notice.the-project-folder-could-not-be-opened': 'The project folder could not be opened.',
  'notice.imported-3-files-into-your-project': 'Imported 3 files into your project.',
  'notice.imported-2-files-one-file-needs-attention': 'Imported 2 files. One file needs attention.',
  'notice.no-files-could-be-imported': 'No files could be imported.',
  'notice.this-record-s-source-says-organelle-but-no-feature-declares-a-genetic-':
    'This record\'s source says "organelle" but no feature declares a genetic code, and organelles use several. Translations use the standard code until you set one — the "Genetic code" control above the sequence has the list.',
  'notice.registered-3-entities-before-the-remaining-import-failed-example-error':
    'Some records were registered, but the remaining import could not finish. Try importing the rest again.',
  'notice.registered-3-entities-to-the-registry': 'Registered 3 entities to the registry.',
  'notice.the-document-could-not-be-opened-in-this-chat':
    'The document could not be opened in this chat.',
  'notice.the-reference-could-not-be-opened': 'The reference could not be opened.',
  'notice.the-original-source-for-this-reference-could-not-be-recovered':
    'The original source for this reference could not be recovered.',
  'notice.example-isn-t-inside-an-open-project-so-dnaforge-didn-t-attach-it':
    '“Example” isn’t inside an open project, so DNAForge didn’t attach it.',
  'notice.imported-all-3-records-from-example-to-edit':
    'Imported all 3 records from “Example” to edit.',
  'notice.imported-example-to-example-file-but-dnaforge-could-not-open-the-desti':
    'The file was imported, but couldn’t be opened. It remains in your project.',
  'notice.the-quick-look-import-could-not-be-completed':
    'The Quick Look import could not be completed.',
  'notice.could-not-open-example-example-error': 'We couldn’t open this file. Try again.',
  'notice.the-job-result-was-released': 'The job result was released.',
  'notice.the-job-result-could-not-be-released': 'The job result could not be released.',
  'notice.the-project-file-could-not-be-verified': 'The project file could not be verified.',
  'notice.this-document-could-not-be-opened-safely': 'This document could not be opened safely.',
  'notice.dnaforge-couldn-t-create-your-first-project-create-one-from-the-projec':
    "DNAForge couldn't create your first project. Create one from the Projects menu or restart the app.",
  'notice.couldn-t-read-example': 'Couldn\'t read "Example".',
  'notice.imported-example-but-couldn-t-open-it-it-remains-in-the-project':
    'Imported "Example", but couldn\'t open it. It remains in the project.',
  'notice.the-file-open-request-failed': 'The file-open request failed.',
  'notice.the-file-could-not-be-imported': 'The file could not be imported.',
  'notice.you-can-t-move-example-to-trash-it-s-your-only-project-and-dnaforge-al':
    'You can\'t move "Example" to Trash — it\'s your only project, and DNAForge always keeps at least one open. Open another project first.',
  'notice.couldn-t-move-example-to-trash': 'Couldn\'t move "Example" to Trash.',
  'workspace.purgeOriginalRefused':
    'The original My Project cannot be permanently deleted. Restore it from Trash to use it.',
  'workspace.purgeRetainedRefused':
    'This project has retained records or history and cannot be permanently deleted. Restore it from Trash to review them.',
  'notice.couldn-t-trash-example-it-isn-t-a-managed-project-yet':
    'Couldn\'t trash "Example" — it isn\'t a managed project yet.',
  'notice.moved-example-to-trash': 'Moved "Example" to Trash.',
  'notice.created-example-document': 'Created example document.',
  'notice.couldn-t-show-example-because-its-project-is-unavailable':
    'Couldn\'t show "Example" because its project is unavailable.',
  'notice.failed-to-save-file-your-changes-remain-in-the-editor':
    'Failed to save file. Your changes remain in the editor.',
  'notice.notes-txt-has-unsaved-changes-from-a-window-that-closed-unexpectedly':
    'notes.txt has unsaved changes from a window that closed unexpectedly.',
  'notice.unsaved-new-protein-gfp-variant-from-a-window-that-closed-unexpectedly':
    'Unsaved new protein "GFP variant" from a window that closed unexpectedly.',
  'notice.unsaved-changes-to-notes-txt-from-a-window-that-closed-unexpectedly-ca':
    "Unsaved changes to notes.txt from a window that closed unexpectedly can't be restored, because the file changed since.",
  'notice.puc19-has-unsaved-changes-from-a-window-that-closed-unexpectedly':
    'pUC19 has unsaved changes from a window that closed unexpectedly.',
  'notice.unsaved-changes-to-puc19-from-a-window-that-closed-unexpectedly-can-t-':
    "Unsaved changes to pUC19 from a window that closed unexpectedly can't be restored, because the file changed since.",
  'notice.reseed-failed': 'Reseed failed: ',
  'notice.could-not-register-sequence-example-error':
    'We couldn’t register the sequence. Try again.',
  'notice.the-conversation-could-not-be-loaded': 'The conversation could not be loaded.',
  'notice.deep-share-could-not-be-enabled': 'Deep Share could not be enabled.',
  'notice.deep-share-could-not-be-published': 'Deep Share could not be published.',
  'notice.the-shared-item-could-not-be-updated': 'The shared item could not be updated.',
  'notice.save-this-item-before-sharing-it': 'Save this item before sharing it.',
  'notice.the-item-could-not-be-prepared-for-sharing':
    'The item could not be prepared for sharing.',
  'notice.deep-share-published-and-link-copied-version-9-9-9':
    'Deep Share published and link copied. Version 9.9.9.',
  'notice.failed-to-load-your-projects': 'Failed to load your projects.',
  'notice.couldn-t-restore-example-its-project-record-is-missing':
    'Couldn\'t restore "Example" — its project record is missing.',
  'notice.couldn-t-restore-example': 'Couldn\'t restore "Example".',
  'notice.couldn-t-restore-example-it-may-already-be-purged':
    'Couldn\'t restore "Example" — it may already be purged.',
  'notice.example-was-already-removed': '"Example" was already removed.',
  'notice.couldn-t-delete-example': 'Couldn\'t delete "Example".',
  'notice.created-primer-example': 'Created primer Example.',
  'notice.saved-primer-example': 'Saved primer Example.',
  'notice.example-was-written-but-copied-primer-bindings-were-not-attached-examp':
    'The file was saved, but copied primer bindings need attention. Save again to retry.',
  'notice.failed-to-save-example-example-error-your-changes-are-still-in-memory-':
    'We couldn’t save your changes. They remain open; try saving again.',
  'notice.choose-a-example-file-example': 'Choose a Example file (Example).',
  'notice.could-not-preview-the-file-example-error':
    'We couldn’t preview this file. Try opening it again.',
  'notice.the-copied-sequence-cannot-be-pasted-here-without-changing-its-meaning':
    'The copied sequence cannot be pasted here without changing its meaning.',
  'notice.3-assembly-primers-could-not-be-recorded': '3 assembly primers could not be recorded',
  'notice.sign-in-failed-please-try-again': 'Sign-in failed. Please try again.',
  'notice.signed-in-as-example': 'Signed in as Example',
  'notice.copied-3-residues': 'Copied 3 residues',
  'notice.the-protein-sequence-could-not-be-saved': 'The protein sequence could not be saved.',
  'notice.created-protein-example': 'Created protein Example.',
  'notice.the-protein-could-not-be-created': 'The protein could not be created.',
  'notice.created-example': 'Created Example.',
  'notice.invited-example-example-com': 'Invited example@example.com.',
  'notice.invited-example-example-com-email-was-not-sent':
    'Invited example@example.com. Email was not sent.',
  'notice.revoked-2-pending-invites': 'Revoked 2 pending invites.',
  'notice.deleted-example': 'Deleted Example.',
  'notice.opened-example': 'Opened Example.',
  'notice.the-cloud-project-is-open-but-an-item-needs-attention':
    'The cloud project is open, but an item needs attention.',
  'notice.could-not-load-sync-status': 'Could not load sync status.',
  'notice.the-project-was-synchronized': 'The project was synchronized.',
  'notice.the-cloud-operation-failed': 'The cloud operation failed.',
  'notice.combined-changes-from-example-with-yours-syncing-now':
    'Combined changes from Example with yours. Syncing now.',
  'notice.could-not-combine-changes': 'Could not combine changes.',
  'notice.could-not-apply-your-choices': 'Could not apply your choices.',
  'notice.finish-or-discard-your-edits-before-sharing-a-snapshot':
    'Finish or discard your edits before sharing a snapshot.',
  'notice.snapshot-shared-version-3-link-copied': 'Snapshot shared. Version 3. Link copied.',
  'notice.snapshot-shared-version-3-copy-the-link-from-sharing-settings':
    'Snapshot shared. Version 3. Copy the link from sharing settings.',
  'notice.sync-action-failed': 'Sync action failed.',
  'notice.conflict-resolution-failed': 'Conflict resolution failed.',
  'notice.could-not-open-cloud-project': 'Could not open cloud project.',
  'notice.recovered-accepted-scientific-history-in-a-separate-profile-opening-in':
    'Recovered accepted scientific history in a separate profile. Opening instructions and working drafts are in its recovery folder.',
  'notice.could-not-recover-scientific-history': 'Could not recover scientific history.',
  'notice.choose-a-supported-profile-photo': 'Choose a supported profile photo.',
  'notice.could-not-save-photo': 'Could not save photo.',
  'notice.the-account-change-could-not-be-saved': 'The account change could not be saved.',
  'notice.save-this-project-before-sharing-a-snapshot':
    'Save this project before sharing a snapshot.',
  'notice.the-snapshot-could-not-be-shared': 'The snapshot could not be shared.',
  'notice.saved-example': 'Saved Example.',
  'notice.restore-published-but-git-history-delivery-is-incomplete-or-unverified':
    'Restore published, but Git history delivery is incomplete or unverified.',
  'notice.registered-protein-example-example-at-example-file':
    'Registered protein Example (Example) at example/file',
  'notice.annotation-import-is-blocked-until-your-sequence-edits-are-saved':
    'Annotation import is blocked until your sequence edits are saved.',
  'notice.the-result-was-saved-its-current-view-is-not-confirmed-reopen-the-save':
    'The result was saved. Its current view is not confirmed. Reopen the saved document to check it. Do not apply it again.',
  'notice.copied-3-bp-forward': 'Copied 3 bp · forward',
  'notice.one-track-in-this-view-could-not-be-opened':
    'One track in this view could not be opened.',
  'notice.the-saved-reference-needs-attention': 'The saved reference needs attention.',
  'notice.2-sequence-files-were-kept-as-plain-files-protein-fasta-guide-fa-open-':
    '2 sequence files were kept as plain files: protein.fasta, guide.fa. Open one to see why and convert it.',
  'notice.converted-the-file-but-1-of-its-2-sequences-could-not-be-opened':
    'Converted the file, but 1 of its 2 sequences could not be opened.',
  'notice.copied-translation-to-clipboard': 'Copied translation to clipboard.',
  'notice.view-saved': 'View saved.',
  'notice.track-view-recovered-copy':
    'The saved view had conflicting changes. Your edits were saved in a separate recovered copy.',
  'notice.the-view-was-saved-but-one-setting-needs-attention':
    'The view was saved, but one setting needs attention.',
  'notice.the-view-could-not-be-saved': 'The view could not be saved.',
  'notice.claude-code-is-signed-out-sent-with-codex-cli-openai':
    'Claude Code is signed out — sent with Codex CLI (OpenAI)',
  'notice.example-compute-job-finished-on-your-provider-import-it-into-your-work':
    'Example compute job finished on your provider. Import it into your workspace?',
  'notice.structure-prediction-submitted-the-result-will-be-imported-when-it-fin':
    'Structure prediction submitted. The result will be imported when it finishes.',
  'notice.the-predicted-structure-is-saved-in-your-workspace':
    'The predicted structure is saved in your workspace.',
  'notice.the-structure-prediction-failed-please-review-the-job-and-try-again':
    'The structure prediction failed. Please review the job and try again.',
  'notice.could-not-open-molecular-view': 'Could not open molecular view.',
  'notice.snapshot-failed-example-error': 'Snapshot failed: example error',
  'notice.webgl-trace-saved-example-trace-json': 'WebGL trace saved → example/trace.json',
  'notice.cpu-profile-saved-1000ms-example-profile-cpuprofile':
    'CPU profile saved (1000ms) → example/profile.cpuprofile',
  'notice.cpu-profile-failed-example-error': 'CPU profile failed: example error',
  'notice.chat-snapshot-failed-example-error': 'Chat snapshot failed: example error',
  'notice.sequencing-evidence-is-retained-in-this-entity-history':
    'Sequencing evidence is retained in this entity history.',
  'notice.the-sequence-could-not-be-saved': 'The sequence could not be saved.',
  'notice.the-notebook-owner-could-not-load': 'The notebook owner could not load.',
  'notice.the-indexed-source-for-chriv-is-not-available':
    'The indexed source for chrIV is not available.',
  'notice.the-indexed-reference-action-failed': 'The indexed reference action failed.',
  'notice.copied-1-234-bp-dna-nm-000001': 'Copied 1,234 bp DNA · NM_000001',
  'notice.failed-to-write-the-transcript-dna-to-the-clipboard':
    'Failed to write the transcript DNA to the clipboard.',
  'notice.copied-412-amino-acids': 'Copied 412 amino acids',
  'notice.registered-protein-jun-prt-0001-at-proteins-jun-json':
    'Registered protein JUN (PRT-0001) at proteins/JUN.json',
  'notice.deleted-annotation-promoter': 'Deleted annotation Promoter',
  'notice.added-annotation-promoter': 'Added annotation Promoter',
  'notice.updated-annotation-promoter': 'Updated annotation Promoter',
  'privacy.updated': 'We updated our privacy policy.',
  'analytics.notice':
    'DNAForge shares usage analytics and crash reports to help improve the app. You can turn this off in Settings.',
  'analytics.optIn':
    'Share usage analytics and crash reports to help improve DNAForge? Nothing is shared unless you allow it. You can change this in Settings.',
  'notice.sign-in-complete-this-cli-is-ready-to-use': 'Sign-in complete. This CLI is ready to use.',
  'notice.unknown-error': 'Unknown error',
  'notice.cli-authentication-failed': 'CLI authentication failed',
  'notice.loading-details': 'Loading Details…',
  'notice.3d-viewer-stub': '3D viewer stub',
  'notice.connected': 'Connected',
  'notice.reconnecting': 'Reconnecting…',
  'notice.authentication-needed': 'Authentication needed',
  'notice.connection-needs-repair': 'Connection needs repair',
  'assistant.resultAvailable': 'Assistant result',
  'assistant.action': 'Assistant action',
  'assistant.inspectAppState': 'Inspect app state',
  'assistant.runCommand': 'Run command',
  'assistant.actionDetails.show': 'Show action details',
  'assistant.actionDetails.hide': 'Hide action details',
  'assistant.actionField.file': 'File',
  'assistant.actionField.command': 'Command',
  'assistant.actionField.search': 'Search',
  'assistant.actionField.target': 'Target',
  'assistant.actionField.action': 'Action',
  'assistant.actionField.region': 'Region',
  'assistant.actionField.chromosome': 'Chromosome',
  'assistant.actionField.start': 'Start',
  'assistant.actionField.end': 'End',
  'assistant.actionField.results': 'Results',
  'assistant.actionField.matches': 'Matches',
  'assistant.actionField.items': 'Items',
  'assistant.actionField.features': 'Features',
  'assistant.actionField.length': 'Length',
  'assistant.actionField.format': 'Format',
  'assistant.actionField.name': 'Name',
  'assistant.actionField.description': 'Description',
  'assistant.actionField.service': 'Service',
  'assistant.listFiles': 'List files',
  'assistant.readFile': 'Read file',
  'assistant.findFeatures': 'Find sequence features',
  'assistant.projectOverview': 'Project overview',
  'assistant.fileChanges': 'File changes',
  'assistant.openDocument': 'Open document',
  'assistant.closeDocument': 'Close document',
  'assistant.createReference': 'Create reference',
  'file.notFound': 'The file or folder could not be found.',
  'file.deleteDeliveryPending': 'Delete accepted; cloud delivery is pending.',
  'file.trashUncertain':
    'The file operation could not finish. Inspect File Trash before retrying; a move may have completed.',
  'file.permissionDenied': 'You don’t have permission to open this file or folder.',
  'file.notFolder': 'Choose a folder to continue.',
  'account.signInRequired': 'Sign in to continue.',
  'setup.tool': 'Required tool',
  'setup.preparing': 'preparing',
  'failure.the-original-my-project-is-already-identified':
    'The original My Project is already identified.',
  'failure.this-action-is-no-longer-available': 'This action is no longer available.',
  'failure.the-selected-agent-action-is-no-longer-available':
    'The selected agent action is no longer available.',
  'failure.could-not-preview-cloud-backup-contents': 'Could not preview cloud backup contents.',
  'failure.could-not-load-cloud-projects': 'Could not load cloud projects.',
  'failure.could-not-load-who-has-access': 'Could not load who has access.',
  'failure.ucsc-could-not-answer-this-lookup': 'UCSC could not answer this lookup.',
  'failure.sidecar-base-url-unavailable': 'We couldn’t connect to the service. Try again.',
  'failure.poster-capacity-wait': 'poster-capacity-wait',
  'failure.poster-fetch-error': 'poster-fetch-error',
  'failure.this-structure-tab-has-no-coordinate-file-reference':
    'This structure tab has no coordinate-file reference.',
  'failure.pinned-history-could-not-be-saved': 'Pinned history could not be saved.',
  'notice.permission-refused': 'Permission refused',
  'notice.unavailable': 'unavailable',
  'notice.this-provider-catalog-changed-refresh-it-before-choosing-an-action':
    'This provider catalog changed. Refresh it before choosing an action.',
  'notice.the-selected-agent-action-is-stale-open-agent-actions-and-choose-it-ag':
    'The selected agent action is stale. Open Agent Actions and choose it again.',
  'notice.https-htsget-example-org': 'https://htsget.example.org',
  'notice.https-results-example-org-run-sample-bigwig':
    'https://results.example.org/run/sample.bigWig',
  'notice.cohort-sample-bigwig': 'cohort/sample.bigWig',
  'notice.poster-fetch-empty': 'poster-fetch-empty',
  'auth.flow-email-mismatch': 'Start a new sign-in request to use a different email.',
  'auth.challenge-failed': 'Complete the security check again.',
  'auth.too-many-requests': 'Too many authentication attempts; try again shortly',
  'auth.auth-rate-limit-unavailable': 'Authentication is temporarily unavailable; retry shortly',
  'jobs.attention': 'This job needs your attention. Open its result or try refreshing it.',
  'jobs.failed': 'This job could not finish. Review its inputs and try again.',
  'jobs.refreshFailed': 'We couldn’t refresh this job. Try again.',
  'permissions.additional': 'Additional permission',
  'document.unsupportedContent': 'This content isn’t supported in this version of DNAForge.',
  'document.unsupportedContentDetail':
    'Your saved content is unchanged. Open it in a version of DNAForge that supports it.',
  'sharing.omittedContent':
    'Some content could not be included. Open the original project to review it.',
  'failure.open-cloud-backup': 'Open cloud backup',
  'copy.uploads-eligible-design-files-only-genbank-fasta-notebooks-design':
    'Uploads eligible design files only (GenBank, FASTA, notebooks, designs, primers; size caps apply). FASTQ, BAM, and other files stay on this computer. Cloud backups are not end-to-end encrypted — DNAForge can read snapshot contents to serve restore and share links.',
  'copy.': '',
  'copy.could-not-read-cloud-backup-status-close-and-reopen-this-menu-to-':
    'Could not read cloud backup status. Close and reopen this menu to retry.',
  'copy.enable-backup-for-this-managed-project-to-use-another-mac-or-shar':
    'Enable backup for this managed project to use another Mac or share a link.',
  'copy.cloud-storage-is-full-for-this-account': 'Cloud storage is full for this account.',
  'copy.this-project-has-files-or-state-that-cloud-backup-cannot-upload-y':
    'This project has files or state that cloud backup cannot upload yet.',
  'copy.you-no-longer-have-access-to-this-shared-project-your-unsent-chan':
    'You no longer have access to this shared project. Your unsent changes are kept on this computer.',
  'copy.you-can-open-and-read-this-shared-project-changes-you-make-stay-o':
    'You can open and read this shared project. Changes you make stay on this computer.',
  'copy.incoming-changes-are-saved-updating-the-desktop-before-backup-con':
    'Incoming changes are saved. Updating the desktop before backup continues.',
  'copy.creating-the-cloud-project-binding': 'Creating the cloud project binding.',
  'copy.your-copy-matches-the-latest-shared-version':
    'Your copy matches the latest shared version.',
  'copy.eligible-design-files-match-the-latest-cloud-version':
    'Eligible design files match the latest cloud version.',
  'copy.saved-changes-on-this-computer-have-not-been-shared-yet':
    'Saved changes on this computer have not been shared yet.',
  'copy.local-changes-are-waiting-for-backup': 'Local changes are waiting for backup.',
  'copy.your-work-is-safe-here-and-will-sync-when-you-reconnect':
    'Your work is safe here and will sync when you reconnect.',
  'copy.backup-will-retry-when-the-network-is-available':
    'Backup will retry when the network is available.',
  'copy.cloud-backup-is-paused-for-this-dnaforge-environment-and-will-ret':
    'Cloud backup is paused for this DNAForge environment and will retry automatically.',
  'copy.the-bound-account-must-be-active-to-continue':
    'The bound account must be active to continue.',
  'copy.someone-else-changed-the-same-content-choose-which-version-to-kee':
    'Someone else changed the same content. Choose which version to keep.',
  'copy.remote-changes-need-a-resolution-before-upload-continues':
    'Remote changes need a resolution before upload continues.',
  'copy.incoming-changes-are-saved-the-desktop-must-finish-refreshing-bef':
    'Incoming changes are saved. The desktop must finish refreshing before backup continues.',
  'copy.cloud-backup-needs-attention': 'Cloud backup needs attention.',
  'copy.opening-the-cloud-version-locally': 'Opening the cloud version locally.',
  'copy.archived-projects-do-not-back-up': 'Archived projects do not back up.',
  'copy.trashed-projects-do-not-back-up': 'Trashed projects do not back up.',
  'copy.needs-api-key': 'Needs API key',
  'copy.checking-api-key': 'Checking API key',
  'copy.key-check-failed': 'Key check failed',
  'copy.assistant-connection-options': 'Assistant connection options.',
  'tools.extracting': 'Extracting archive',
  'tools.installing': 'Installing',
  'tools.verifying': 'Verifying download',
  'tools.ready': 'Ready',
  'tools.updating': 'Downloading',
  'tools.attention': 'Needs attention',
  'tools.unavailable': 'Not available',
  'tools.preparing': 'Preparing',
  'tools.noDetails': 'Installation details aren’t available yet.',
  'fileAssociations.checking': 'Checking the current default…',
  'fileAssociations.default': 'DNAForge is default',
  'fileAssociations.none': 'No default app selected',
  'fileAssociations.unavailable': 'Default-app status is unavailable',
  'fileAssociations.unsupportedPlatform':
    'Desktop file associations are supported on macOS and Windows.',
  'detail.could-not-stop-the-saved-retry-draft-kept': 'Could not stop the saved retry. Draft kept.',
  'detail.feedback-received-thank-you': 'Feedback received — thank you!',
  'detail.preserved-source-metadata-is-outside-this-migrated-project':
    'The original source file could not be found in this project.',
  'detail.this-clears-all-parts-spacers-and-primers-from-this-assembly-this-cann':
    'This clears all parts, spacers and primers from this assembly.\nThis cannot be undone.',
  'detail.the-design-changed-before-this-workbench-command-could-be-committed':
    'The design changed before this update could be saved. Review it and try again.',
  'detail.the-design-changed-before-undo-could-restore-the-previous-workbench-st':
    'The design changed before Undo could restore the previous version.',
  'detail.choose-a-permanent-unique-id-column': 'Choose a permanent unique ID column.',
  'detail.this-notebook-has-no-owning-project-so-its-references-cannot-resolve':
    'Add this notebook to a project to open its references.',
  'detail.dnaforge-could-not-check-this-reference-just-now':
    'DNAForge could not check this reference just now.',
  'detail.this-protein-has-no-resolved-amino-acid-sequence':
    'This protein has no resolved amino-acid sequence.',
  'detail.the-alignment-source-for-this-read-is-unavailable':
    'The alignment source for this read is unavailable.',
  'detail.tab-idle-open-to-load': 'Tab idle — open to load.',
  'detail.assembly-annotation-overview-is-owned-by-tiled-assembly-rendering':
    'Zoom in to see genome annotations.',
  'detail.waiting-for-genome-session': 'Waiting for genome session…',
  'detail.this-share-link-is-missing-its-access-token':
    'This share link is missing its access token.',
  'detail.the-access-token-does-not-match-this-share':
    'The access token does not match this share.',
  'detail.this-share-link-has-been-revoked': 'This share link has been revoked.',
  'detail.this-share-link-has-expired': 'This share link has expired.',
  'detail.sign-in-with-a-recipient-email-to-view-this-workspace':
    'Sign in with a recipient email to view this workspace.',
  'detail.this-account-is-not-on-the-recipient-list-for-this-share':
    'This account is not on the recipient list for this share.',
  'detail.this-share-link-does-not-exist': 'This share link does not exist.',
  'detail.update-dnaforge-to-open-this-newer-shared-workspace':
    'Update DNAForge to open this newer shared workspace.',
  'detail.the-share-preview-could-not-be-loaded': 'The share preview could not be loaded.',
  'detail.could-not-save-the-application': 'Could not save the application',
  'detail.the-application-was-saved-but-its-receipt-is-unavailable':
    'The application was saved, but its receipt is unavailable',
  'detail.could-not-join-the-waitlist': 'Could not join the waitlist',
  'operation.notice': 'An update is available. Review it before continuing.',
  'operation.confirm': 'Review this change before continuing.',
  'operation.attention':
    'This action needs your attention. Check the current project before continuing.',
  'operation.failedTitle': 'Something went wrong',
  'dialog.hosted-ai-requires-a-dnaforge-account-sign-in-to-continue':
    'Hosted AI requires a DNAForge account. Sign in to continue.',
  'dialog.they-will-no-longer-be-able-to-open-or-change-this-project-through-dna':
    'They will no longer be able to open or change this project through DNAForge. Copies already on their computer stay with them.',
  'dialog.create-a-separate-recovery-profile-with-the-accepted-scientific-histor':
    'Create a separate recovery profile with the accepted scientific history and original Registry identities. Captured working changes will be kept in a drafts folder for you to review. The recovery folder includes opening instructions.',
  'dialog.a-program-may-still-be-running-in-this-terminal-closing-it-will-stop-i':
    'A program may still be running in this terminal. Closing it will stop its shell.',
  'dialog.this-program-may-run-each-pasted-line-immediately':
    'This program may run each pasted line immediately.',
  'dialog.this-permanently-deletes-the-retained-scientific-output-for-this-job-i':
    'This permanently deletes the retained scientific output for this job. Its execution history and any annotations already applied to a document will remain. You will no longer be able to open this retained result.',
  'dialog.startup-error': 'Startup Error',
  'dialog.the-bundled-command-is-unavailable': 'The bundled command is unavailable.',
  'dialog.install-a-complete-dnaforge-application-to-use-its-bundled-command-lin':
    'Install a complete DNAForge application to use its bundled command line.',
  'dialog.dnaforge-command-line': 'DNAForge Command Line',
  'dialog.use-dnaforge-from-your-shell': 'Use DNAForge from your shell',
  'dialog.could-not-open-entity': 'Could not open entity',
  'dialog.this-link-belongs-to-another-dnaforge-development-instance':
    'This link belongs to another DNAForge development instance.',
  'dialog.this-dnaforge-entity-link-is-invalid': 'This DNAForge entity link is invalid.',
  'dialog.sign-in-to-open-your-organizations': 'Sign in to open your organizations',
  'dialog.dnaforge-will-open-organization-settings-once-sign-in-completes':
    'DNAForge will open organization settings once sign-in completes.',
  'dialog.sign-in-to-open-this-shared-project': 'Sign in to open this shared project',
  'dialog.dnaforge-will-open-the-project-once-sign-in-completes':
    'DNAForge will open the project once sign-in completes.',
  'dialog.could-not-open-shared-project': 'Could not open shared project',
  'dialog.the-project-was-downloaded-but-its-local-record-was-not-found':
    'The project was downloaded but its local record was not found.',
  'dialog.sign-in-to-import-this-deep-share': 'Sign in to import this Deep Share',
  'dialog.dnaforge-will-resume-the-private-fork-import-once-sign-in-completes':
    'DNAForge will resume the private-fork import once sign-in completes.',
  'dialog.private-fork-opened': 'Private fork opened',
  'dialog.dnaforge-is-already-running': 'DNAForge is already running',
  'dialog.lims-registry-temporarily-unavailable': 'LIMS registry temporarily unavailable',
  'dialog.update-required': 'Update required',
  'dialog.current-release-required': 'Current release required',
  'dialog.database-upgrade-blocked': 'Database upgrade blocked',
  'dialog.database-migration-failed': 'Database migration failed',
  'dialog.database-recovery-failed': 'Database recovery failed',
  'dialog.database-engine-failed-to-load': 'Database engine failed to load',
  'dialog.native-module-version-mismatch': 'Native module version mismatch',
  'dialog.native-module-architecture-mismatch': 'Native module architecture mismatch',
  'dialog.database-schema-error': 'Database schema error',
  'dialog.database-failed-to-initialize': 'Database failed to initialize',
  'dialog.review-before-the-next-round': 'Review before the next round',
  'dialog.have-you-reviewed-the-current-round-and-authorized-this-next-run':
    'Have you reviewed the current round and authorized this next run?',
  'dialog.scientific-storage-recovery': 'Scientific Storage Recovery',
  'dialog.save-your-changes-before-creating-a-recovery-copy':
    'Save your changes before creating a recovery copy.',
  'dialog.no-scientific-storage-recovery-checkpoint-is-available':
    'No scientific storage recovery checkpoint is available.',
  'dialog.create-a-separate-copy-from-before-scientific-storage-was-enabled':
    'Create a separate copy from before scientific storage was enabled.',
  'dialog.the-separate-recovery-copy-is-ready': 'The separate recovery copy is ready.',
  'dialog.the-recovery-copy-was-created-but-could-not-be-shown':
    'The recovery copy was created, but could not be shown.',
  'dialog.recovery-copy-was-not-created': 'Recovery copy was not created.',
  'dialog.another-dnaforge-process-already-owns-this-profile-switch-to-its-exist':
    'Another DNAForge process already owns this profile.\n\nSwitch to its existing window, or stop its command-line runtime before opening the app.',
  'dialog.unsaved-changes': 'Unsaved Changes',
  'dialog.some-changes-were-not-saved': 'Some Changes Were Not Saved',
  'dialog.discard-could-not-be-confirmed': 'Some Changes Were Not Discarded',
  'dialog.dnaforge-could-not-confirm-that-all-unsaved-changes-were-discarded':
    'DNAForge could not discard some of your changes.',
  'dialog.the-app-will-stay-open-inspect-the-remaining-changes-after-the-current':
    'The app will stay open. Close the remaining documents individually, then try again.',
  'dialog.window-stopped-working': 'Window Stopped Working',
  'dialog.the-dnaforge-window-stopped-working': 'The DNAForge window stopped working.',
  'dialog.reload-the-window-to-continue-unsaved-sequence-edits-are-kept-and-dnaf':
    'Reload the window to continue. Open sequences reopen with their unsaved edits.',
  'dialog.not-responding': 'Not Responding',
  'dialog.dnaforge-isn-t-responding': "DNAForge isn't responding.",
  'dialog.you-can-wait-for-it-to-finish-or-reload-the-window-reloading-keeps-uns':
    'You can wait for it to finish, or reload the window. Reloading keeps unsaved edits for recovery.',
  'dialog.couldn-t-load-the-window': "Couldn't Load the Window",
  'dialog.dnaforge-can-t-reach-its-development-server':
    "DNAForge can't reach its development server.",
  'dialog.the-dnaforge-window-couldn-t-load': "The DNAForge window couldn't load.",
  'dialog.recovery-requires-a-checkpoint-saved-before-scientific-database-storag':
    'Recovery requires a checkpoint saved before scientific database storage was enabled for an active project. A later history version or preserved current state cannot substitute for that checkpoint.',
  'dialog.the-recovered-copy-contains-the-saved-state-from-before-scientific-dat':
    'The recovered copy contains the saved state from before scientific database storage was enabled. Newer saved work will be preserved in a separate current-state checkpoint; it will not appear in the recovered legacy copy. Your original project will remain active.\n\nUse the recovery folder instructions to open its isolated profile with a compatible application. Do not open your original profile with an older application.',
  'dialog.archive-project': 'Archive project',
  'dialog.archive': 'Archive',
  'dialog.delete-permanently': 'Delete permanently',
  'dialog.sign-in-to-use-hosted-ai': 'Sign in to use Hosted AI',
  'dialog.sign-in': 'Sign in',
  'dialog.not-now': 'Not now',
  'dialog.allow-this-change': 'Allow this change?',
  'dialog.allow': 'Allow',
  'dialog.deny': 'Deny',
  'dialog.clear-and-switch': 'Clear and switch',
  'dialog.cancel': 'Cancel',
  'dialog.replace-plasmid-product': 'Replace plasmid product',
  'dialog.replace-product': 'Replace product',
  'dialog.back-up-copy-link': 'Back up & copy link',
  'dialog.remove-access': 'Remove access?',
  'dialog.remove-access-other': 'Remove access',
  'dialog.recover-saved-history-and-drafts': 'Recover saved history and drafts',
  'dialog.recover': 'Recover',
  'dialog.enable-cloud-backup-to-share': 'Enable cloud backup to share?',
  'dialog.enable-continue': 'Enable & continue',
  'dialog.update-an-attached-primer': 'Update an attached primer?',
  'dialog.update-sequence': 'Update sequence',
  'dialog.keep-editing': 'Keep editing',
  'dialog.remove-track': 'Remove track?',
  'dialog.remove-track-other': 'Remove track',
  'dialog.keep-track': 'Keep track',
  'dialog.close-busy-terminal': 'Close busy terminal?',
  'dialog.close-terminal': 'Close terminal',
  'dialog.paste-multiple-lines': 'Paste multiple lines?',
  'dialog.paste': 'Paste',
  'dialog.interrupt-program': 'Interrupt program',
  'dialog.stop-hosted-compute-job': 'Stop hosted compute job?',
  'dialog.stop-job': 'Stop job',
  'dialog.keep-running': 'Keep running',
  'dialog.release-retained-result': 'Release retained result?',
  'dialog.release-result': 'Release result',
  'dialog.keep-result': 'Keep result',
  'dialog.move-to-trash': 'Move to Trash',
  'dialog.rename-project': 'Rename project',
  'dialog.rename': 'Rename',
  'dialog.continue': 'Continue',
  'dialog.confirmChange': 'Confirm this change',
  'dialog.name': 'Name',
  'dialog.empty': '',
  'dialog.project-name': 'Project name',
  'dialog.reload-window': 'Reload Window',
  'dialog.quit-dnaforge': 'Quit DNAForge',
  'dialog.wait': 'Wait',
  'dialog.try-again': 'Try Again',
  'dialog.close': 'Close',
  'dialog.copy-path': 'Copy path',
  'dialog.import-private-fork': 'Import private fork',
  'dialog.keep-reviewing': 'Keep reviewing',
  'dialog.i-reviewed-it-authorize-this-run': 'I reviewed it — authorize this run',
  'dialog.choose-project': 'Choose Project…',
  'dialog.create-recovery-copy': 'Create Recovery Copy',
  'dialog.reveal-recovery-copy': 'Reveal Recovery Copy',
  'record.finishMetadataBeforeClosing':
    'Update the entity or discard your metadata changes before closing this tab.',
  'reference.recordWrongTarget': 'The referenced record did not reach its intended destination.',
  'reference.recordNotPresented': 'The referenced record did not reach its destination.',
  'reference.recordUnavailable': 'The canonical entity is unavailable.',
  'reference.oligoUnavailable': 'The canonical oligo is unavailable.',
  'reference.projectUnavailable':
    'Project reference unavailable. Check that its project is open and try again.',
  'reference.notebookUnavailable': 'The referenced notebook is not available in its project.',
  'reference.recordNotFound': 'Record not found.',
  'reference.recordOpenFailed': 'The referenced record could not be opened. Try again.',
  'annotation.savingReview': 'Saving the reviewed result…',
  'annotation.checkingDocument': 'Checking the current document…',
  'annotation.checkingRevision': 'Checking the analyzed sequence revision…',
  'annotation.documentChanged': 'The document changed.',
  'annotation.resultNotApplicable': 'This result cannot be applied to the current document.',
  'annotation.reviewMismatch':
    'The retained result no longer matches this review. Reopen its result from Jobs.',
  'annotation.documentReadOnly': 'This document is read-only.',
  'annotation.reviewInactive': 'This operation has no active review.',
  'annotation.inspectBeforeApply': 'Inspect this document before applying the result.',
  'annotation.selectBeforeApply': 'Select at least one annotation to apply.',
  'annotation.selectionAlreadySaving': 'Another selection is being saved for this operation.',
  'annotation.documentUnavailable': 'The document service is unavailable. Reconnect and try again.',
  'annotation.documentFailed':
    'The document service could not complete this request. Refresh review and try again.',
  'annotation.inspectionUnconfirmed':
    'The document owner did not confirm the inspection. Refresh review.',
  'annotation.applyBlocked':
    'The annotations could not be applied. Refresh review before trying again.',
  'annotation.saveFailed':
    'The annotations could not be saved. Your review is still available. Try again.',
  'annotation.outcomeUnresolved':
    "The save response could not be confirmed. Check this job's action history before repeating Apply.",
  'annotation.previousSessionSaved':
    "The document was saved in the previous session. Check this job's action history before repeating Apply.",
  'annotation.previousSessionCompleted':
    "The document command completed in a previous session. Check this job's action history before repeating Apply.",
  'record.restoreBeforeEditing': 'Restore this record before editing it.',
  'record.sequenceReadOnly': 'This sequence is read-only.',
  'record.indexedMetadataReadOnly': 'This indexed sequence’s metadata is read-only.',
  'record.sequenceFileMetadataReadOnly':
    'This sequence file’s metadata is read-only. Import it as an editable entity to change it.',
  'record.projectUnavailable': 'The owning project is unavailable.',
  'record.projectArchived': 'Project is archived.',
  'record.oligoUnavailable': 'The oligo is unavailable.',
  'record.owningDocumentUnavailable': 'The owning document is unavailable.',
  'record.trackViewProjectRequired': 'Open this view’s project before editing its metadata.',
  'record.originalSourceReadOnly':
    'This imported record preserves its original source. View original source to inspect it.',
  'edit.sequenceOverlapping':
    'This sequence belongs to overlapping project entries. Open its project once to edit it.',
  'edit.sequenceProjectUnavailable':
    'This sequence’s project is unavailable. Restore its project to edit it.',
  'edit.checkingProject': 'Checking project access before editing.',
  'edit.projectCheckFailed': 'Project access could not be checked. Restart DNAForge to try again.',
  'edit.projectRestoring':
    'This project is still being restored. Editing will be available when restoration finishes.',
  'edit.referenceFolder':
    'This sequence is in a reference folder. Copy it into a project to edit it.',
  'edit.refreshProjectAccess':
    'Project access could not be checked. Try again after refreshing project access.',
  'edit.projectViewOnly': 'You have view-only access to this shared project.',
  'record.native.save-or-discard-this-document-s-content-before-editing-its-metadata':
    'Save or discard this document’s content before editing its metadata.',
  'record.native.the-saved-view-identity-changed-reopen-its-metadata':
    'The saved view identity changed. Reopen its metadata.',
  'record.native.this-view-changed-after-its-save-reopen-its-current-version':
    'This view changed after its save. Reopen its current version.',
  'record.native.open-this-document-s-project-before-editing-it':
    'Open this document’s project before editing it.',
  'record.native.the-molecular-document-identity-changed-reopen-its-metadata':
    'The molecular document identity changed. Reopen its metadata.',
  'record.native.open-this-notebook-s-project-before-editing-it':
    'Open this notebook’s project before editing it.',
  'record.native.the-notebook-is-unavailable-reopen-its-project':
    'The notebook is unavailable. Reopen its project.',
  'record.native.save-or-discard-notebook-content-before-editing-its-metadata':
    'Save or discard notebook content before editing its metadata.',
  'record.native.the-notebook-name-changed-reopen-metadata-before-saving':
    'The notebook name changed. Reopen Metadata before saving.',
  'record.native.the-notebook-could-not-be-renamed': 'The notebook could not be renamed.',
  'record.native.these-fields-are-controlled-by-the-document-s-native-editor':
    'These fields are controlled by the document’s native editor.',
  'registry.receipt.registrationFailed':
    'The file was imported, but registry registration failed. Review the saved file before retrying.',
  'registry.receipt.sequencePackageMissing':
    'The file was imported, but it could not be opened as an editable sequence. The Registry was not changed.',
  'registry.receipt.savedIncomplete':
    'Files were saved, but the import did not finish. Review the destination before retrying.',
  'registry.receipt.unconfirmed':
    'The import could not be confirmed. Check the destination before retrying.',
  'conflict.previewFailed': 'Preview unavailable. Inspect the saved files before choosing.',
  'conflict.metadataUnreadable':
    'The saved metadata could not be read. Inspect the saved files before choosing.',
  'conflict.inspecting': 'Inspecting exact saved bytes…',
  'registry.notice.cannot-register-this-sequence-no-source-file-or-content-re-drop-the-file-to-impo':
    'Cannot register this sequence: no source file or content. Re-drop the file to import it.',
  'registry.notice.cleared-the-registry-default-schemas-were-kept':
    'Cleared the Registry. Default schemas were kept.',
  'registry.notice.the-account-changed-while-opening-this-registry-open-it-again-from-the-current-a':
    'The account changed while opening this Registry. Open it again from the current account.',
  'registry.notice.record-was': 'record was',
  'registry.notice.records-were': 'records were',
  'registry.notice.the-placement-removal-was-queued-for-organization-sync':
    'The placement removal was queued for organization sync.',
  'conflict.metadataTooLarge':
    'Metadata is too large for inline comparison; inspect the saved files.',
  'conflict.noSequenceProduct': 'No sequence product is available.',
  'conflict.sequenceTooLarge':
    'Sequence is too large for inline comparison; inspect the saved files before choosing.',
  'conflict.binaryContent':
    'Binary content: compare the saved file fingerprints and attachments before choosing.',
  'web.account.signInRequired': 'You need to sign in.',
  'web.account.displayNameRequired': 'Enter a display name.',
  'web.account.profileSignInRequired': 'Sign in to edit your profile',
  'web.account.avatarTypeInvalid': 'Avatar must be PNG, JPEG, or WebP',
  'web.account.avatarSizeInvalid': 'Avatar must be between 1 byte and 512 KB',
  'web.account.avatarStoreFailed': 'Could not store avatar',
  'web.account.profileUpdateFailed': 'Could not update profile',
  'web.desktopAuth.requestExpired': 'This sign-in request expired or was already used',
  'web.desktopAuth.confirmFailed': 'Could not complete sign-in. Start again from the desktop app.',
  'web.org.nameLength': 'Organization name must be 1–80 characters.',
  'web.org.urlFormat': 'URL must be 3–40 chars: lowercase letters, numbers, hyphens.',
  'web.org.urlFormatDetailed':
    'URL must be 3–40 chars: lowercase letters, numbers, hyphens (no leading/trailing hyphen).',
  'web.org.urlInvalidCharacters': 'That URL contains invalid characters.',
  'web.org.urlTaken': 'That URL is already taken.',
  'web.org.createFailed': 'Could not create the organization.',
  'web.org.createUnconfirmed':
    'Could not create the organization. Check your organizations before trying again.',
  'web.org.saveFailed': 'Could not save changes.',
  'web.org.saveUnconfirmed':
    'Could not save the organization. Check its current settings before trying again.',
  'web.org.deleteFailed': 'Could not delete the organization.',
  'web.org.deleteUnconfirmed':
    'Could not confirm organization deletion. Check your organizations before trying again.',
  'web.org.updateUnconfirmed':
    'Could not update the organization. Check its current state before trying again.',
  'web.org.notFound': 'Organization not found.',
  'web.org.roleInvalid': 'Pick a valid role.',
  'web.org.roleUnknown': 'Unknown role.',
  'web.org.roleChangeFailed': 'Could not change the role.',
  'web.org.roleChangeBelowRank': 'You can only change roles for members below your role.',
  'web.org.grantBelowRank': 'You cannot grant a role at or above your own.',
  'web.org.memberRemoveFailed': 'Could not remove the member.',
  'web.org.memberRemoveBelowRank': 'You can only remove members below your role.',
  'web.org.alreadyMember': 'That account is already a member.',
  'web.org.ownershipTransferFailed': 'Could not transfer ownership.',
  'web.org.lastOwnerLeave':
    'Add another owner before leaving — an organization must always have an owner.',
  'web.org.lastOwnerChange': 'Add another owner before changing or removing the last owner.',
  'web.org.permissionDenied': "You don't have permission to do that.",
  'web.org.invitePendingExists': 'There is already a pending invite for that email.',
  'web.org.inviteCreateFailed': 'Could not create the invite.',
  'web.org.inviteUnconfirmed':
    'Could not confirm the invitation. Check pending invitations before trying again.',
  'web.org.inviteRevokeFailed': 'Could not revoke the invite.',
  'web.org.inviteRevokeUnconfirmed': 'Could not revoke the invitation. Try again.',
  'web.org.inviteResendFailed': 'Could not resend the invite.',
  'web.org.invitationNotPending': 'That invitation is no longer pending.',
  'web.org.inviteNotPending': 'That invite is no longer pending.',
  'web.org.inviteWrongEmail': 'This invite was sent to a different email than your verified one.',
  'web.org.inviteExpired': 'This invite has expired or is no longer valid.',
  'web.org.projectInvalid': 'Choose a valid organization project.',
  'web.org.projectNotFound': 'Organization project not found.',
  'web.org.projectNotOwned': 'That project is not owned by this organization.',
  'web.org.projectArchivePermissionDenied':
    'You do not have permission to archive this organization project.',
  'web.org.projectArchiveFailed': 'The organization project could not be archived.',
  'web.invite.signInRequired': 'Sign in to accept this invitation.',
  'web.invite.acceptFailed': 'Could not accept the invitation.',
  'web.invite.acceptUnconfirmed': 'Could not accept the invitation. Please try again.',
  'web.invite.sessionMismatch': 'Session mismatch — please reload and try again.',
  'web.project.inviteWrongEmail':
    'This invitation was sent to a different email than the one on your account.',
  'web.project.inviteExpired': 'This invitation has expired or is no longer valid.',
  'web.directory.notConfigured': 'Directory setup is not configured in this environment.',
  'web.directory.setupBeginFailed': 'Could not begin directory setup.',
  'web.directory.setupOpenFailed': 'Could not open directory setup. Try again.',
  'web.directory.setupPermissionDenied': "You don't have permission to configure directory sync.",
  'web.directory.groupPermissionDenied': "You don't have permission to map directory groups.",
  'web.directory.groupRoleSaveFailed': 'Could not save the directory group role.',
  'web.registry.schemaNameInvalid':
    'Schema name and base kind must use lowercase letters, numbers, _ or -.',
  'web.registry.schemaDisplayNameLength': 'Schema display name must be 1–120 characters.',
  'web.registry.schemaFieldLimit': 'A schema may contain at most 100 field definitions.',
  'web.registry.schemaInvalid': 'Choose a valid Registry schema.',
  'web.registry.projectInvalid': 'Choose an existing containing project.',
  'web.registry.entityKindInvalid': 'Entity kind is invalid.',
  'web.registry.entityNameLength': 'Entity name must be 1–300 characters.',
  'web.registry.revisionInvalid': 'Choose a valid Registry record revision.',
  'web.registry.saveFailed': 'The Registry change could not be saved.',
  'web.share.accountChanged':
    'The signed-in account changed. Reload before accessing this workspace.',
  'web.share.serviceUnavailable': 'The share service is unavailable.',
  'web.share.forkFailed': 'The editable copy could not be created.',
  'web.share.forkCreateFailed': 'Could not create a private share fork.',
  'web.share.forkRateLimited': 'Too many share forks; try again shortly.',
  'web.share.revoked': 'This share has been revoked.',
  'web.share.expired': 'This share has expired.',
  'web.share.signInRequired': 'Sign in is required.',
  'web.share.notRecipient': 'This account cannot fork the share.',
  'web.share.notFound': 'Share not found.',
  'web.share.sourceChanged': 'The shared source changed after the fork.',
  'web.hackathon.nameRequired': 'Enter your full name',
  'web.hackathon.emailInvalid': 'Enter a valid email address',
  'web.hackathon.roleRequired': 'Choose your current role',
  'web.hackathon.expertiseRequired': 'Choose at least one area of expertise',
  'web.hackathon.trackRequired': 'Choose a track',
  'web.hackathon.experienceRequired': 'Describe one relevant experience in a few sentences',
  'web.hackathon.teamStatusRequired': 'Choose how you are applying',
  'web.hackathon.teammatesLength': 'Keep teammate names under 500 characters',
  'web.hackathon.linkedInInvalid': 'Enter a valid LinkedIn profile URL',
  'web.hackathon.linksInvalid': 'Enter up to 10 valid links, one per line',
  'web.hackathon.attendanceRequired': 'Confirm that you can participate in person',
  'web.hackathon.termsRequired': 'Acknowledge the applicant-data terms',
  'web.hackathon.rateLimited': 'Too many attempts. Try again later.',
  'web.hackathon.applicationReadFailed': 'Could not read application',
  'web.hackathon.receiptUnavailable': 'The application was saved, but its receipt is unavailable',
  'web.betaSignup.fullNameRequired': 'Full name is required.',
  'web.betaSignup.workContextRequired': 'What you work on is required.',
  'web.betaSignup.workflowRequired': 'A first workflow is required.',
  'web.betaSignup.platformRequired': 'Choose Mac, Windows, or Other.',
  'web.betaSignup.profileInvalid': 'Enter a valid X handle or X/LinkedIn profile URL.',
  'web.betaSignup.answersSaveFailed': 'Could not save your answers.',
} as const;

export type UserMessageKey = keyof typeof USER_MESSAGES;

export const USER_MESSAGE_TEMPLATES = {
  'project.entityMigrationSummary': '{count} project files need attention. {target}: {detail}',
  'alignment.selectMutationFrom': 'Select a mutation from {clone}.',
  'alignment.waitingForAlignment': 'Waiting for the alignment of {clone}.',
  'alignment.multiReadInput':
    '{file} contains {count} sequences. Clone comparison requires one sequence per file. Choose individual clone sequences or an assembled consensus; multi-read samples require NGS analysis first.',
  'account.invitesRevoked': '{count} pending invites they issued were revoked.',
  'assistant.notificationDetail': '{title}: {detail}',
  'registry.import.added': '{added} added{skipped}{flagged}',
  'registry.import.skipped': ', {count} skipped',
  'registry.import.flagged': ', {count} flagged',
  'registry.import.failed': 'failed — {reason}',
  'sheetSync.summary':
    '{created} created, {updated} updated, {unchanged} unchanged{conflicts}{localEdits}{missingRows}',
  'sheetSync.conflicts': ', {count} conflicting',
  'sheetSync.localEdits': ', {count} locally edited',
  'sheetSync.missingRows': ', {count} removed rows retained',
  'registry.schema.duplicateKey': 'Schema key already exists: {key}',
  'registry.schema.fieldNeedsChoice': '{label} needs at least one choice.',
  'assistant.actionNamed': '{action}',
  'assistant.actionSummary': '{detail}',
  'assistant.actionFieldValue': '{label}: {value}',
  'assistant.actionCompleted': '{action} completed',
  'navigation.askAgentShortcut': 'Ask Agent ({shortcut})',
  'registry.receipt.sequencesNotRegistered':
    '{count} sequences were imported; {failed} could not be registered. Review the saved files before retrying.',
  'registry.receipt.sequenceCountMismatch':
    '{count} sequences were imported, but {registered} were added to the Registry. Review the saved files before retrying.',
  'registry.receipt.summaryWithLinks': '{imported} entities, {links} links, {skipped} skipped',
  'registry.receipt.summary': '{imported} entities, {skipped} skipped',
  'registry.receipt.detailsWithLinks':
    '{imported} entities, {links} links, {skipped} skipped: {detail}',
  'registry.receipt.details': '{imported} entities, {skipped} skipped: {detail}',
  'registry.notice.importing-into': 'Importing into {value0}…',
  'registry.notice.imported-into': 'Imported {value0} into {value1}',
  'registry.notice.importing-into-1': 'Importing {value0} into {value1}…',
  'registry.notice.entities-0-links-skipped':
    '{value0} entities, 0 links, {value1} skipped{value2}{value3}',
  'registry.notice.entities-0-links-skipped-2':
    '{value0} entities, 0 links, {value1} skipped{value2}{value3}{value4}',
  'registry.notice.entities-were-saved-but-spreadsheet-provenance-failed':
    '{value0} entities were saved, but spreadsheet provenance failed: {value1}',
  'registry.notice.entities-links-skipped': '{value0} entities, {value1} links, {value2} skipped',
  'registry.notice.undid-import-entities-links-archived':
    'Undid import: {value0} entities, {value1} links archived',
  'registry.notice.replaced-the-registry-with-the-demo-dataset-entities-links':
    'Replaced the registry with the demo dataset: {value0} entities, {value1} links.',
  'registry.notice.replaced-the-registry-with-the-mock-primer-demo-oligos-hero-links-to-puc19-and-s':
    'Replaced the registry with the mock primer demo: {value0} oligos + hero links to pUC19 and S. cerevisiae chr IV.',
  'registry.notice.replaced-the-registry-with-the-practice-dataset-file-backed-synthetic-plasmids-p':
    'Replaced the registry with the practice dataset: {value0} file-backed synthetic plasmids + {value1} primers (interleaved over ~18 months) + {value2} strain/genome/chromosome entities (V. cholerae + E. coli, real RefSeq sequences).',
  'registry.notice.replaced-the-registry-with-the-starter-test-dataset-strains-genome-assemblies-16':
    'Replaced the registry with the starter test dataset: {value0} strains, {value1} genome assemblies, 16 yeast chromosomes, {value2} primers + lineage.',
  'registry.notice.couldn-t-find-in-the-registry': "Couldn't find {value0} in the Registry.",
  'registry.notice.records-registered-registrations-queued-for-organization-confirmation':
    '{value0} records registered; {value1} registrations queued for organization confirmation.',
  'registry.notice.registered-with-the-organization-keeping-the-same-identity-and-home-project':
    '{value0} {value1} registered with the organization, keeping the same identity and home project.',
  'registry.notice.was-placed-in': '{value0} was placed in {value1}.',
  'registry.notice.placement-was-queued-for-organization-sync':
    '{value0} placement was queued for organization sync.',
  'registry.notice.the-registry-placement-was-removed-from':
    'The Registry placement was removed from {value0}.',
  'record.restored': 'Restored {name}.',
  'record.reverted': 'Reverted {name} to its previous saved state.',
  'record.noPreviousVersion': 'No earlier version of {name} to undo.',
  'record.archived': 'Archived {name}. Toggle “Show archived” to restore it.',
  'edit.restoreNamedSequenceProject': 'Restore “{name}” from {location} to edit this sequence.',
  'edit.restoreSequenceProject':
    'Restore this sequence’s project from {location} to edit this sequence.',
  'edit.namedReferenceFolder':
    'This sequence is in “{name}”, a reference folder. Copy it into a project to edit it.',
  'reference.projectOwnerMissing': 'Couldn\'t identify the project that owns "{label}".',
  'reference.projectAmbiguous':
    '"{label}" exists in more than one open project, so this link is ambiguous.',
  'reference.projectEntryMissing': '"{label}" isn\'t in any open project.',
  'reference.registryEntryMissing': 'Couldn\'t find "{label}" in the Registry.',
  'reference.projectEntryDuplicated': '"{label}" exists in more than one open project.',
  'reference.entryNotFound': 'Couldn\'t find "{label}" in any open project.',
  'assembly.junctionInvalid':
    'Junction {junction} is invalid. Check its settings before continuing.',
  'link.refusal.refused-to-open-value0-outside-its-project':
    'Refused to open "{value0}" outside its project.',
  'assembly.finding.junction-value0-has-value1-bp-homology-supported-range-is-value2-value3-bp':
    'Junction {value0} has {value1} bp homology; supported range is {value2}-{value3} bp.',
  'assembly.finding.junction-value0-has-value1-bp-homology-preferred-range-is-value2-value3-bp':
    'Junction {value0} has {value1} bp homology; preferred range is {value2}-{value3} bp.',
  'assembly.finding.junction-value0-homology-tm-is-value1-c-target-is-near-value2-c':
    'Junction {value0} homology Tm is {value1} C; target is near {value2} C.',
  'assembly.finding.junction-value0-gc-content-is-value1':
    'Junction {value0} GC content is {value1}%.',
  'assembly.finding.-value0-has-a-value1-bp-binding-site-available-template-range-is-value2-value3-bp':
    '{value0} has a {value1} bp binding site; available template range is {value2}-{value3} bp.',
  'assembly.finding.-value0-has-a-value1-bp-binding-site-preferred-range-is-value2-value3-bp':
    '{value0} has a {value1} bp binding site; preferred range is {value2}-{value3} bp.',
  'assembly.overhang.duplicate-overhang-value0': 'Duplicate overhang: {value0}',
  'assembly.overhang.palindromic-overhang-value0-risk-of-self-ligation':
    'Palindromic overhang: {value0} (risk of self-ligation)',

  'primer.scopeChromosomeUnknown': '{chromosome} is not a chromosome of this reference.',
  'primer.scopeChromosomeLength': '{chromosome} is {length} bp long.',
  'primer.scopeLength':
    '{interval} is {length} bp; search up to {maximum} bp at a time. Zoom in, select a region, or enter an interval to search.',
  'tracks.addNamed': 'Add {track}',
  'file.deleteUnconfirmed':
    'Could not confirm deletion of {items}. Reopen the project before retrying.',
  'file.trashFailed': 'Could not move {items} to Trash. No files were deleted.',
  'import.multipleRecordsCount':
    'This FASTA contains {count} sequences. Import the records as separate DNA sequences.',
  'file.trashPartial':
    'Could not move all selected items to Trash. {moved} moved; the rest were left in place.',
  'tracks.statusLoaded': '{count} loaded',
  'tracks.statusLoadedOfTotal': '{count} of {total} loaded',
  'tracks.statusNotDrawn': 'Not drawn: {reason}',

  'compute.bad_credential':
    '{provider} rejected this key. Check that it was copied completely and has not been revoked.',
  'compute.budget_exhausted': "{provider} says this account's budget or credits are used up.",
  'compute.rate_limited': '{provider} is rate-limiting requests. Wait a moment and try again.',
  'compute.provider_unavailable':
    '{provider} could not be reached. It may be down or your network may be blocking it.',
  'compute.circuit_open':
    '{provider} failed several times in a row; DNAForge is pausing requests briefly.',
  'compute.mapped_tool_missing':
    'The operations available from {provider} changed. Update DNAForge or contact support.',
  'compute.invalid_settings': '{provider} rejected the job settings.',
  'compute.unknown_job': '{provider} has no record of that job.',
  'compute.missing_credential': 'No {provider} key is connected.',
  'compute.bad_key_format': 'Check the format of your {provider} key.',
  'compute.provider_error': '{provider} returned an error. Try again.',

  'recovery.saveChanges':
    'Save your changes in {documents} before creating a recovery copy. Unsaved edits cannot be included in a disk checkpoint.',
  'recovery.copyCreated':
    'The recovery copy was created at {directory}. Open that folder to find it.',
  'sequence.invalidCharacter':
    'This file could not be read as a sequence. Line {line}: Invalid sequence character {character} at column {column}',
  'recovery.downloadStarted': 'Download started for {file}. Your project was not changed.',
  'jobs.batchFailedOne': '{count} batch item failed',
  'jobs.batchFailedMany': '{count} batch items failed',
  'jobs.batchInterruptedOne': '{count} batch item was interrupted',
  'jobs.batchInterruptedMany': '{count} batch items were interrupted',
  'jobs.batchUncertainOne': '{count} batch item has uncertain status',
  'jobs.batchUncertainMany': '{count} batch items have uncertain status',
  'jobs.batchReviewOne': '{count} batch item needs review',
  'jobs.batchReviewMany': '{count} batch items need review',
  'genome.loadingSource': '{file}{details}',
  'genome.indexingSource': '{file}{details} — first-time indexing can take a few minutes',
  'reference.chromosomeMismatch':
    'Reference {reference} has a different chromosome table than the one this view was saved against. DNAForge refused to open the view on a different assembly.',
  'assembly.slotId': 'Slot {index} needs an ID.',
  'assembly.slotDuplicate': 'Slot ID “{slot}” is used more than once.',
  'assembly.slotLabel': 'Slot {index} needs a label.',
  'assembly.roleEmpty': 'Slot “{slot}” has an empty preferred role.',
  'assembly.overhangLength': '{enzyme} overhangs must be {length} bases long.',
  'assembly.overhangAlphabet': 'Overhang “{overhang}” must contain concrete DNA bases.',
  'assembly.junctionMissing': '“{position}” has no junction yet; {enzyme} needs {length} bases.',
  'assistant.modelUnavailable':
    'The selected model “{model}” is no longer available. Choose an available model or the provider default, then try again.',
  'assistant.reasoningUnavailable':
    'The selected model “{model}” does not support the “{effort}” reasoning effort.',
  'assistant.tierUnavailable':
    'The selected model “{model}” does not support the “{tier}” service tier.',
  'assistant.personalityUnavailable':
    'The selected model “{model}” does not support response personality.',
  'assistant.hostedNotReady': 'DNAForge AI cannot send because: {reason}.',
  'primer.saturationMissingFlanks':
    'Residue {residue} needs {flank} template bases on both sides. Include flanking DNA or choose an internal residue.',
  'primer.saturationStop':
    'Position {residue} is a stop codon. Select amino-acid residues without the terminal stop.',
  'assistant.providerApi': '{provider} API',
  'assistant.routeTitle': '{route} / {detail}',
  'sequenceImport.plainFile':
    '1 sequence file was kept as plain files: {names}. Open one to see why and convert it.',
  'sequenceImport.plainFiles':
    '{count} sequence files were kept as plain files: {names}{more}. Open one to see why and convert it.',
  'sequenceImport.additionalFiles': ' and {count} more',
  'importResult.summary': '{summary}',
  'importResult.summaryIntoProject': '{summary} into "{project}"',
  'importResult.alreadyImported': 'Already imported — {details}',
  'document.verificationFailed':
    '“{name}” could not be opened because its project record could not be verified. Reopen the project, then try again. Your file is preserved.',
  'document.namedOpenFailed': '“{name}” could not be opened. Your file is preserved.',
  'sequenceSearch.switchToAnnotations': 'DNA bases search. Click for AA/features ({shortcut})',
  'sequenceSearch.switchToBases': 'AA and feature search. Click for DNA bases ({shortcut})',
  'reference.locationMissing': 'Couldn’t find “{label}” at its saved location.',
  'reference.locationUnavailable': 'The saved location for “{label}” can’t be reached.',
  'reference.unreadable': '“{label}” is no longer a readable {kind}.',
  'reference.originUnrecoverable': 'DNAForge can’t recover the saved location for “{label}”.',
  'reference.originRestoreFailed': 'DNAForge couldn’t restore the saved location for “{label}”.',
  'reference.openFailed': 'DNAForge found “{label}” but couldn’t open it.',
  'primer.incompatibleModificationType':
    '{code} cannot be used with this oligo type. Choose a compatible modification or change the oligo type.',
  'primer.sequenceTooShort': 'Enter at least {count} bases.',
  'primer.sequenceTooLong': 'Use no more than {count} bases.',
  'primer.invalidBasePosition': 'Invalid base at position {position}.',
  'primer.requiredField': 'Enter {field}.',
  'sharing.people.invitation-sent-to-value0': 'Invitation sent to {value0}.',
  'sharing.people.invitation-saved-for-value0-email-delivery-is-queued-and-will-retry-automatically':
    'Invitation saved for {value0}. Email delivery is queued and will retry automatically.',
  'sharing.people.invitation-saved-for-value0-email-delivery-could-not-be-confirmed-you-can-share-the-invitation-link':
    'Invitation saved for {value0}. Email delivery could not be confirmed. You can share the invitation link.',
  'sharing.people.invitation-saved-for-value0-email-could-not-be-sent-so-the-invite-link-was-copied-for-you-to-share':
    'Invitation saved for {value0}. Email could not be sent, so the invite link was copied for you to share.',
  'sharing.people.invitation-saved-for-value0-but-the-email-could-not-be-sent':
    'Invitation saved for {value0}, but the email could not be sent.',
  'sharing.people.invitation-resent-to-value0': 'Invitation resent to {value0}.',
  'sharing.people.a-fresh-invitation-was-created-for-value0-email-delivery-is-queued-and-will-retry-automatically':
    'A fresh invitation was created for {value0}. Email delivery is queued and will retry automatically.',
  'sharing.snapshotCopied':
    'Snapshot link copied{version}. Anyone with this link can view and download this snapshot.',
  'sharing.snapshotCopyFailed':
    'Snapshot pinned{version}, but copying the link failed. Copy it manually: {url}',
  'compute.submitTitle': 'Send a job to {provider}?',
  'compute.submitConsent':
    '{actor} “{tool}” on {provider} with {submission}. This is sent under your {provider} account and billed to it. {cost} Further jobs this session proceed without asking until the session budget is reached.',
  'compute.submissionSummary':
    'Sequences: {sequences} ({residues} residues); files: {files} ({bytes} bytes); other settings: {settings}',
  'compute.costEstimate': 'Estimated cost: {amount} {unit}.',
  'clipboard.geneticCodeNotice':
    'These bases came from coding sequence read by genetic code {source}. This file uses {destination}, so any coding feature you draw over them here will translate differently.',
  'clipboard.geneticCodePreserved':
    'Pasted {features} read by genetic code {source}, into a file that uses {destination}. The pasted {ownership} own code, so the protein is unchanged.',
  'clipboard.geneticCodeCustom':
    "Pasted {features} read by genetic code {source}, into a file that uses {destination}. A custom code cannot travel with a feature, so {subject} now read by this file's code and may encode a different protein.",
  'registry.partialImport':
    'Registered {count} {entities} before the remaining import failed. The saved records are available; you can undo this import.',
  'tools.progress': '{name}: {phase}',
  'auth.emailWait':
    'Please wait {duration} before requesting another code, or continue with Google or GitHub.',
  'primer.updateAttachedConfirm':
    'This primer has {sites} binding sites on {sequences} sequences. Changing its bases or modifications updates the shared primer used at these sites. Review their matches after saving.',
  'primer.updateAttachedConfirmOneSite':
    'This primer has {sites} binding site on {sequences} sequence. Changing its bases or modifications updates the shared primer used at these sites. Review their matches after saving.',
  'primer.updateAttachedConfirmOneSequence':
    'This primer has {sites} binding sites on {sequences} sequence. Changing its bases or modifications updates the shared primer used at these sites. Review their matches after saving.',
  'file.purgeConfirm':
    'Permanently delete "{path}" from File Trash in "{project}"? This cannot be undone.',
  'project.archiveConfirm':
    'Archive "{name}"? It moves to your Archived projects — you can restore it anytime, and nothing is deleted.',
  'project.trashConfirm':
    'Move "{name}" to Trash? Projects without retained records or history may be permanently deleted after 30 days. The original project is kept. You can restore a project while it remains in Trash. Your original folder is never touched.',
  'project.renamePrompt': 'Choose a new name for "{name}". Files and history stay where they are.',
  'genome.queryLimit': 'Annotation queries are limited to {count} characters.',
  'sequence.enzymesMissing': 'Digest source enzymes are not in the enzyme catalog: {names}',
  'menu.openFailed': 'Could not open {name}. Try again.',
  'document.quickLookOpenFailed': 'Could not open “{name}”.',
  'document.quickLookOpenFailedBecause': 'Could not open “{name}”. {reason}',
  'assistant.attachmentLimit': 'You can attach at most {count} files to one turn.',
  'assistant.attachmentSizeLimit':
    'AI attachments must be {limit} bytes or smaller; this file is {size} bytes.',
  'assistant.keyMissing': 'Add an API key for {provider} in Settings before continuing.',
  'primer.attachFailed': 'Could not attach {name}. Try again.',
  'primer.detachFailed': 'Could not detach {name}. Try again.',
  'structure.invalidIdentifier': 'Invalid {source} format',
  'structure.pdbMissing': 'PDB ID "{id}" not found',
  'structure.alphaFoldMissing': 'UniProt ID "{id}" not found in AlphaFold',
  'document.importedOpenFailed':
    'Imported “{name}” to {path}, but DNAForge could not open the destination. The saved package will be reused when you retry.',
  'sharing.importReview':
    '{files} files and {conversations} conversations.\nNew project: {project}\nLocation: {location}\nAccount: {account}\nThis creates a private copy. Changes will not affect the sender.',
  'sharing.importOpened':
    'Imported as a private local fork. Changes do not affect the sender.\n\nOpened “{project}” as a new local project. Enable cloud backup if you want it on this account.',
  'sharing.importOpenedWithNotices':
    'Imported as a private local fork. Changes do not affect the sender.\n\nOpened “{project}” as a new local project. Enable cloud backup if you want it on this account.\n\nImport notices: {count}. Review the imported project before continuing.',
  'sharing.openedWithNoticeCount':
    'The project opened with {count} notices. Review the project before continuing.',
  'permissions.hiddenDevelopment': 'Development and test callers: {count} hidden.',
  'primer.invalidPlacement': '{code} can only be used at the {position}.',
  'primer.internalPlacement': '{code} can only be used between two bases.',
  'clipboard.copiedSequence': 'Copied {sequence}',
  'assistant.roundIncomplete': 'Round incomplete: {completed}/{required} required saved runs.',
  'validation.fieldMax': '{field} must be at most {limit}.',
  'validation.fieldMin': '{field} must be at least {limit}.',
  'validation.fieldRequired': '{field} is required.',
  'validation.fieldInvalid': 'Check the value for {field}.',
  'primer.unknownModification': 'Unknown IDT modification /{code}/.',

  'dialog.unsavedSaveQuestion': 'Save your changes before you {action}{purpose}?',
  'dialog.unsavedManualSave':
    'Save your work with {shortcut} before you {action}{purpose}, or {action} anyway and lose the changes.',
  'dialog.unsavedSave': 'Save and {action}',
  'dialog.unsavedAnyway': '{action} Anyway',

  'approval.commandScope': '{programs} commands',
  'approval.writeScope': 'changes in {folder}',
  'approval.runTool': 'Allow DNAForge AI to run {tool}',

  'primer.recoverySummary':
    'Primer recovery couldn’t finish{subject} ({count} {noun}). {detail} Your existing records have been preserved.',
  'primer.projectRecoveryNeeded':
    '{count} saved {noun} need their original project identified. Choose that project to restore them. Your records are preserved.',
  'document.conflictSummary':
    '{count} document {noun}: {target} differs from the application copy. Both versions are retained. Compare them before saving or retrying.',
  'document.savedUpdateFailed':
    '{name} was saved, but the project could not finish updating. Reopen the document to check the saved content.',
  'document.saveLocationChanged':
    "Couldn't save {name}. The document location changed. Your changes are still open. Restore its original location and try Save again.",
  'document.savePermissionDenied':
    "Couldn't save {name}. Your changes are still open. Check its write permission.",
  'document.savedVerificationFailed':
    '{name} was written, but Save could not verify it. Your changes remain open. Try Save again.',
  'notice.webgl-trace-saved-value': 'WebGL trace saved → {value0}',
  'notice.cpu-profile-saved-valuems-value': 'CPU profile saved ({value0}ms) → {value1}',
  'notice.you-can-t-archive-value-it-s-your-only-project-and-dnaforge-always-kee':
    'You can\'t archive "{value0}" — it\'s your only project, and DNAForge always keeps at least one open. Open another project first.',
  'notice.couldn-t-archive-value-it-isn-t-a-managed-project-yet':
    'Couldn\'t archive "{value0}" — it isn\'t a managed project yet.',
  'notice.value-isn-t-inside-an-open-project-so-dnaforge-didn-t-attach-it':
    '“{value0}” isn’t inside an open project, so DNAForge didn’t attach it.',
  'notice.couldn-t-restore-value-its-project-record-is-missing':
    'Couldn\'t restore "{value0}" — its project record is missing.',
  'notice.couldn-t-restore-value-it-may-already-be-purged':
    'Couldn\'t restore "{value0}" — it may already be purged.',
  'notice.value-was-already-removed': '"{value0}" was already removed.',
  'notice.imported-value-to-edit': 'Imported “{value0}” to edit.',
  'notice.imported-all-value-records-from-value-to-edit':
    'Imported all {value0} records from “{value1}” to edit.',
  'notice.value-assembly-primervalue-could-not-be-recorded':
    '{value0} assembly primer{value1} could not be recorded',
  'notice.opened-value': 'Opened {value0}.',
  'notice.combined-changes-from-value-with-yours-syncing-now':
    'Combined changes from {value0} with yours. Syncing now.',
  'notice.recovered-accepted-history-in-a-separate-profile-at-value-opening-inst':
    'Recovered accepted history in a separate profile at {value0}. Opening instructions are in its recovery folder. {value1} working draft files are in {value2}.{value3}',
  'notice.created-value': 'Created {value0}.',
  'notice.invited-value': 'Invited {value0}.',
  'notice.invite-copied-for-value': 'Invite copied for {value0}.',
  'notice.invited-value-email-was-not-sent': 'Invited {value0}. Email was not sent.',
  'notice.deleted-value': 'Deleted {value0}.',
  'notice.value-finished-on-value-import-it-into-your-workspace':
    '{value0} finished on {value1}. Import it into your workspace?',
  'notice.deep-share-published-and-link-copied-version-value':
    'Deep Share published and link copied. Version {value0}.',
  'notice.saved-value': 'Saved {value0}.',
  'notice.dnaforge-is-now-the-default-app-for-value-files':
    'DNAForge is now the default app for {value0} files.',
  'notice.choose-a-value-file-value': 'Choose a {value0} file ({value1}).',
  'notice.registered-value-valuevalue-to-the-registry':
    'Registered {value0} {value1}{value2} to the registry.',
  'notice.unsaved-changes-to-value-were-recovered': 'Unsaved changes to "{value0}" were recovered.',
  'notice.created-primer-value': 'Created primer {value0}.',
  'notice.saved-primer-value': 'Saved primer {value0}.',
  'notice.created-protein-value': 'Created protein {value0}.',
  'notice.copied-value-residues': 'Copied {value0} residues',
  'notice.the-indexed-source-for-value-is-not-available':
    'The indexed source for {value0} is not available.',
  'notice.copied-value-value-value': 'Copied {value0} {value1} · {value2}',
  'notice.failed-to-write-the-transcript-value-to-the-clipboard':
    'Failed to write the transcript {value0} to the clipboard.',
  'notice.copied-value-amino-acids': 'Copied {value0} amino acids',
  'notice.registered-protein-value-value-at-value':
    'Registered protein {value0} ({value1}) at {value2}',
  'notice.deleted-annotation-value': 'Deleted annotation {value0}',
  'notice.added-annotation-value': 'Added annotation {value0}',
  'notice.updated-annotation-value': 'Updated annotation {value0}',
  'notice.converted-the-file-but-value-of-its-value-sequences-could-not-be-opene':
    'Converted the file, but {value0} of its {value1} sequences could not be opened.',
  'notice.copied-value-bp-value': 'Copied {value0} bp · {value1}',
  'notice.value-was-saved-but-copied-primer-bindings-could-not-be-attached-save-':
    '{value0} was saved, but copied primer bindings could not be attached. Save again to retry, or discard your pending changes.',
  'notice.couldn-t-save-value-your-changes-are-still-open-try-saving-again-or-di':
    "Couldn't save {value0}. Your changes are still open. Try saving again, or discard your changes.",
  'notice.value-has-an-unsaved-native-draft-from-an-earlier-session':
    '{value0} has an unsaved native draft from an earlier session.',
  'notice.unsaved-changes-to-value-from-a-window-that-closed-unexpectedly-can-t-':
    "Unsaved changes to {value0} from a window that closed unexpectedly can't be restored, because the file changed since.",
  'notice.value-has-unsaved-changes-from-a-window-that-closed-unexpectedly':
    '{value0} has unsaved changes from a window that closed unexpectedly.',
  'notice.this-record-s-source-says-value-but-no-feature-declares-a-genetic-code':
    'This record\'s source says "{value0}" but no feature declares a genetic code, and organelles use several. Translations use the standard code until you set one — the "Genetic code" control above the sequence has the list.',
  'notice.value-shell-exited-with-code-value': '{value0}: shell exited with code {value1}.',
  'notice.make-dnaforge-the-default-app-for-value-files':
    'Make DNAForge the default app for {value0} files?',
  'notice.couldn-t-show-value-because-its-project-is-unavailable':
    'Couldn\'t show "{value0}" because its project is unavailable.',
  'notice.updated-to-vvalue-see-what-changed': 'Updated to v{value0}. See what changed.',
  'notice.dev-build-vvalue-update-checks-are-disabled-in-development':
    'Dev build (v{value0}). Update checks are disabled in development.',
  'notice.dnaforge-is-up-to-date-vvalue': 'DNAForge is up to date (v{value0}).',
  'notice.update-vvalue-ready-restart-to-apply': 'Update v{value0} ready. Restart to apply.',
  'notice.couldn-t-read-value': 'Couldn\'t read "{value0}".',
  'notice.imported-value-but-couldn-t-open-it-it-remains-in-the-project':
    'Imported "{value0}", but couldn\'t open it. It remains in the project.',
  'notice.you-can-t-move-value-to-trash-it-s-your-only-project-and-dnaforge-alwa':
    'You can\'t move "{value0}" to Trash — it\'s your only project, and DNAForge always keeps at least one open. Open another project first.',
  'notice.couldn-t-trash-value-it-isn-t-a-managed-project-yet':
    'Couldn\'t trash "{value0}" — it isn\'t a managed project yet.',
  'notice.moved-value-to-trash': 'Moved "{value0}" to Trash.',
  'notice.primer-file-value-couldn-t-be-added-to-your-primer-registry-it-may-be-':
    'Primer file "{value0}" couldn\'t be added to your primer registry. It may be malformed or a duplicate; fix or remove it, then reopen the project.',
  'notice.value-primer-files-couldn-t-be-added-to-your-primer-registry-e-g-value':
    '{value0} primer files couldn\'t be added to your primer registry (e.g. "{value1}"). They may be malformed or duplicates; fix or remove them, then reopen the project.',
  'notice.unsaved-new-value-value-from-a-window-that-closed-unexpectedly':
    'Unsaved new {value0} "{value1}" from a window that closed unexpectedly.',
  'notice.signed-in-as-value': 'Signed in as {value0}',
  'notice.couldn-t-move-value': 'Couldn\'t move "{value0}".',
  'notice.please-analyze-the-attached-value': 'Please analyze the attached {value0}.',
  'notice.save-failed-value': ' · save failed: {value0}',
  'notice.couldn-t-rename-value': 'Couldn\'t rename "{value0}".',
  'notice.value-model-discovery-failed': '{value0} model discovery failed',
  'notice.paste-value-into-the-assembly-as-a-part': 'Paste {value0} into the assembly as a part',
  'notice.registry-id-value': 'Registry ID {value0}',
  'notice.value-of-valuevalue': '{value0} of {value1}{value2}',
  'notice.source-suggests-value-oligo-used-as-value':
    'Source suggests {value0} oligo, used as {value1}.',
  'copy.declared-by-value': 'declared by {value0}',
  'copy.value-internal-cutvalue': '{value0} internal cut{value1}',
  'copy.details-value': 'Details: {value0}',
  'copy.left-local-value': 'Left local: {value0}.',
  'copy.value-compatible': '{value0} compatible',
  'copy.model-value': 'Model: {value0}',
  'tools.updatingCount': '{count} updating / {total} tools',
  'tools.attentionCount': '{count} need attention / {total} tools',
  'tools.readyCount': '{count}/{total} tools ready',
  'fileAssociations.other': 'Default: {name}',
  'dialog.archive-value-it-moves-to-your-archived-projects-you-can-restore-it-an':
    'Archive "{value0}"? It moves to your Archived projects — you can restore it anytime, and nothing is deleted.',
  'dialog.permanently-delete-value-the-original-project-and-projects-with-retain':
    'Permanently delete "{value0}"? The original project and projects with retained records or history are kept. If deletion is allowed, its managed copy is removed now and can\'t be restored. (Your original folder is never touched.)',
  'dialog.the-assistant-wants-to-run-value-this-can-change-files-or-designs-in-t':
    'The assistant wants to run {value0}. This can change files or designs in the current project.',
  'dialog.remove-value-and-value-combined-value-on-it':
    'Remove “{value0}” and {value1} combined {value2} on it?',
  'dialog.are-you-sure-you-want-to-remove-value-from-this-view':
    'Are you sure you want to remove “{value0}” from this view?',
  'dialog.send-ctrl-c-to-the-foreground-program-in-value':
    'Send Ctrl+C to the foreground program in “{value0}”?',
  'dialog.value-run-this-command-with-jobs-help-to-discover-and-manage-tracked-w':
    '{value0}\n\nRun this command with jobs --help to discover and manage tracked work. For optional installation, use install-cli --bin-dir DIRECTORY. Choose your own command directory and PATH settings.',
  'dialog.opened-value': 'Opened “{value0}”',
  'dialog.import-value-as-a-private-fork': 'Import “{value0}” as a private fork?',
  'dialog.next-run-value-required-outputs-value-the-exact-source-instructions-an':
    'Next run: {value0}\nRequired outputs: {value1}\n\nThe exact source, instructions and scope will be frozen with your approval.',
  'dialog.you-have-unsaved-changes-in-value': 'You have unsaved changes in {value0}.',
  'dialog.dnaforge-couldn-t-save-value': "DNAForge couldn't save {value0}.",
  'dialog.unsavedSaveFailure':
    '{failures}\n\nCancel to keep working and try saving again, or {action} without them.',
  'dialog.cancel-to-keep-working-and-try-saving-again-or-value-without-them':
    'Cancel to keep working and try saving again, or {value0} without them.',
  'dialog.there-are-unsaved-changes-in-value-unsaved-edits-cannot-be-included-in':
    'There are unsaved changes in {value0}. Unsaved edits cannot be included in a disk checkpoint. Save them, then open Scientific Storage Recovery again.',
  'dialog.recovery-copies-the-saved-project-and-database-profile-from-the-pre-en':
    'Recovery copies the saved project and database profile from the pre-enrollment checkpoint. It also preserves the current saved project, database and Git history separately. Your original project remains active and unchanged. It does not replace the application or switch your current profile.\n\nProjects with recovery checkpoints:\n{value0}',
  'dialog.create-a-recovery-copy-of-value': 'Create a recovery copy of “{value0}”?',
  'dialog.recovered-project-value-isolated-database-profile-value-your-original-':
    'Recovered project:\n{value0}\n\nIsolated database profile:\n{value1}\n\nYour original project remains active. Its current saved work and Git history are preserved separately in the recovery folder. Read the recovery folder instructions before opening the isolated copy with a compatible application.',
  'dialog.switch-to-value': 'Switch to {value0}?',
  'dialog.free-port-value': 'Free port {value0}?',
  'dialog.value-without-saving': '{value0} Without Saving',
} as const;

declare const userMessageBrand: unique symbol;
declare const entityLabelBrand: unique symbol;
declare const messageValueBrand: unique symbol;

export type UserMessage = string & { readonly [userMessageBrand]: true };
export type UserMessageValue = string & { readonly [messageValueBrand]: true };
export type UserEntityLabel = UserMessageValue & { readonly [entityLabelBrand]: true };
export type UserVisibleText = UserMessage | UserEntityLabel | UserMessageValue;
type TemplateKey = keyof typeof USER_MESSAGE_TEMPLATES;
type TemplateParameters<T extends string> = T extends `${string}{${infer Key}}${infer Rest}`
  ? Key | TemplateParameters<Rest>
  : never;

const publicTexts = new Set<string>(
  Object.values(USER_MESSAGES).filter((text: string) => text.trim().length > 0)
);
const issuedTexts = new Set<string>();

export function isUserMessageKey(value: unknown): value is UserMessageKey {
  return typeof value === 'string' && hasOwn(USER_MESSAGES, value);
}

export function userMessage(key: UserMessageKey): UserMessage {
  return (
    isUserMessageKey(key) ? USER_MESSAGES[key] : USER_MESSAGES['operation.failed']
  ) as UserMessage;
}

export function renderUserMessage<T extends UserVisibleText | null | undefined>(message: T): T {
  return message;
}

export function userMessageResponse(key: UserMessageKey, code: string) {
  return { error: code, code, userMessageKey: key, message: userMessage(key) };
}

const internalEntityId =
  /^(?:[a-z]+[:/])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9.]+)?$/iu;

const toolLabels: Readonly<Record<string, UserMessageKey>> = {
  alphafold: 'compute.alphaFold',
  esmfold: 'compute.esmFold',
  'boltz-2': 'compute.boltz2',
  list_files: 'assistant.listFiles',
  read_file: 'assistant.readFile',
  find_features: 'assistant.findFeatures',
  get_workspace: 'assistant.projectOverview',
  'workspace.metadata_read': 'assistant.projectOverview',
  get_file_changes: 'assistant.fileChanges',
  open_tab: 'assistant.openDocument',
  close_tab: 'assistant.closeDocument',
  create_reference: 'assistant.createReference',
  observe_app_state: 'assistant.inspectAppState',
  Bash: 'assistant.runCommand',
};

export function userToolLabel(
  key: unknown,
  fallback: UserMessageKey = 'assistant.action'
): UserMessage {
  const canonical =
    typeof key === 'string' ? key.replace(/^mcp__[A-Za-z0-9][A-Za-z0-9_.-]*?__/u, '') : '';
  const issuedKey = Object.values(toolLabels).find(
    (labelKey) => userMessage(labelKey) === canonical
  );
  if (issuedKey) return userMessage(issuedKey);
  if (hasOwn(toolLabels, canonical)) return userMessage(toolLabels[canonical]);
  if (fallback !== 'assistant.action') return userMessage(fallback);
  if (
    !/^[A-Za-z][A-Za-z0-9]*(?:[._:-]+[A-Za-z0-9]+)*$/u.test(canonical) ||
    hasInternalDiagnostic(canonical) ||
    internalEntityId.test(canonical) ||
    /^(?:sk-|claude-)/iu.test(canonical)
  )
    return userMessage(fallback);
  const words = canonical
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[._:-]+/gu, ' ')
    .toLowerCase();
  return userMessageWithValues('assistant.actionNamed', {
    action: userMessageValue((words[0].toUpperCase() + words.slice(1)).slice(0, 160)),
  });
}

function hasInternalDiagnostic(value: string): boolean {
  return /\b(?:VITE_|NEXT_PUBLIC_|DNAFORGE_|WAYPOINT_|SUPABASE_|DATABASE_URL|API_URL)[A-Z0-9_]*\b|\b(?:platform|electronAPI|lims|db)\.[\w$.]+|\b[A-Za-z_$][\w$]*\.[a-zA-Z_$][\w$]*\(|\b[A-Z]\w*(?:Error|Exception)\b|\bat \S+ \([^\n]+:\d+:\d+\)|[\r\n]/u.test(
    value
  );
}

export function userMessageValue(value: unknown): UserMessageValue {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  return (
    (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) &&
    !hasInternalDiagnostic(text) &&
    !internalEntityId.test(text.trim())
      ? text
      : userMessage('document.untitled')
  ) as UserMessageValue;
}

export function userMessageWithValues<K extends TemplateKey>(
  key: K,
  values: Record<TemplateParameters<(typeof USER_MESSAGE_TEMPLATES)[K]>, UserMessageValue>
): UserMessage {
  if (!hasOwn(USER_MESSAGE_TEMPLATES, key)) return userMessage('operation.failed');
  const template: string = USER_MESSAGE_TEMPLATES[key];
  const message = template.replace(/\{([^}]+)\}/gu, (_match, name: keyof typeof values) =>
    userMessageValue(values[name])
  );
  if (issuedTexts.size >= 2048) issuedTexts.delete(issuedTexts.values().next().value!);
  issuedTexts.add(message);
  return message as UserMessage;
}

// ES2020-compatible Object.hasOwn .
function hasOwn(target: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

export class UserMessageError extends Error {
  readonly userMessageKey: UserMessageKey;

  // ES2020-compatible : consumers compile with lib ES2020, so no
  // ErrorOptions / two-arg Error. `cause` is defined like the native one.
  constructor(key: UserMessageKey, options?: { cause?: unknown }) {
    super(userMessage(key));
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    this.name = 'UserMessageError';
    this.userMessageKey = isUserMessageKey(key) ? key : 'operation.failed';
  }
}

export function toUserMessage(
  failure: unknown,
  fallback: UserMessageKey = 'operation.failed'
): UserMessage {
  if (typeof failure === 'string') {
    if (publicTexts.has(failure) || issuedTexts.has(failure)) return failure as UserMessage;
  }
  try {
    if (failure instanceof Error && 'userMessagePayload' in failure) {
      return renderUserMessagePayload(failure.userMessagePayload as UserMessagePayload);
    }
    if (failure !== null && typeof failure === 'object' && 'userMessageKey' in failure) {
      const key = (failure as { userMessageKey: unknown }).userMessageKey;
      if (isUserMessageKey(key)) return userMessage(key);
    }
    if (failure !== null && typeof failure === 'object' && 'code' in failure) {
      const code = (failure as { code: unknown }).code;
      if (code === 'ENOENT' || code === 'NOT_FOUND') return userMessage('file.notFound');
      if (code === 'EACCES' || code === 'EPERM' || code === 'FORBIDDEN')
        return userMessage('file.permissionDenied');
      if (code === 'ENOTDIR') return userMessage('file.notFolder');
      if (code === 'UNAUTHENTICATED') return userMessage('account.signInRequired');
    }
    if (
      failure instanceof Error &&
      !('userMessagePayload' in failure) &&
      !('userMessageKey' in failure) &&
      !('code' in failure)
    ) {
      const message = Object.getOwnPropertyDescriptor(failure, 'message')?.value;
      if (typeof message === 'string' && publicTexts.has(message)) return message as UserMessage;
    }
  } catch {}
  return userMessage(fallback);
}

export function userEntityLabel(
  value: unknown,
  fallback:
    | 'project.untitled'
    | 'document.untitled'
    | 'document.untitledSequence'
    | 'identity.user'
    | 'identity.agent'
    | 'identity.service' = 'document.untitled'
): UserEntityLabel {
  const name = typeof value === 'string' ? value.trim() : '';
  const internalId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
  return (
    name && !internalId.test(name) && !hasInternalDiagnostic(name) ? name : userMessage(fallback)
  ) as UserEntityLabel;
}

export function toOptionalUserMessage<T>(
  failure: T,
  fallback: UserMessageKey = 'operation.failed'
): T extends null | undefined ? T : UserMessage {
  return (failure == null ? failure : toUserMessage(failure, fallback)) as T extends
    | null
    | undefined
    ? T
    : UserMessage;
}

declare const userMessagePayloadBrand: unique symbol;
export type UserMessagePayload = {
  readonly key: UserMessageKey | TemplateKey;
  readonly values?: Readonly<Record<string, UserMessageValue>>;
  readonly [userMessagePayloadBrand]: true;
};

export type UserMessageInput = UserMessage | UserMessagePayload;

export function isUserMessagePayload(value: unknown): value is UserMessagePayload {
  try {
    if (!value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string')
      return false;
    if (isUserMessageKey(value.key)) return !('values' in value) || value.values === undefined;
    return (
      hasOwn(USER_MESSAGE_TEMPLATES, value.key) &&
      'values' in value &&
      value.values !== null &&
      typeof value.values === 'object'
    );
  } catch {
    return false;
  }
}

export function userMessagePayload(key: UserMessageKey): UserMessagePayload;
export function userMessagePayload<K extends TemplateKey>(
  key: K,
  values: Record<TemplateParameters<(typeof USER_MESSAGE_TEMPLATES)[K]>, UserMessageValue>
): UserMessagePayload;
export function userMessagePayload(
  key: UserMessageKey | TemplateKey,
  values?: Readonly<Record<string, UserMessageValue>>
): UserMessagePayload {
  return { key, values } as unknown as UserMessagePayload;
}

export function renderUserMessagePayload(
  payload: UserMessagePayload,
  fallback: UserMessageKey = 'operation.failed'
): UserMessage {
  try {
    if (payload && isUserMessageKey(payload.key) && payload.values === undefined)
      return userMessage(payload.key);
    if (
      !payload ||
      !hasOwn(USER_MESSAGE_TEMPLATES, payload.key) ||
      !payload.values ||
      typeof payload.values !== 'object'
    )
      return userMessage(fallback);
    return userMessageWithValues(
      payload.key as TemplateKey,
      payload.values as Record<
        TemplateParameters<(typeof USER_MESSAGE_TEMPLATES)[TemplateKey]>,
        UserMessageValue
      >
    );
  } catch {
    return userMessage(fallback);
  }
}

export function resolveUserMessage(
  message: UserMessageInput,
  fallback: UserMessageKey = 'operation.failed'
): UserMessage {
  return typeof message === 'object'
    ? renderUserMessagePayload(message, fallback)
    : toUserMessage(message, fallback);
}

export function userMessagePayloadFromError(failure: unknown): UserMessagePayload | null {
  try {
    if (!(failure instanceof Error)) return null;
    if ('userMessageKey' in failure && isUserMessageKey(failure.userMessageKey))
      return userMessagePayload(failure.userMessageKey);
    if (!('userMessagePayload' in failure)) return null;
    const payload = failure.userMessagePayload;
    if (!isUserMessagePayload(payload)) return null;
    if (isUserMessageKey(payload.key) && payload.values === undefined)
      return userMessagePayload(payload.key);
    if (!hasOwn(USER_MESSAGE_TEMPLATES, payload.key) || !payload.values) return null;
    return {
      key: payload.key,
      values: Object.fromEntries(
        Object.entries(payload.values).map(([key, value]) => [key, userMessageValue(value)])
      ),
    } as unknown as UserMessagePayload;
  } catch {
    return null;
  }
}

export function toOptionalUserEntityLabel<T>(
  value: T,
  fallback?: Parameters<typeof userEntityLabel>[1]
): T extends null | undefined ? T : UserEntityLabel {
  return (value == null ? value : userEntityLabel(value, fallback)) as T extends null | undefined
    ? T
    : UserEntityLabel;
}

export function withUserMessage<T extends Error>(
  failure: T,
  message: UserMessageKey | UserMessagePayload
): T {
  Object.defineProperty(
    failure,
    typeof message === 'string' ? 'userMessageKey' : 'userMessagePayload',
    { value: message, configurable: true }
  );
  return failure;
}
