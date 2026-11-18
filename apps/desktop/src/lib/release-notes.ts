export interface ReleaseNote {
  date: string;

  highlights: string[];

  added?: string[];
  fixed?: string[];

  underTheHood?: string[];
}

export const RELEASE_NOTES: Record<string, ReleaseNote> = {
  '0.10.1': {
    date: '2026-11-18',
    highlights: ['Create standalone tables directly in project folders.'],
    added: ['Duplicate a saved table from Files to make an independent copy.'],
    fixed: ['Native AI processes on Mac have explicit permission to look up service addresses.'],
  },
  '0.10.0': {
    date: '2026-11-13',
    highlights: [
      'AI Tools moved to the left rail. Recent and pinned conversations open as regular tabs beside your documents and keep their messages and drafts.',
      'AI agents manage projects only through DNAForge project controls and cannot create, rename or re-point a project folder on their own.',
      'Zooming a linear sequence keeps the base under the pointer in place.',
      'Import linked items waits for the selected project to finish loading before adding files.',
    ],
    fixed: [
      'On Mac, trackpad and mouse-wheel scrolling works again in lists shown over a sequence or map, including Find results.',
      'Settings scrolls with the trackpad again, and protein structures from AI conversations no longer show through Settings.',
      'Opening the Mutations drawer in a narrow window no longer collapses the genome view.',
      'Discard works again after an edit fails while the project folder is temporarily unavailable.',
      'Showing, hiding or selecting a project no longer disconnects an AI agent or moves a conversation to another project.',
      'GenBank files keep LOCUS names that contain a colon.',
      'Windows can import files with long names without exceeding the file-name limit during import.',
      'Windows can reconcile a project notebook when two paths for the same file use different separators.',
    ],
  },
  '0.9.23': {
    date: '2026-11-04',
    highlights: ['Quit and restart without saving after a document edit fails.'],
    fixed: [
      'Discarding changes no longer gets trapped behind an earlier editing error.',
      'Restored documents wait for their workspace to be ready before loading.',
      'Closing a saved Track View no longer sends changes to an unrelated sequence document.',
    ],
  },
  '0.9.22': {
    date: '2026-11-04',
    highlights: [
      'Recover a damaged DNA sequence into a separate saved copy, with uncertain bases marked as N.',
    ],
    fixed: [
      'Recovery keeps the original file unchanged and includes its complete contents inside the recovered sequence.',
      'Every recovered position is annotated, and the saved sequence can be closed and reopened.',
      'Invalid-character errors show the character and its source line and column.',
    ],
  },
  '0.9.21': {
    date: '2026-11-03',
    highlights: [
      'Draft assemblies keep the same assembly icon in Files and tabs.',
      'External agent connections keep DNAForge in the background while you work in another app.',
      'Registry opens without the unavailable Local, Organization and Project scope switcher.',
    ],
    fixed: ['Hovering a draft assembly in Files shows its readable assembly name.'],
  },
  '0.9.20': {
    date: '2026-10-31',
    highlights: [
      "Registry can stay in sync with a living Google Sheet or a local Excel master workbook, keeping each row's record identity.",
      'Notebook sections can place content in two or three columns.',
      'Paired FASTQ reads can be trimmed and merged as a managed job.',
      'Primer design can build per-residue saturation mutagenesis libraries.',
      "The chat box shows each AI agent's own permission settings and asks for approval in one card.",
    ],
    fixed: [
      'Document tabs stay in one row without horizontal or vertical scrollbars, while crowded tabs remain reachable.',
      'The sign-in screen says up front that a new code can be requested 60 seconds after the last one.',
      'Every protein tab is labelled View, with one entry per view.',
      'Document titles hide file extensions by default.',
      'The tracks view draws an RNA complement strand with U.',
      'Assembly design follows your saved PCR temperature and overlap rules, and Save keeps a saved assembly.',
      'CDS outlines and hover highlights match what is drawn at every zoom.',
      'Closing a text file saves its latest edit first.',
      'Terminal colors follow the app theme and no longer flicker when the panel is resized.',
      'Windows members can pull projects that contain notebooks without sync stalling.',
      'People with view-only access to a shared project can no longer change its files, sequences or records.',
      'New company projects start shared only with their creator instead of the whole organization.',
    ],
    underTheHood: [
      'Reference genomes download from references.dnaforge.com.',
      'External agents connected through MCP can send app feedback and receive structured tool results.',
      'Improved reliability of Find, ORF detection and translation copying in sequence views.',
    ],
  },
  '0.9.19': {
    date: '2026-10-28',
    highlights: [
      'The integrated terminal has improved command editing, suggestions and controls.',
      'Open-source license details are available in Settings.',
    ],
    fixed: [
      'Annotated GenBank reference genomes can be imported on desktop.',
      'Unsaved text and script edits prevent a sync pull from overwriting local work.',
      'Saved alignments can find their reads by sequence instead of relying on file names.',
      'Email sign-in explains why a code could not be sent.',
      'Usage analytics can be enabled again in Settings after being turned off.',
    ],
    underTheHood: [
      'Improved diagnostic reliability for app startup, sign-in, Hosted AI and saved scientific workflows.',
    ],
  },
  '0.9.18': {
    date: '2026-10-23',
    highlights: [
      'Chat history keeps your conversations and unfinished edits when loading or saving a change fails.',
      'Jobs keeps active work visible and distinguishes stopping a run from releasing its saved result.',
      'Skills follows project-specific choices and offers a fresh review when an installation needs to be retried.',
    ],
    fixed: [
      'A failed chat-history refresh shows Retry instead of an empty history, while keeping the last loaded chats.',
      'Late rename and pin results no longer overwrite newer chat edits.',
      'An older Jobs refresh cannot overwrite a newer Stop or result-import outcome.',
      'The Jobs sidebar shows active work even when the recent history limit is reached.',
      'A failed skill-source refresh keeps previously loaded skills, and retrying after a completed install does not install it twice.',
    ],
  },
  '0.9.17': {
    date: '2026-10-22',
    highlights: [
      'Open project sequences reliably from the file menu and keyboard shortcuts.',
      'Circular map arrowheads and hover outlines follow the visible sequence geometry.',
      'Recover valid sequence files already in a project and see precise errors for damaged files.',
    ],
    fixed: [
      'Opening a sequence package from its context menu no longer opens its folder as a text file.',
      'Hovering a coding feature with separated segments no longer draws an outline across the gap.',
      'Circular feature arrows stay within the visible ribbon when zoomed in.',
      'Update failures distinguish a download interruption from a failure to prepare an already downloaded update.',
    ],
    underTheHood: ['Improved diagnostics for interrupted app updates.'],
  },
  '0.9.16': {
    date: '2026-10-21',
    highlights: ['Projects remain available after reloading a window that stopped responding.'],
    fixed: [
      'Reload Window no longer leaves every project reporting that its records could not be loaded or blocks further edits.',
    ],
  },
  '0.9.15': {
    date: '2026-10-20',
    highlights: [
      'Open an integrated terminal inside DNAForge, with separate tabs, split panes and searchable output.',
      'On Windows, use Windows Subsystem for Linux to sign in to saved remote hosts, open alignment and signal tracks, and reopen saved views.',
      'Notebook insertion dialogs and structure menus have solid backgrounds, clearer keyboard navigation and reliable focus when they close.',
      'Circular genome maps stay visible in narrow panes, and map zoom changes are saved when you reopen a view.',
    ],
    fixed: [
      'The track picker marks loaded catalog tracks on their own rows, keeping the count, sorting and Columns controls in place.',
      'Applying annotation results no longer asks you to reopen a document that has already refreshed.',
      'Sequence imports avoid exposing an incomplete project record while files are being written on local disks.',
      'Quitting DNAForge continues the remaining shutdown steps if stopping one service fails.',
    ],
  },
  '0.9.14': {
    date: '2026-10-14',
    highlights: [
      'The sequence viewer uses graphics-accelerated drawing for wrapped sequences, with the familiar scrolling, zooming and editing controls.',
      'Import files through a compact selection table, choose destinations across projects and folders, and find every imported result in the project tree.',
      'AI chats keep your draft and context when a selected model is unavailable, with clearer choices to refresh or change the model.',
    ],
    fixed: [
      'Coding-region extension arrows stay inside the visible sequence pane when rows wrap or scroll.',
      'Primer edits save to the current project and keep unfinished drafts.',
      'Annotation review keeps your selections and displays the saved document.',
      'Stopping an AI response keeps its delivered text and shows provider errors once.',
      'Remote SSH hosts refresh after changes, with clearer Terminal sign-in and reconnect actions.',
    ],
  },
  '0.9.13': {
    date: '2026-10-13',
    highlights: [
      'Shared organization sequences keep their identity, history and attachments when teammates edit them in the browser or desktop app.',
      'Offline edits stay available after a restart. When teammates change the same record, choose which version to keep before syncing.',
      'Assembly planning finds the fewest steps to build a construct from the parts already in your library.',
      'Map sequencing reads and other per-residue data onto 3D protein structures.',
      'Open alignment tracks stored on a remote server over your institution’s SSH login.',
    ],
    added: [
      'Choose a default AI model in Settings. If it is unavailable, the message goes through the next ready model and says so.',
      'Settings → File Handling: make DNAForge the app that opens GenBank and SnapGene files, and preview them read-only.',
      'Large attachments stay with shared projects, are reused when unchanged, and resume uploading after an interruption.',
      'Remote SSH hosts have their own screen: save a host, sign in once through Terminal, and use it from any track.',
    ],
    fixed: [
      'Removing a member ends their access to organization projects while preserving the files already on their computer.',
      'SnapGene .dna files import as ordinary editable sequences.',
      'Projects in deeply nested folders open correctly on Windows, and a failed Windows import now says so instead of appearing to succeed.',
      'Genome references no longer show their hidden source record as an extra track.',
      'Editing where a primer binds no longer changes the shared primer itself.',
      'Sign-in recovers from a brief account-linking error instead of failing.',
    ],
  },
  '0.9.12': {
    date: '2026-10-06',
    highlights: [
      'On Windows, File, Edit, View, Help and Options sit in one compact title bar beside Ask AI, Feedback, the theme toggle and the window controls, instead of a separate menu row.',
      'Settings has a search box, consistent sections with Save and Cancel feedback, and shorter provider rows that expand for details.',
    ],
    fixed: ['About shows the exact build you are running.'],
  },
  '0.9.11': {
    date: '2026-10-06',
    highlights: [
      'Add your own compute endpoint from Settings → Integrations, from a Runpod template or an advanced manifest, and run Jobs on it.',
      'Hosted reference genomes are rebuilt to download about half as much, and pseudogenes get their own track.',
      'Sequences show their names, not their filenames, in headers, tab menus and the sidebar. Rename changes the name and leaves the file alone.',
    ],
    fixed: [
      'Hosted AI starts again when the Registry tools are added, and every tool stays available.',
      'Canceling the unsaved-work prompt when quitting on Windows keeps DNAForge open.',
    ],
  },
  '0.9.9': {
    date: '2026-10-03',
    highlights: [
      'The genome viewer now has the same tools as the sequence viewer, and the reference catalog loads faster with clearer gene rendering.',
      'Save and Save As write one editable track view file, and every genome view reaches the Registry the same way.',
      'AB1 traces and attached reads draw in the genome lanes, and switching between Sequence, Map and Both on a complete genome stays responsive.',
      'Build a MoClo kit by hand, filter the part picker, and start from bundled published architectures.',
      'New AI conversations get short descriptive titles, and files an agent creates open straight from the chat.',
    ],
    fixed: [
      'Installed reference genomes stay usable while newer annotations are prepared, and open views keep their place when the update arrives.',
      'GRCh38 annotations are republished with corrected coding-sequence phases.',
      'Resolving a shared-project conflict saves your unsaved edits first instead of failing.',
      'The quit prompt names each unsaved tab, and Close Anyway appears while the window is still open, so you can save first.',
      'Projects that were open before a restart or update are available again when DNAForge reopens.',
      'Ctrl+Tab switches tabs in the pane you last clicked.',
      'Installing over DNAForge 0.7.9 on Windows replaces it safely.',
      'Saving a sequence on a fresh Windows install works. If a save fails, your edits stay, with plain Save and Discard choices.',
      'Discarding edits to a new, empty sequence clears the edit banner so you can keep editing.',
      'Sequence views on Windows use the intended JetBrains Mono font instead of a substitute.',
      'A newly opened prepared reference genome no longer gets stuck with search pending.',
      'In the genome viewer, the ruler sits just under the sequence, and primer rows take space only where primers are in view.',
    ],
  },
  '0.9.7': {
    date: '2026-09-27',
    highlights: [
      'Settings → AI is redesigned: choose a host and manage Direct API providers in one place, and see clearer status for Hosted AI and outside AI apps.',
      'Skills settings list your skills faster, loading as they are found, and remember where each skill came from.',
      'Outside AI apps no longer open many copies of DNAForge at once. If DNAForge is closed, the AI app asks you to reopen it instead of starting it again after you quit.',
      'Spreadsheet cells highlight immediately as you move the pointer across them.',
    ],
    fixed: [
      'The permanent warning about migrating older notebooks is gone. Notebooks that belong to a project move into it automatically, and notebooks without a project stay editable on their own.',
    ],
    underTheHood: ['Mac and Windows always ship as the same version.'],
  },

  '0.9.6': {
    date: '2026-09-25',
    highlights: [
      'DNAForge for Mac is now signed by Humic Labs. If you installed an earlier Mac version, download 0.9.6 from dnaforge.com/download once; after that, updates arrive automatically again.',
      'Organizations: invite members, set roles, share organization projects, and keep the Registry in sync across the web and desktop apps. Private "Just me" projects are still available.',
      'Jobs can stop a running hosted computation, import a finished result, and open imported results.',
      'Connect outside AI apps (Claude Code, Codex, Cursor, Claude Desktop and others) from Settings → AI, with copy-and-paste setup for each app and an optional local web address.',
      'Genome indexing is 12 to 25 times faster: every GenBank and FASTA file now goes through the built-in Rust indexer.',
    ],
    added: [
      'Manage projects creates an empty project without importing a folder, and lists current, archived, and trashed projects in one place.',
      'Keyboard shortcuts and a single About page.',
      'The genome viewer track sidebar runs the full height of the viewer, and the chromosome strip is a track you can hide.',
      'A large FASTA file without annotations opens in the genome viewer instead of failing.',
    ],
    fixed: [
      'Genome viewer controls beside the tracks are no longer clipped when every annotation type is hidden.',
      'Features that wrap around the origin of a circular plasmid, such as the pUC19 origin, are drawn as two pieces instead of across the whole plasmid.',
      'A GenBank or FASTA file with several records is refused with a message instead of quietly indexing only the first record.',
      'Hosted AI stays available through a single failed readiness check instead of switching off.',
    ],
    underTheHood: [
      'Mac updates come from a new update address for Humic-signed builds; Windows updates are unchanged.',
      'Genome preparation no longer uses Biopython.',
      'Hosted workspaces can run managed operations, such as an alignment, on a separate service and keep the result after reload.',
    ],
  },

  '0.9.3': {
    date: '2026-09-23',
    highlights: [
      'Ask AI remembers Auto or Deep after sign-in and after you quit and reopen the app.',
      'Long Ask AI conversations continue when the next request would have exceeded the previous size limit.',
      'External AI agents connect to DNAForge again on Macs where the app had previously crashed or been force-quit.',
      'The genome viewer opens BED, GFF/GTF, genePred, refFlat, peak and BigBed files, remote BAM/CRAM and VCF/BCF, and private HTTP, S3 and Google Cloud Storage sources.',
      'Paste a sequence you copied into Ask AI to attach it as a named source with its range, instead of pasting raw bases.',
      'The installed app is smaller: extra language packs and unused helper files are left out.',
      'DNAForge includes the Git it needs and checks that Git before the app opens.',
    ],
    added: [
      'Import with agent accepts a ZIP archive as well as a folder.',
      'The LIMS icon counts unconnected relationships; each affected entity is marked Failed, and an Unconnected filter lists them.',
      'A smaller macOS install window with DNAForge and the Applications folder side by side.',
    ],
    fixed: [
      'Choosing Auto or Deep is saved before sign-in opens. Saying Not now leaves the previous Ask AI route in place, and a message still waits until Hosted AI is ready.',
      'An Ask AI request that is too large is refused once, without sending that request again.',
      'The indexed genome viewer no longer stalls or reloads sequence at either end of a chromosome.',
      'Switching sequence tabs no longer flashes black or clips the loading spinner.',
      'Rename on a finished plasmid tab selects the current name so you can type the new one.',
      'Tracks view no longer re-renders endlessly when a sequence has no overlays.',
      'An Ask AI approval or question stays in the chat that asked it; switching chats no longer shows or answers it.',
      'Benchling fields that list several record names in one cell link to each record.',
      'Quitting DNAForge on a Mac also stops its local analysis service.',
      'An analysis engine left running by a crashed app no longer blocks the next launch.',
      'A development build can no longer write into your installed app data, and if a newer copy of your database was set aside, DNAForge restores it before opening.',
    ],
    underTheHood: [
      'Startup runs the shipped Git binary before storage, the local service, or a product window.',
      'The package keeps the English language pack and omits runtime source that is already compiled into the app.',
      'Diagnostics record each screen by name instead of "unknown".',
      'The bundled PDF runtime keeps its exact Java version identity and passes package checks on every platform.',
    ],
  },

  '0.9.2': {
    date: '2026-09-21',
    highlights: [
      'Install DNAForge from the website or update in the app and start one clean window, without a second-window startup error.',
      'Open prepared Chinese Spring wheat, SARS-CoV-2 Wuhan-Hu-1, and eleven bacterial genomes from the References picker.',
      'Translate each sequence with the genetic code that record declares, and choose a code when the file does not say.',
      'Compose reusable indexed-genome track views and browse chromosomes that exceed the previous index-size limit.',
      'Add a local reference and reopen its indexed genome more reliably from the References library.',
    ],
    added: [
      'See and change the record genetic code in the sequence info bar and metadata drawer; translations, ORF search, and paste use that code.',
      'Use a compact indexed-genome toolbar, a refined chromosome overview, and configurable track views.',
    ],
    fixed: [
      'Close the previous app, helpers, and local service before a Mac update relaunches on Apple Silicon or Intel.',
      'Preview where an incomplete CDS reading frame really ends, not only the annotated span.',
      'Show prokaryotic product tracks without requiring an mRNA seed scene.',
      'Treat genomic RNA on viral references such as SARS-CoV-2 as genomic sequence, not a transcript envelope.',
    ],
    underTheHood: [
      'The unfinished extension runtime remains disabled until it can run as an isolated child process without relaunching the app.',
      'Chromosome overview streams live tiles and transcript windows, and chromosomes longer than the TBI limit use CSI indexes.',
    ],
  },

  '0.9.0': {
    date: '2026-09-18',
    highlights: [
      'Run pairwise alignment as a job you can follow in Jobs, stop, and resume from the same session.',
      'Connect Codex or Claude Code to the installed app so they use the current workspace tools and approvals.',
      'Inspect individual reads directly in pileup views, with details for the selected read.',
      'Browse prepared reference genomes for cynomolgus macaque T2T-MFA8 and Nicotiana benthamiana KLAB.',
      'Install Windows updates more reliably when DNAForge replaces the existing app and restarts its local service.',
    ],
    added: [
      'Edit saved annotations while preserving their source lineage.',
      'Import Benchling All Items and HTML ZIPs through the proved manual ZIP path, and recover a blocked or failed import.',
    ],
    fixed: [
      'Keep circular contig annotations aligned on hosted references, including IRGSP and tomato chloroplast.',
      'Complete Windows in-app updates without racing the local service or relying on stale installer ownership.',
      'Show the accurate tutorial media state after migration.',
    ],
    underTheHood: [
      'Desktop packages no longer ship helper compiler output, which reduces the installed size.',
      'Large imports persist in bounded batches with atomic publication.',
    ],
  },

  '0.8.13': {
    date: '2026-09-16',
    highlights: [
      'Add a local genome to References by dropping a FASTA file, a FASTA folder with optional GFF3, or an NCBI Datasets ZIP — without classifying the source first.',
      'Search the primer library as a job that keeps running if you close the drawer, then reopen the same results.',
      'Prepare variant sources as a job you can follow in Jobs and recover after restart.',
      'Ask the assistant to submit hosted compute jobs, starting with Tamarind and Boltz.',
    ],
    added: [
      'Browse or drop a reference in one modal; DNAForge infers FASTA, FASTA+GFF3 folders, and NCBI Datasets ZIPs.',
      'Keep imported reference sources after a successful add, and reopen them through the same indexed-genome path.',
    ],
    fixed: [
      'Keep reference workspaces out of Recent edits, and order that list by actual workspace access.',
      'Keep sequence viewport brackets readable when the visible range is too small for two marks.',
    ],
    underTheHood: [
      'Agent tools now share one renderer catalog instead of duplicate registrations.',
      'Hosted compute uses a shared endpoints layer so later providers can follow the Tamarind path.',
    ],
  },

  '0.8.12': {
    date: '2026-09-12',
    highlights: [
      'Import Benchling notebook entries with # in their titles as editable notebooks, and discard a blocked import to start again.',
      'Ask Codex, Claude, or Grok from the same chat, with shared questions, approvals, plans, attachments, and workspace tools.',
      'Build MoClo assemblies from kit schemas in the assembly drawer and search project parts by overhang compatibility.',
      'Open References as a full-screen workspace, keep several named Track views of the same genome, and save those views as project files.',
      'Invite collaborators to a shared project with viewer, editor, or manager access and keep copies in sync.',
    ],
    added: [
      'Track long-running annotation and agent work in Jobs without losing the run when you close its view.',
      'Run multiple-sequence alignment as a managed job and retain its progress and results across restart.',
      'Open public product documentation from Help.',
    ],
    fixed: [
      'Show the real ZIP verification state even if native notebook conversion fails.',
      'Keep genome indexing in Jobs when you close its view, then rejoin the same work when you reopen the source.',
      'Restore Hosted AI availability and sign-in readiness when you open Ask AI or choose Hosted.',
      'Automatically update an older app when it encounters a database created by a newer release, without replacing that database.',
      'Keep nucleotide and codon letters visible when you reopen a cached indexed genome.',
    ],
  },

  '0.8.11': {
    date: '2026-09-11',
    highlights: [
      'Ask Codex, Claude, or Grok from the same chat, with shared questions, approvals, plans, attachments, and workspace tools.',
      'Build MoClo assemblies from kit schemas in the assembly drawer and search project parts by overhang compatibility.',
      'Open References as a full-screen workspace, keep several named Track views of the same genome, and save those views as project files.',
      'Invite collaborators to a shared project with viewer, editor, or manager access and keep every copy in sync, including offline work and overlapping edits.',
      'Follow long-running annotation and agent work in Jobs in the left sidebar without losing the run when you close its view.',
    ],
    fixed: [
      'Show the pause marker after you stop a hosted assistant turn.',
      'Install automatic Windows updates from DNAForge 0.8.9 without rejecting the signed installer.',
      'Automatically update an older DNAForge app when it encounters a database created by a newer release, without changing or replacing the database.',
      'Ignore obsolete recovery markers and show the real startup error instead of trapping you in a recovery updater after a failed launch.',
      'Reopen a cached genome and keep nucleotide and codon letters visible in indexed views.',
    ],
    underTheHood: [
      'Desktop and the Python sidecar now share one typed message contract instead of parallel handwritten routes.',
      'Windows installer path handling is stricter, and update publication checks updater authority across reachable package chunks.',
      'Release checks now identify each Mac and Windows version from its updater files, so independently published platform artifacts cannot be hidden by a container name.',
    ],
  },

  '0.8.10': {
    date: '2026-09-08',
    highlights: [
      'See nucleotide letters on both strands when zooming into indexed genomes.',
      'Keep nucleotide letters and codons visible after switching chromosomes and returning.',
      'Keep delayed sequence reads from replacing the region currently on screen.',
    ],
  },

  '0.8.9': {
    date: '2026-09-07',
    highlights: [
      'Install automatic updates from DNAForge 0.8.3 on Windows and reopen the updated app without getting stuck at the installer.',
      'Continue automatic updates through the backup server when the primary update server cannot be reached.',
      'Import Benchling exports into native workspaces with sequences, annotations, notebook content, and registry records preserved.',
      'Share complete workspaces and explore eight additional hosted reference genomes.',
    ],
    fixed: [
      'Keep the Windows update repair active for supported older installations instead of limiting it to one replacement version.',
      'Preserve existing workspaces, settings, and the ability to uninstall the updated app.',
    ],
    underTheHood: [
      'The small Windows upgrade test now compiles the same installer repair as the full application and checks native replacement and relaunch.',
      'Release checks reuse the exact signed files rather than rebuilding an unchanged application.',
    ],
  },

  '0.8.8': {
    date: '2026-09-06',
    highlights: [
      'Continue automatic updates through the backup server when the primary update server cannot be reached.',
      'Import Benchling exports into native workspaces with sequences, annotations, notebook content, and registry records preserved.',
      'Share and restore complete workspaces, including earlier versions of managed sequences.',
      'Explore eight additional hosted reference genomes and save portable genome views.',
    ],
    fixed: [
      'Recover update checks after refused, reset, closed, or disconnected network connections, including when the app cannot finish starting.',
      'Install automatic updates from DNAForge 0.8.3 on Windows without getting stuck at the DNAForge Setup window.',
      'Keep existing signature and compatibility checks enforced when switching update servers.',
    ],
    underTheHood: [
      'Real network failures and native replacement on all three desktop platforms are now tested before full release packaging.',
      'The signed application is built once; later release checks reuse those exact files.',
    ],
  },

  '0.8.7': {
    date: '2026-09-04',
    highlights: [
      'Import a Benchling export into a native DNAForge workspace while preserving sequences, annotations, notebook tables, images, SVG figures, saved formula results, registry records, and reviewed oligo classifications.',
      'Choose a new or existing workspace for a Benchling migration, recover interrupted work, and open the populated editor only after the import finishes.',
      'Review imported registry tables, edit record relationships, and see a blue Benchling marker when a notebook link points to content that was not exported.',
      'Share and restore complete workspaces without losing files or earlier versions of managed sequences.',
      'Use eight additional hosted reference genomes with UCSC-aligned annotations, and save or reopen portable genome views.',
    ],
    fixed: [
      'Install automatic updates from DNAForge 0.8.3 on Windows without getting stuck at the DNAForge Setup window.',
      'Launch the installed desktop app reliably after updating, with every required runtime component included in the signed package.',
      'Close sequence, genome, document, and image tabs without leaving hidden windows and background workers consuming memory.',
      'Open startup workspaces and newly mounted folders without intermittent workspace-not-mounted failures.',
      'Keep the visible endpoint centered when panning or zooming beyond either end of a complete linear genome.',
      'Sign in with Google or GitHub without macOS Keychain prompts before authentication, and return to the desktop app instead of the marketing homepage.',
      'Open Cloud backup from the account menu to review files and sync actions without flooding the account popover or showing raw sync errors.',
    ],
    underTheHood: [
      'Production release admission now proves updater-mirror write access before allocating signing runners.',
      'The replacement release uses the existing bounded mirror credential while the dedicated publisher App remains unavailable.',
    ],
  },

  '0.8.6': {
    date: '2026-09-03',
    highlights: [
      'Import a Benchling export into a native DNAForge project while preserving sequences, annotations, notebook tables, images, SVG figures, saved formula results, registry records, and reviewed oligo classifications.',
      'Choose a new or existing project for a Benchling migration, recover interrupted work, and open the populated editor only after the import finishes.',
      'Review imported registry tables, edit record relationships, and see a blue Benchling marker when a notebook link points to content that was not exported.',
      'Share and restore complete projects without losing files or earlier versions of managed sequences.',
      'Use eight additional hosted reference genomes with UCSC-aligned annotations, and save or reopen portable genome views.',
    ],
    fixed: [
      'Install automatic updates from DNAForge 0.8.3 on Windows without getting stuck at the DNAForge Setup window.',
      'Launch the installed desktop app reliably after updating, with every required runtime component included in the signed package.',
      'Close sequence, genome, document, and image tabs without leaving hidden windows and background workers consuming memory.',
      'Open startup projects and newly added folders without intermittent project-not-open failures.',
      'Keep the visible endpoint centered when panning or zooming beyond either end of a complete linear genome.',
      'Sign in with Google or GitHub without macOS Keychain prompts before authentication, and return to the desktop app instead of the marketing homepage.',
      'Open Cloud backup from the account menu to review files and sync actions without flooding the account popover or showing raw sync errors.',
    ],
    underTheHood: [
      'Reliability diagnostics now record bounded, content-free outcomes while honoring the Privacy setting.',
      'Signed desktop candidates are built once, retained for 90 days, and bound to their source, release notes, and macOS and Windows artifact digests before final approval.',
      'Scientific-document viewers now use shared domain services and generated transport checks with a smaller privileged preload layer.',
      'Hosted project sync verifies current and historical sequence packages byte for byte and refuses malformed or conflicting snapshots.',
      'UCSC source admission preserves every valid annotation row while rejecting rows for unknown sequence IDs.',
    ],
  },

  '0.8.5': {
    date: '2026-09-03',
    highlights: [
      'Import a Benchling export into a native DNAForge project while preserving sequences, annotations, notebook tables, images, SVG figures, saved formula results, registry records, and reviewed oligo classifications.',
      'Choose a new or existing project for a Benchling migration, recover interrupted work, and open the populated editor only after the import finishes.',
      'Review imported registry tables, edit record relationships, and see a blue Benchling marker when a notebook link points to content that was not exported.',
      'Share and restore complete projects without losing files or earlier versions of managed sequences.',
      'Use eight additional hosted reference genomes with UCSC-aligned annotations, and save or reopen portable genome views.',
    ],
    fixed: [
      'Launch the installed desktop app reliably after updating, with every required runtime component included in the signed package.',
      'Open startup projects and newly added folders without intermittent project-not-open failures.',
      'Keep the visible endpoint centered when panning or zooming beyond either end of a complete linear genome.',
      'Sign in with Google or GitHub without macOS Keychain prompts before authentication, and return to the desktop app instead of the marketing homepage.',
      'Open Cloud backup from the account menu to review files and sync actions without flooding the account popover or showing raw sync errors.',
    ],
    underTheHood: [
      'Signed desktop candidates are built once, retained for 90 days, and bound to their source, release notes, and macOS and Windows artifact digests before final approval.',
      'Scientific-document viewers now use shared domain services and generated transport checks with a smaller privileged preload layer.',
      'Hosted project sync verifies current and historical sequence packages byte for byte and refuses malformed or conflicting snapshots.',
      'UCSC source admission preserves every valid annotation row while rejecting rows for unknown sequence IDs.',
    ],
  },

  '0.8.4': {
    date: '2026-09-02',
    highlights: [
      'Import a Benchling export into a native DNAForge project while preserving sequences, annotations, notebook tables, images, SVG figures, saved formula results, registry records, and reviewed oligo classifications.',
      'Choose a new or existing project for a Benchling migration, recover interrupted work, and open the populated editor only after the import finishes.',
      'Review imported registry tables, edit record relationships, and see a blue Benchling marker when a notebook link points to content that was not exported.',
      'Share and restore complete projects without losing files or earlier versions of managed sequences.',
    ],
    fixed: [
      'Open startup projects and newly added folders without intermittent project-not-open failures.',
      'Keep the visible endpoint centered when panning or zooming beyond either end of a complete linear genome.',
      'Sign in with Google or GitHub without macOS Keychain prompts before authentication, and return to the desktop app instead of the marketing homepage.',
      'Open Cloud backup from the account menu to review files and sync actions without flooding the account popover or showing raw sync errors.',
    ],
    underTheHood: [
      'Scientific-document viewers now use shared domain services and generated transport checks with a smaller privileged preload layer.',
      'Hosted project sync verifies current and historical sequence packages byte for byte and refuses malformed or conflicting snapshots.',
      'UCSC source admission now preserves every valid annotation row while rejecting rows for unknown sequence IDs.',
      'Eight reviewed reference-source snapshots entered the operator catalog for later preparation. They are not yet visible in the reference picker.',
    ],
  },

  '0.8.3': {
    date: '2026-08-30',
    highlights: [
      'Keep future automatic updates available when one download source is temporarily unavailable by trying a second independent source.',
      'Retry an update after cancelling or an installation failure, and continue a pending install after relaunch.',
      'Open supported DNA and project files directly from Finder and inspect read-only Quick Look previews.',
      'Choose from a larger set of prepared reference genomes with verified annotations in the reference picker.',
      'Recover an interrupted Benchling migration without repeating completed work.',
    ],
    fixed: [
      'Use the canonical DNAForge application identity and icon across signed release packages.',
      'Correct annotations that cross the origin of circular hosted references.',
    ],
    underTheHood: [
      'Update publication retains the exact signed artifacts through smoke tests, previous-version acceptance, and feed activation.',
      'Release-validation packages use a separate application identity and cannot check for or install updates.',
    ],
  },

  '0.8.2': {
    date: '2026-08-26',
    highlights: [
      'Add public indexed BigWig signal tracks to an open reference by URL without downloading the whole file.',
      'Keep repeated or simultaneous additions of the same track from creating duplicate lanes.',
      'Reject private-network addresses and unsafe redirects before streaming remote track data.',
    ],
    underTheHood: [
      'Added review-only operator tools for acquiring NCBI packages and preparing restartable hosted-reference batches without publishing them to the user catalog.',
      'External MCP clients now need permission to modify tabs and fetch external annotations before adding an indexed BigWig track.',
    ],
  },

  '0.8.1': {
    date: '2026-08-24',
    highlights: [
      'Import a Benchling HTML ZIP entirely offline and choose exactly where its new project should be created before DNAForge writes anything.',
      'Review validation findings in the migration window, proceed when the export is usable, and keep the completion summary open until you choose what to do next.',
      'Start another Benchling import from Home and have DNAForge reuse the strongest existing destination instead of creating a duplicate project.',
    ],
    fixed: [
      'Finalize an accepted design into its intended sequence package even when another managed project already contains the same design identifier.',
      'Switch from Home to the project file browser without rebuilding the entire file-tree surface.',
    ],
    underTheHood: [
      'Indexed-current-view tools now use the shared authorized catalog, while Hosted gateway compatibility and desktop release checks gained additional hardening.',
    ],
  },

  '0.8.0': {
    date: '2026-08-19',
    highlights: [
      'Windows users on 0.7.9 or earlier must manually install 0.8.0 once from https://downloads.dnaforge.com/v0.8.0/DNAForge-Setup-0.8.0.exe; automatic updates resume after that reinstall.',
      'Design primer pairs around an exact target, save them, and revise bindings without losing provenance.',
      'Preview Golden Gate assemblies before finalizing them, preserve immutable lineage, reopen accepted plasmids, and jump between assembled parts and their sources.',
      'Trust AI answers grounded in the local project and reopen completed tab and range actions from chat history.',
      'Keep notebook references intact across project moves and jump to exact sequence, primer, and notebook targets.',
    ],
    underTheHood: [
      'Desktop release automation now keeps the 0.8.0 proposal as the sole version authority and rejects competing feature-branch bumps.',
    ],
  },

  '0.7.15': {
    date: '2026-08-14',
    highlights: [
      'Version bump for: apps/desktop/package.json change (commit-time CD gate).',
      'Replace this scaffold before shipping a desktop release tag.',
    ],
    underTheHood: ['Version bump prepared by release-please from Conventional Commits.'],
  },

  '0.7.14': {
    date: '2026-08-12',
    highlights: [
      'Version bump for: apps/desktop/package.json change (commit-time CD gate).',
      'Replace this scaffold before shipping a desktop release tag.',
    ],
    underTheHood: ['Version bump prepared by release-please from Conventional Commits.'],
  },

  '0.7.13': {
    date: '2026-08-11',
    highlights: [
      'Version bump for: apps/desktop/package.json change (commit-time CD gate).',
      'Replace this scaffold before shipping a desktop release tag.',
    ],
    underTheHood: ['Version bump prepared by release-please from Conventional Commits.'],
  },

  '0.7.12': {
    date: '2026-08-11',
    highlights: [
      'Version bump for: apps/desktop/package.json change (commit-time CD gate).',
      'Replace this scaffold before shipping a desktop release tag.',
    ],
    underTheHood: ['Version bump prepared by release-please from Conventional Commits.'],
  },

  '0.7.11': {
    date: '2026-08-11',
    highlights: [
      'Version bump for: apps/desktop/package.json change.',
      'Replace this scaffold before shipping a desktop release tag.',
    ],
    underTheHood: ['Version bump prepared by release-please from Conventional Commits.'],
  },

  '0.7.10': {
    date: '2026-08-04',
    highlights: [
      'Help improve DNAForge by sharing a small record of which product workflows are used, without sending sequences, file names, project names, or other customer content. You can turn this off at any time.',
      'Keep desktop and web activity joined to one pseudonymous installation while sharing follows your current Privacy setting and stops immediately when turned off.',
    ],
    fixed: [
      'Product usage sharing never sends form text, element labels, or which keys you press.',
      'Release and diagnostic signals now reach the correct environment and carry the exact app build needed to investigate problems safely.',
    ],
    underTheHood: [
      'Product-usage signals are restricted to a reviewed event and property registry, verified in the real desktop app, and checked by reviewer-gated synthetic canaries before staging or production promotion.',
    ],
  },

  '0.7.9': {
    date: '2026-07-30',
    highlights: [
      'Download prepared assets for a hosted human reference and open it with its annotations visible in the installed app.',
      'Keep indexed genome annotations visible while moving between broad assembly views and detailed zoom levels.',
      'Add a public UCSC quantitative track in one click and view its real signal as a histogram in the installed app.',
    ],
    fixed: [
      'Keep an already-visible reference coordinate view ready while its remaining source, annotation, and search data finish loading.',
      'Preserve the selected reference and its prepared annotation products across cache publication and reopening.',
    ],
    underTheHood: [
      'Packaged acceptance now starts from an empty reference cache and requires visible GRCh38 annotations plus non-empty UCSC histogram pixels.',
      'Removed a circular dependency in the pileup renderer without changing its zoom thresholds or drawing behavior.',
    ],
  },

  '0.7.8': {
    date: '2026-07-29',
    highlights: [
      'Open complete hosted reference genomes from the reference library and reopen them quickly from a verified local cache.',
      'Import a custom reference from a folder, FASTA file, or NCBI Datasets package; DNAForge discovers and indexes included GFF3 annotations.',
      'Add BAM alignments and inspect read-level mismatches, insertions, deletions, and skipped bases; DNAForge prepares missing indexes and coverage caches automatically.',
      'Browse mutations genome-wide from indexed VCF files and jump to their gene, transcript, exon, CDS, and coding-consequence context.',
      'Add public UCSC BigWig signal tracks in one click and keep them available across whole-genome views, detailed views, and reopening.',
    ],
    fixed: [
      'Hidden reverse-strand annotations selected from Find now resolve to the exact rendered feature.',
      'Local reference tabs now receive completed annotation and search capabilities even after the import dialog closes.',
    ],
    underTheHood: [
      'Reference preparation uses content-bound, atomic cache publications and bundles the native indexer and coverage helpers required by the desktop app.',
      'DNAForge streams only the required indexed BigWig byte ranges through its authenticated local data plane and renders them through the shared bounded track pipeline.',
    ],
  },

  '0.7.7': {
    date: '2026-07-28',
    highlights: [
      'Open complete hosted reference genomes from the reference library and reopen them quickly from a verified local cache.',
      'Import a custom reference from a folder, FASTA file, or NCBI Datasets package; DNAForge discovers and indexes included GFF3 annotations.',
      'Add BAM alignments and inspect read-level mismatches, insertions, deletions, and skipped bases; DNAForge prepares missing indexes and coverage caches automatically.',
      'Browse mutations genome-wide from indexed VCF files and jump to their gene, transcript, exon, CDS, and coding-consequence context.',
      'Add public UCSC BigWig signal tracks in one click and keep them available across whole-genome views, detailed views, and reopening.',
    ],
    fixed: [
      'Hidden reverse-strand annotations selected from Find now resolve to the exact rendered feature.',
      'Local reference tabs now receive completed annotation and search capabilities even after the import dialog closes.',
    ],
    underTheHood: [
      'Reference preparation uses content-bound, atomic cache publications and bundles the native indexer and coverage helpers required by the desktop app.',
      'DNAForge streams only the required indexed BigWig byte ranges through its authenticated local data plane and renders them through the shared bounded track pipeline.',
    ],
  },

  '0.7.6': {
    date: '2026-07-27',
    highlights: [
      'Search complete reference genomes for DNA sequences, annotations, and amino-acid matches, then open results directly.',
      'Load and compare multiple local BAM alignment files on the same reference. DNAForge prepares missing indexes automatically and keeps tracks synchronized while you pan and zoom.',
      'AI replies now render headings, lists, links, code blocks, and contained tables. Attached references remain visible while resolving and clearly report unavailable results.',
      'Import primers, strains, DNA sequences, and protein sequences through guided workflows, including protein alignment and back-translation with built-in organism codon tables.',
      'The project file tree remains available across views and restores expanded folders and sidebar layout after relaunch.',
      'Finalized assemblies and imported plasmids now become self-contained plasmid packages that keep their GenBank product, build history, and generated primers together as one project item.',
    ],
    fixed: [
      'Closing complex design or genome tabs is now consistently fast and no longer briefly blanks or rebuilds neighboring canvases.',
      'Older DNAForge versions now recognize a database written by a newer release and ask you to update instead of incorrectly treating it as corrupted.',
      'Development builds use isolated database profiles and cannot silently migrate the database used by an installed release.',
      'Genome annotations and read-alignment tracks remain stable across search navigation, theme changes, panning, zooming, and hidden-track reveals.',
    ],
    underTheHood: [
      'Historical desktop migrations are now exercised against captured real databases, including upgrades, recovery, and repeated-start safety.',
      'Hosted reference assets are prepared, pinned, and verified before publication.',
      'Improved diagnostics and reliability checks across AI chat and desktop workflows.',
    ],
  },

  '0.7.5': {
    date: '2026-07-27',
    highlights: [
      'Local and development builds now use an isolated database profile whenever the installed database needs an upgrade, so testing cannot silently advance your release data.',
      'An older build now treats a newer database as healthy: it asks you to install the current release first instead of suggesting that you move the database aside.',
      'Every non-release desktop window carries a persistent Development profile marker so the active data profile is never ambiguous.',
    ],
    underTheHood: [
      'Shared-profile schema migrations now require an exact release-workflow stamp compiled into the Electron main bundle; runtime environment variables cannot promote a local artifact.',
      'A compatible backup restore first preserves the newer live database and its SQLite sidecars, while retention keeps both the oldest schema recovery point and the newest backup.',
      'Each successful launch records the last writer version, release identity, source fingerprint, and timestamp in the database.',
    ],
  },

  '0.7.4': {
    date: '2026-07-27',
    highlights: [
      'Import primers, strains, and sequences through a guided wizard with paste, drag-and-drop, spreadsheet mapping, and project-aware destinations.',
      'Work with amino-acid sequences as first-class registry entries: create them from coding regions, inspect structures, align proteins, and back-translate them with built-in organism codon-usage tables.',
      'Load local BAM alignment files into indexed genome views, prepare their indexes automatically, and compare multiple read tracks on one reference.',
      'Start from a new Home tab that brings Ask AI, recently edited work, and open tabs into one screen.',
      'Keep the project file tree available while switching views, with expanded folders and sidebar state restored after relaunch.',
    ],
    added: [
      'Move or rename registry files inside DNAForge or with external tools and keep linked sequences, primers, and indexed files connected.',
      'Choose an exact annotation lane count and keep alignment-track controls accessible at the bottom of long track stacks.',
      'Use NEB-backed primer melting-temperature calculations directly from the primer panel.',
    ],
    fixed: [
      'The project tree no longer scrolls the entire application when revealing or focusing deeply nested files.',
      'The WebGL map thumbnail stays synchronized with the sequence view during fast scrolling.',
      'Jumping to an annotation from Find no longer leaves a stale nucleotide-range highlight behind.',
      'Reference-assembly actions now work regardless of which project is active.',
    ],
    underTheHood: ['Improved diagnostics for AI chat quality and reliability.'],
  },

  '0.7.3': {
    date: '2026-07-25',
    highlights: ['Maintenance and reliability improvements across the desktop app.'],
  },

  '0.7.2': {
    date: '2026-07-24',
    highlights: [
      'A new Home tab (top of the sidebar) — Ask AI, Recently Edited, and your open tabs, all in one screen.',
      'Fixed the WebGL map thumbnail losing sync with the sequence view during fast scrolling.',
    ],
    underTheHood: [
      "Added @fontsource/jetbrains-mono as a bundled dependency for the Home tab wordmark, registered under a private font name so it can never collide with the sequence viewer's own font.",
    ],
  },

  '0.7.1': {
    date: '2026-07-23',
    highlights: [
      'Import primers, strains, and sequences into a project through a guided wizard — pick a type, paste or drop your data, map columns to registry fields, and choose where it lands.',
      'Amino-acid (protein) sequences are now first-class registry entities: create one from a CDS, open it in its own tab, view its structure, and reference it in AI chat — with new tools for multiple-sequence alignment and back-translation.',
      'Load local BAM files into an indexed genome view, with automatic index preparation and support for multiple alignment tracks.',
      'Primer melting temperatures now come from the NEB Tm calculator (previously unavailable to every user), in a cleaner primer panel.',
    ],
    added: [
      'A guided import wizard for primers, strains, and sequences: a type-first flow with paste-or-drop data, per-column mapping to registry fields, file-authoritative primer import, and multi-sheet spreadsheet support.',
      'Amino-acid protein registry entities — created from a CDS with "Create amino acid sequence", opened in a dedicated tab, with a "View Structure" split-view into the 3D viewer.',
      'New AI tools: multiple-sequence alignment (MSA) and back-translation of a protein to DNA using organism codon-usage tables.',
      'NEB-backed primer melting-temperature selection in the primer panel.',
      'A structure-drawer toolbar button, enabled when the current tab has an associated structure or you click a structure-searchable feature.',
      'Add multiple local BAM alignment tracks to the same indexed reference view.',
      'Set annotation density with one compact lane-count field that accepts an exact value.',
    ],
    fixed: [
      'Right-clicking a tab and choosing "Show in Project" no longer shoves the whole application up and off the top of the screen — revealing a file now scrolls only the file tree.',
      'Move or rename a registry file anywhere — inside the app or outside it (Finder, git, an external agent) — and every reference to it (sequence links, primer bindings, indexed files) re-links automatically instead of breaking.',
      'The structure (3D) drawer now shares the same one-drawer-per-tab behavior as the others, so opening it no longer permanently blocks the Annotations, Alignments, and Primers drawers.',
      'The primer length field no longer rewrites the primer sequence on every keystroke while you type a number — it commits on blur, Enter, or the stepper.',
      'The reference-assembly entry point now works regardless of which project is active.',
      'Annotation bodies no longer disappear at broad spans while hover outlines remain visible.',
      'CDS chevrons and translated amino-acid labels remain viewport-scoped and visible at their supported detail levels; every annotation isoform stays visible as you move between whole-assembly and detailed views.',
      'Coverage histograms and individual reads remain stable while you pan, zoom, and cross tile boundaries, and track labels and gutters stay synchronized while scrolling.',
      'The local coding-agent CLI (Claude / Codex) now resolves across every install method (npm, pnpm, yarn, and native trampolines) and no longer fails on its first turn on Windows.',
    ],
    underTheHood: [
      'Genome rendering now has target-scoped presented-frame, framebuffer, ownership, and full-assembly regression gates.',
      'Desktop releases promote their download artifacts through an R2-safe copy path so the /download page and auto-update flip reliably after every build.',
    ],
  },

  '0.7.0': {
    date: '2026-07-22',
    highlights: [
      'Open 3D structures — .pdb, .cif, .mmcif, and .bcif — straight from your project, including multi-chain models, in an interactive viewer.',
      'Right-click residues in the 3D viewer and ask the AI about them; it answers and highlights those exact residues back in the structure.',
      "Rebuilt primer creation: pick your Tm model (SantaLucia, Owczarzy salt, or NEB Q5), set 3' binding length, and preview the primer live over real dsDNA.",
      'The notebook table editor gains spreadsheet basics: select a row from its number gutter, drag to resize rows, and double-click a column edge to auto-fit.',
      'Save residue selections as durable objects you can drop into chat as reference chips and reuse across the viewer and the AI agent.',
      'DNAForge now opens with a pre-loaded Samples project: MoClo Golden Gate kits, AAV vectors, yeast and B. subtilis genomes, and demo notebooks.',
      'A ready-made CIDAR MoClo notebook shows every embed: a live 3D structure, mix-calculator tables, an expected-gel image, and clickable part links.',
    ],
    added: [
      "The structure's sequence track now marks residues absent from the coordinate model, making unmodeled gaps in a deposited structure visible.",
      'Select multiple disjoint residue ranges in the 3D viewer, including shift-click to extend a range, with exact per-residue selections.',
      'Primers you create are saved as files in your project via a built-in folder picker and registered in your primer library.',
      "Finalizing an assembly records its designed primers as oligos in your primer library and 'Find primers', tagged with their assembly origin.",
      'New sample content: the Universal Loop (uLoop) Golden Gate assembly kit with 24 public-domain receiver vectors.',
      'The example project bundles 400+ redistributable MoClo/Golden Gate kit parts (YTK, CIDAR, EcoFlex, Plant, Open Yeast, Open Plasmids) plus curated NCBI plasmids.',
      '@-mention a sequence, design, or page in a notebook and click the chip to jump right to it — mentions are now live links, not just labels.',
      'Connect an AI provider — a Claude or ChatGPT subscription, or an API key — right from the Ask-AI chat, with keys checked before saving and no detour into Settings.',
      'When an organization member is demoted, removed, or leaves, any invitations they still had pending are now automatically revoked.',
      'The project file tree hides file extensions by default (Finder-style) — pUC19 instead of pUC19.gb; the full name still shows on hover and when renaming.',
    ],
    fixed: [
      'Right-button drag to rotate or pan the 3D camera is no longer interrupted by residue selection handling.',
      'A structure that fails to load can now be retried in place instead of leaving a broken, dead viewer pane.',
      "Clearer error when a saved primer can't be rebuilt into your library: the message names the exact file to fix, with likely cause and recovery.",
      'Find-in-sequence now appears in every viewer layout, including map-only view where it used to vanish; arrow keys browse matches and a click jumps to a hit.',
      'Creating a new file or folder now scrolls it into view instead of landing off-screen in a long file tree.',
      'Ask AI about a selection now opens its inline chat docked beside the pane you started from, instead of detaching from the source view.',
      'Notification toasts now capture your click and dismiss, instead of letting the click fall through to hidden buttons underneath.',
      "Entity-named tabs like 'E. coli MG1655' or 'Construct v2.1' now show their full name instead of being cut off at a dot.",
      "The desktop sign-in error toast now reads as a clear, neutral 'temporarily unavailable' message instead of leaking internal configuration details.",
      'Windows: signing in to and running the Claude or Codex CLI in Ask-AI now works reliably no matter how the CLI was installed (npm, pnpm, yarn), and the Sign-in button no longer errors.',
      'The 3D structure drawer now has its own toolbar icon and no longer stays on top hiding other drawers — clicking another tool cleanly swaps to it.',
    ],
    underTheHood: [
      'The 3D viewer reuses a single Mol* renderer per pane, cutting memory use and avoiding duplicate GPU contexts when switching tabs.',
      'Structure views hand off safely across coordinate revisions and gate interaction until the renderer is ready, preventing stale or blank panes.',
      'Notebooks with 3D-structure and table embeds now scroll smoothly with no cold-open lag or trackpad judder, and table column and row sizes persist across reopen.',
      'The same notebook opened in two projects no longer merges into one shared record — each keeps its own copy, duplicate-notebook corruption is prevented at the database level, and existing notebooks re-key on upgrade.',
      'Notebooks are now portable files as the source of truth: drop a notebook folder into a project to register it, and edits write to disk first (crash-safe).',
      'Local AI agents (Claude/Codex) can now read and set the app-wide primer Tm model, matching the in-app assistant.',
      'Saved residue selections and structure coordinates created via the AI assistant now persist reliably with crash-safe writes.',
      "The bioinformatics engine now refuses to start with a clear error if its bundled binary doesn't match your machine's chip, instead of failing silently.",
      'Hardened the enterprise SSO (WorkOS) sign-in pilot: stricter callback validation, fail-closed config handling, and reliable webhook processing.',
    ],
  },
  '0.6.3': {
    date: '2026-07-16',
    highlights: [
      'Codex CLI works again when you sign in with your ChatGPT account, including installations bundled with the ChatGPT desktop app.',
      'DNAForge now chooses the newest available Codex CLI instead of getting stuck on an older local copy.',
      'The model picker hides options that ChatGPT-account sessions cannot run and safely falls back from stale saved choices.',
    ],
    fixed: [
      'ChatGPT-authenticated Codex conversations no longer fail before the first response because of an unsupported saved model or an older CLI earlier on PATH.',
    ],
    underTheHood: [
      'Codex detection compares runnable versions across PATH, known install locations, and the ChatGPT desktop app bundle before choosing a binary.',
    ],
  },

  '0.6.2': {
    date: '2026-07-14',
    highlights: [
      'Fixed a notification that could repeat itself: the "Update ready — restart to apply" message now appears just once, instead of stacking up while DNAForge is left open.',
    ],
    fixed: [
      'The "update ready" restart prompt no longer duplicates each time the app re-checks for updates.',
    ],
  },
  '0.6.1': {
    date: '2026-07-14',
    highlights: [
      'The Windows installer is now digitally signed, so Windows no longer flags it as an unknown app when you install or update.',
      'Annotations draw faster and more completely on large sequences.',
      'The Golden Gate assistant now tells you plainly when a fragment is on the wrong strand.',
    ],
    fixed: [
      'Golden Gate polarity guidance is clearer when a fragment needs to be flipped to the opposite strand.',
      'Annotation rendering keeps up on large sequences without dropping features.',
    ],
    underTheHood: [
      'The Windows installer is Authenticode-signed via Azure Trusted Signing, clearing the SmartScreen / Dell warning path.',
      'The release pipeline builds the macOS and Windows apps in a single native parallel job graph instead of one workflow polling the other.',
    ],
  },
  '0.6.0': {
    date: '2026-07-14',
    highlights: [
      'Back up a managed project to DNAForge Cloud, share a read-only snapshot link, and keep it synced across your Macs.',
      'Ask the in-app agent about anything by right-clicking or typing "/", and it highlights the answer right back on your sequence.',
      'Sign in with Google, GitHub, email, or (when your lab enables it) organization SSO.',
      'The macOS download is roughly half the size, and the app now reports crashes automatically so we can fix them faster.',
    ],
    added: [
      'Cloud backup, read-only share links, and light cross-device sync for managed desktop projects.',
      'In-app agent permission model with a guardrail, plus project open / empty-state handling.',
      'Closed-loop Ask-Agent: right-click or slash to ask about a selection; the agent highlights its answer back.',
      'Organization SSO overlay via WorkOS for design-partner pilots.',
    ],
    fixed: [
      'Large multi-chain protein structures no longer hard-error on load, and the structure pane resizes cleanly.',
      'Post-update notifications are clearer: correct position, calmer styling, and an "installing" state on restart.',
    ],
    underTheHood: [
      'The macOS app bundle deduplicates bundled Git internals, roughly halving the download size.',
      'Automatic crash and error reporting was added, with privacy scrubbing of sensitive data.',
      'Project sync storage uses private Storage pointers with early-user quotas.',
    ],
  },
  '0.5.0': {
    date: '2026-07-08',
    highlights: [
      'DNAForge now runs on Windows — the sequence viewer, annotation editing, and the full analysis toolset, including RNA/ncRNA (Rfam) annotation, all work at parity with the macOS app.',
      'Open SnapGene files (.dna) directly. DNAForge reads them into the same editable sequence view as your GenBank and FASTA files, so you can work with SnapGene designs without exporting or converting them first.',
      'Adding and editing annotations is much smoother: the view no longer jumps when you add one, your draft highlights on the sequence as you position it, and coding-sequence annotations preview in the correct track while you draft them.',
      'Copy the protein translation of any selection in all six reading frames straight from the copy menu.',
    ],
    added: [
      'New options for how annotations are colored on the sequence.',
      'Open and browse very large table and spreadsheet files without waiting for the whole file to load.',
    ],
    fixed: [
      'Restriction-enzyme sites now use consistent colors everywhere you view a sequence, so the same site looks identical from one view to the next.',
      'Sequences keep their full visual detail while you pan and zoom instead of briefly dropping to a coarser rendering.',
      'Files imported from SnapGene keep their original source information.',
      'A batch of first-run and onboarding rough edges are fixed, so opening your first sequence is smoother.',
      'Draft annotations behave more predictably: partial drafts clear when you cancel, their styling stays consistent, and keyboard navigation in the annotation list keeps focus where you expect.',
    ],
    underTheHood: [
      'Windows builds and the release workflow gained reliability fixes, and automated test coverage was tightened.',
      'Beta analytics and diagnostics tooling were improved.',
    ],
  },

  '0.4.0': {
    date: '2026-06-27',
    highlights: [
      'Register organisms, strains, plasmids, genomes, and primers in the local LIMS, then find those records from the registry instead of hunting through project files.',
      'Import single files, import folders with progress, move files, send files to Trash, and archive or restore projects from the file tree.',
      'Golden Gate assembly now reports internal enzyme cut sites before you accept an assembly plan, and auto-optimization no longer hits the previous error path.',
      'AI chat can start without an open project and now shows first-message send errors, CLI sign-in status, model choices, and provider setup actions.',
    ],
    added: [
      'The LIMS registry now covers organisms, strains, plasmids, genomes, and primers, including registered-file badges.',
      'The file tree now supports single-file import, folder-import progress, Trash, archive / restore, and move / rename validation before crossover edits.',
      'Tabs now support Cmd-W to close, Cmd-Shift-T to reopen, and a clearer unsaved-change dot.',
      'Assistant settings now include host selection, model selection, direct API key setup, and CLI sign-in entry points.',
    ],
    fixed: [
      'Golden Gate auto-optimization no longer errors on difficult designs and is about 60x faster on the benchmark case used for this release.',
      'Sequence edits now wait for an explicit Save instead of auto-committing midway through an edit.',
      'The sequence viewer now restores per-file 1D / 2D / WebGL mode, WebGL map shape, and saved viewport when tabs reopen.',
      'Programmatic jumps to sequence annotations now land on the same feature position in WebGL and 2D views.',
      'First-message chat send failures now appear in the chat UI instead of failing silently.',
      'Packaged builds now find CLI tools when launchd strips PATH, use bundled Git, migrate old user-data directories, and fail closed when the sidecar URL is missing.',
    ],
    underTheHood: ['The release-please workflow now requires a real release token instead of falling back to the default GitHub Actions token.',
'Electron E2E now runs in per-file shards, and packaged auto-update has a dedicated L3 test before release.',
'Closed-beta allowlist, install-attribution, and tool-usage telemetry were added for beta diagnostics.'],
  },

  '0.3.2': {
    date: '2026-06-24',
    highlights: [
      'Automatic updates work again. Once you are on this version, DNAForge downloads and installs future updates on its own — this is the last time you need to update by hand.',
    ],
    fixed: [
      'The app had stopped detecting new versions, so automatic updates silently never arrived. This is fixed.',
    ],
    underTheHood: [
      'The in-app updater now reads its release feed from the public download CDN instead of the source repository, so update checks no longer depend on repository access.',
    ],
  },

  '0.3.1': {
    date: '2026-06-23',
    highlights: [
      'The WebGL sequence viewer renders more faithfully: scrolling across the origin of a circular sequence is now continuous, and ruler positions, glyph weights, and reverse-complement colors are correct.',
    ],
    fixed: [
      'Circular sequences no longer jump or break at the origin when you scroll past it in the WebGL viewer.',
      'Ruler origin indexing, highlight occlusion, codon glyph weight, reverse-complement coloring, and chevron aspect now render correctly.',
    ],
    underTheHood: [
      'Security hardening: Row-Level Security is enforced on every public registry table, with a fail-closed CI gate so a new table can never ship without it.',
      'Release-pipeline hardening so beta builds promote reliably and a tester can always get a build.',
    ],
  },

  '0.3.0': {
    date: '2026-06-22',
    highlights: [
      'LIMS: keep your strains, plasmids, and primers in one searchable registry, and import them directly from your existing files.',
      'Golden Gate assembly auto-optimizes overhangs reliably (and much faster), and flags enzyme cut sites inside your parts before you build.',
      'Right-click a sequence selection and choose Attach Primers to open a primer Find drawer already scoped to that region.',
      'Your viewer layout now persists per file: 1D / 2D / WebGL mode, zoom, and map shape come back when you reopen.',
    ],
    added: [
      'A LIMS registry with file-backed import, organism roll-ups, resizable columns, and an expandable detail overlay.',
      'An internal cut-site audit in Golden Gate assembly, with a stepper to review and resolve flagged sites.',
      'An agent-loadable assembly demo project for walking through the assembly flow end to end.',
    ],
    fixed: [
      'Golden Gate optimization no longer errors on difficult designs and completes dramatically faster.',
      'The WebGL viewer map shape (stadium vs circle) and scroll position now restore correctly on reopen.',
    ],
    underTheHood: [
      'LIMS reads and writes run against the real local engine over SQLite, so tested behavior matches the shipped app.',
      'Closed-beta groundwork: an unlisted install path and per-tool usage signals to learn which tools beta users reach for.',
    ],
  },

  '0.2.18': {
    date: '2026-06-18',
    highlights: [
      'You can now sign in to DNAForge from the desktop app with email, Google, or GitHub.',
      'Signed-out desktop use remains fully functional; accounts add identity and future cloud-connected workflows without blocking local work.',
      'Your signed-in identity now appears in the activity bar with avatar, email, and one-click sign-out.',
    ],
    added: [
      'Desktop sign-in supports an in-app 6-digit email code plus browser-based Google and GitHub OAuth that returns automatically to the app.',
      'The bottom-left account popover now shows the current account and a placeholder Account settings entry.',
      'Desktop auth uses production-compatible callback handling instead of relying on a custom URL scheme.',
    ],
    fixed: [
      'OAuth sign-in now completes through a server-side PKCE exchange so the desktop app does not hold Google or Supabase provider tokens.',
      'Signed-out users can continue opening genomes, working in the assembly surface, and using notebooks without account prompts.',
    ],
    underTheHood: [
      'Desktop sessions use first-party Ed25519 access tokens plus opaque rotating refresh tokens with reuse detection.',
      'Credentials are stored through the OS keychain via safeStorage, and email-verified trust comes from server-controlled confirmation.',
      'Live desktop sign-in coverage now exercises the full email and OAuth stack before merge.',
    ],
  },

  '0.2.17': {
    date: '2026-06-15',
    highlights: [
      'Residue selections now stay in sync between coding-sequence amino-acid rows, the structure drawer, and the Mol* canvas.',
      'Command-clicking amino-acid renderings can select the corresponding structure residues, including multi-chain ATP synthase examples.',
      'Empty clicks in the Mol* canvas no longer clear your residue selection; clearing is now an explicit action.',
    ],
    added: [
      'Residue selection sync now works from sequence views into the structure drawer and back from structure interaction into coding-sequence highlights.',
      'Structure-linked residue selection now includes real ATP synthase and VPS8 fixture coverage for local and automated verification.',
      'A residue-structure sync probe is available for debugging live app state after Mol* or sequence-viewer changes.',
    ],
    fixed: [
      'Multi-chain atpD selections now preserve the correct residue register across the resolved 6OQR beta-chain protomers.',
      'Structure-linked selections no longer resolve through unrelated bare structure ids when a source sequence owns the link.',
      'The live Electron Mol* gate now runs for sequence-editor selection changes and checks real selected-residue readback.',
    ],
    underTheHood: [
      'Residue selections now use a selector-agnostic source-of-truth model with coding-DNA mappings instead of storing nucleotide coordinates as the primitive.',
      'The Mol* drawer, in-drawer amino-acid row, sequence viewer, WebGL overlay, and automation bridge now consume the same residue-selection state.',
      'The regression ladder covers atpG monomer selection, atpD register-sensitive multimers, atpE c-ring fanout, explicit clear semantics, and live Mol* readback.',
    ],
  },

  '0.2.16': {
    date: '2026-06-13',
    highlights: [
      'Claude Code chat now uses your signed-in local subscription session even when the app was launched from an environment with Anthropic API keys.',
      'AI file and project questions are more reliable about using app tools before answering.',
      'Agent evaluation runs now keep separate historical result files instead of replacing the last report.',
    ],
    fixed: [
      'Claude Code readiness checks, sign-in, and chat requests no longer inherit ambient Anthropic or Claude Code auth variables from the parent process.',
      'Direct API conversations now force an initial tool call when a request explicitly names a tool or clearly needs files, tabs, feature lookup, imports, or project state.',
      'AI eval assertions now expand collapsed tool activity groups before checking rendered tool results.',
    ],
    underTheHood: [
      'Claude CLI subprocesses now receive an explicit operational environment that keeps local subscription config locations while stripping API-key and backend-selector state.',
      'The AI eval harness now records per-run JSON artifacts plus JSONL history with worker and shard metadata.',
      'Fixture-blocked reference scenarios are marked as WIP signal until richer per-scenario biological fixtures are available.',
    ],
  },

  '0.2.15': {
    date: '2026-06-12',
    highlights: [
      'Sequence right-click menus now keep the full selection action set in 2D, 1D, and WebGL views.',
      'Copy Sequence, reverse complement, translation, and reverse translation actions now sit at the top of mixed context menus.',
      'CDS and structure target names now have compact target styling without truncating normal annotation names.',
    ],
    fixed: [
      'Right-clicking inside an active selection on a CDS or annotation no longer drops Copy Sequence, primer, or Add Annotation actions.',
      'Add Annotation now uses the same neutral menu styling as the other selection actions.',
      'Dynamic annotation names in the menu no longer ellipsize early when the menu has room to show them.',
    ],
    underTheHood: [
      'The 2D and 1D viewers now pass the active range at right-click time into the shared context-menu resolver.',
      'Selection and feature menu resolution now has browser evidence and real Electron parity coverage across 2D, 1D, and WebGL.',
    ],
  },

  '0.2.14': {
    date: '2026-06-12',
    highlights: [
      'Packaged desktop builds now initialize crash reporting correctly.',
      'Main-process and renderer-process crashes can now reach the DNAForge crash dashboard after release.',
      'The release pipeline now checks both desktop crash-reporting paths before a build ships.',
    ],
    fixed: [
      'Desktop release builds now carry the crash-reporting endpoint into both the main app process and the renderer.',
      'Packaged app crashes are no longer invisible because of release-only environment-variable gaps.',
    ],
    underTheHood: ['Release and release-validation workflows now pass the Sentry DSN through the Electron build, package, and publish-equivalent steps.',
'The Electron main process now reads a build-time Sentry DSN constant with the runtime environment as a development fallback.'],
  },

  '0.2.13': {
    date: '2026-06-12',
    highlights: [
      'A first local LIMS slice is available for registering oligos, plasmids, genomes, strains, and organisms.',
      'Primer spreadsheets and sequence files can be previewed, reviewed record by record, and applied as logged import batches.',
      'Sequence tabs now show whether the open file is registered in LIMS, unresolved, or drifted after file changes.',
      'Accepted assemblies can be finalized into registered LIMS entities while existing primer bindings remain intact.',
    ],
    added: [
      'Local LIMS records now use audited desktop SQLite tables with schema-driven defaults and repeatable registration behavior.',
      'Conventional CSV, TSV, XLSX, GenBank, and FASTA imports now support dry runs, duplicate detection, row rejection, source checks, and apply-time audit logging.',
      'The sequence viewer now includes a compact registration badge that updates when source files change.',
      'Accepted assembly products can now be registered as deterministic LIMS plasmid or genome entities from the assembly workflow.',
    ],
    fixed: [
      'LIMS queries now apply JSON field filters before result limits so filtered lookups are stable.',
      'Registration badge candidates now prefer the newest matching record when the same source is registered again.',
    ],
    underTheHood: [
      'Primer reads now bridge LIMS oligos marked for primer use with the legacy primer table without migrating existing primer foreign keys.',
      'LIMS schema migrations, operation rollback, import batches, badge telemetry, accepted assembly registration, and Electron IPC paths are covered by unit, component, and end-to-end tests.',
    ],
  },

  '0.2.12': {
    date: '2026-06-11',
    highlights: [
      'Conversation history is now captured to a background event log while the familiar chat view continues to load normally.',
      'Chat reload coverage is stronger for both Direct API conversations and local agent sessions.',
      'The current chat title stays visible beside the history control when the conversation list is collapsed.',
      'Selecting a conversation no longer closes the history panel unless the panel itself is unpinned and the pointer leaves it.',
    ],
    added: [
      'Provider and local agent chat turns now write a replayable background transcript log alongside the existing chat database.',
      'Diagnostics can replay captured events and compare the rebuilt transcript with the current chat history rows.',
      'Electron coverage now verifies provider and CLI transcripts survive renderer restart through the existing persistence path.',
    ],
    fixed: [
      'Chat history selection now follows the pinned or hover state instead of collapsing immediately after a conversation click.',
      'Concurrent background transcript writes keep their manifest index consistent.',
      'Provider transcript writes are allowed a bounded flush after turn completion so normal chat stays responsive even if the background log is slow.',
    ],
    underTheHood: [
      'Added a shadow append-only JSONL conversation event ledger with per-conversation ordering, torn-line recovery, projection, parity diagnostics, and best-effort conversation unlinking.',
      'Provider streaming now consumes the full stream once and derives both visible chat blocks and background ledger events from that ordered stream.',
      'The existing SQLite chat read path remains the live source for this release while the event ledger is validated as the future source of truth.',
    ],
  },

  '0.2.11': {
    date: '2026-06-11',
    highlights: ['Stability and internal development-tooling improvements.'],
    underTheHood: [
      'Improved reliability of the internal fixture-replay tooling and its persisted-state handling across desktop profiles.',
      'Expanded unit and real-Electron coverage for the internal fixture tooling.',
    ],
  },

  '0.2.10': {
    date: '2026-06-10',
    highlights: [
      'Local DNA sequence files are now clearly treated as the source of truth for bases and annotations.',
      'The primer picker now reads from the real primer library instead of an unused annotation table.',
      'Database upgrades remove the retired feature table that could make empty local data look authoritative.',
      'Internal guards now catch new SQLite tables that do not declare whether they are authoritative, derived, cached, or retired.',
    ],
    added: [
      'A source-of-truth map for desktop data stores, including sequence files, project memory files, and every local SQLite table.',
      'A schema guard that fails when a new SQLite table is missing a data authority classification.',
    ],
    fixed: [
      'Junction workbench source context continues to resolve from sequence files when SQLite sequence rows contain no bases.',
      'Notebook primer mentions use primer-library rows directly, so they no longer depend on the retired feature table.',
    ],
    underTheHood: [
      'Schema v8 drops the writer-less features table and its indexes.',
      'Migration tests now cover upgrading through v8 and fresh schemas no longer create the retired table.',
    ],
  },

  '0.2.9': {
    date: '2026-06-09',
    highlights: [
      'The AI assistant can now run through Direct API keys or your signed-in Codex CLI and Claude Code installs from one chat surface.',
      'CLI sign-in can be started directly from DNAForge, including from the chat composer when a selected CLI host needs authentication.',
      'Agent activity is easier to inspect: tool activity stays with the chat, collapses after completion, and keeps the final answer readable.',
      'Settings now separate assistant hosts, saved API credentials, and external DNAForge tool access more clearly.',
    ],
    added: [
      'Searchable Direct API credential management backed by the OS keychain.',
      'Claude Code and Codex CLI host detection, authentication, model, and reasoning-effort controls.',
      'Persistent chat turns with per-turn route snapshots so conversations record which host/model handled each message.',
      'External access-key management for scripts or MCP clients that need scoped DNAForge tool access.',
    ],
    fixed: [
      'Stopping a CLI-backed assistant turn now propagates to in-app renderer tool calls for that turn.',
      'CLI protocol events are filtered from the chat transcript while useful activity remains visible.',
      'Chat turn creation is now atomic in the Electron main process, preventing unrelated database writes from joining the wrong transaction.',
      'Agent grant management now resolves the sidecar URL at runtime in packaged app launches.',
    ],
    underTheHood: [
      'Agent host descriptors now separate hosts, providers, models, transport, and authentication state.',
      'The agent bridge has real Electron coverage for CLI authentication and preload/main IPC behavior with host-agnostic fake CLIs.',
      'Architecture checks now require MCP-sensitive UI surfaces to be classified as exposed, planned, adjacent, or not applicable.',
    ],
  },

  '0.2.8': {
    date: '2026-06-04',
    highlights: [
      'Structure views are more reliable for complex proteins and RNA/protein assemblies, with live MolStar rendering now checked against real viewer state.',
      'Structure controls are clearer: recipe-backed view selection, layer visibility, focus selection, and color modes now update through one consistent rendering path.',
      'Selected complex chains keep their colors across view switches instead of falling back to gray.',
      'Large structure previews, candidate picking, and fallback rendering are more stable when switching between complex, surface, and atomic-detail views.',
    ],
    added: [
      'Recipe-backed structure view modes for complex, surface-context, illustrative, and atomic-detail workflows.',
      'Live regression coverage for multi-chain RCSB complexes, ribosome-scale structures, color themes, candidate picker stability, and structure drawer previews.',
      'Fixture-backed structure drawer coverage for RCSB and AlphaFold candidate previews.',
    ],
    fixed: [
      'Selected complex chains no longer lose their assigned colors when switching structure views.',
      'Chain toggles no longer rebuild expensive surface overlays unnecessarily.',
      'MolStar fallback paths no longer blank the viewer or reopen the candidate picker.',
      'Chain, element, and B-factor color modes now apply to live MolStar state more consistently.',
    ],
    underTheHood: [
      'Structure rendering now flows through a deterministic scene model, render transaction, and MolStar render plan.',
      'Structure viewer gates now require live evidence rather than only reducer or mock state.',
      'Repo-wide build checks were restored for WebGL fixture imports and production build environment handling.',
    ],
  },

  '0.2.7': {
    date: '2026-05-26',
    highlights: [
      'Golden Gate junction editing is safer. Palindromic overhangs are now hard-excluded from scoring and auto-optimization, so invalid self-ligating candidates are no longer recommended.',
      'Golden Gate workbenches now show the Auto-optimize action and promote invalid overhang findings into a workbench-level banner, making problems visible before finalization.',
      'Primer binding site spinner clicks now auto-commit after a short idle pause, so repeated adjustments update the design without requiring an explicit blur or Enter press.',
      'Gibson cut-site visualization now follows the actual primer-tail geometry, keeping spacer and overlap displays aligned with the physical PCR products.',
    ],
    added: [
      'Auto-optimize button for Golden Gate junction workbenches.',
      'Workbench-level invalid Golden Gate overhang banner with per-junction labels.',
      'Debounced PBS spinner auto-commit after rapid up/down adjustments.',
    ],
    fixed: [
      'Palindromic Golden Gate overhangs no longer score as valid high-fidelity candidates.',
      'Gibson product-row cut-site line now derives from primer-tail geometry instead of stale encoding fields.',
      'Source-register dragging preserves preview performance by avoiding unnecessary model rebuilds during drag.',
      'PBS auto-commit now respects the latest disabled state before writing a delayed change.',
    ],
    underTheHood: [
      'Expanded Golden Gate overhang scoring regressions, including all 16 four-mer palindromes.',
      'Added motion-quality coverage for source-register drag performance.',
      'Added strict fallback behavior for partially migrated Gibson overlap constraints.',
    ],
  },

  '0.2.6': {
    date: '2026-05-25',
    highlights: [
      'Core desktop stores now share a uniform revision counter, improving the foundation for stale-state detection across sequence, design, page, and structure workflows.',
      'Sequence cache writes now centralize per-path version bumps, reducing duplicate update paths and lowering the risk of stale sequence views.',
    ],
    added: [
      'Uniform store revision middleware for the main desktop Zustand stores.',
      'Project documentation for the store revision pattern.',
    ],
    fixed: [
      'Sequence cache version updates now happen in one store action instead of scattered caller-side increments.',
      'The deprecated manual sequence version increment path was removed to prevent future double-bump regressions.',
    ],
  },

  '0.2.5': {
    date: '2026-05-20',
    highlights: [
      'Git safety checks now run through the active Husky hook chain, so branch guards and downstream quality gates fire consistently before commits and pushes.',
      'Direct pushes to protected production branches are blocked, while release tag pushes continue to work from the primary checkout.',
      'Developer machines with stale hook configuration now self-heal during the migration grace period.',
    ],
    added: [
      'Pre-push guard for direct prod/staging pushes and primary-checkout branch invariants.',
      'Re-introduction guard preventing new staged files under the old `.githooks/` path.',
      'Migration shim for machines still configured to use the old hook path.',
    ],
    fixed: [
      'The primary-checkout branch guard now runs through Husky instead of being bypassed by the active `core.hooksPath` setting.',
      'The existing lint, secret, fixture-provenance, WebGL, and screenshot gates remain chained behind the active hook entry point.',
    ],
  },

  '0.2.4': {
    date: '2026-05-19',
    highlights: [
      'Assemblies now have a linked 1D junction workbench. Gibson, NEBuilder, and Golden Gate designs can be inspected and adjusted around each junction with live source/product previews.',
      'Golden Gate designs can now preview ranked overhang candidates before applying them, with the current manual design shown separately from temporary previews.',
      'Accepted assemblies now write a GenBank design plus assembly metadata and primer export files so finalized designs can be reopened with construction context intact.',
      'Restriction-digest fragments, spacers, primers, and CDS annotations now preserve more of their source provenance through assembly edits.',
    ],
    added: [
      'Product-centered junction editing for Gibson, NEBuilder, and Golden Gate assembly drafts.',
      'Ranked Golden Gate overhang candidate table with preview/apply flow.',
      'Accepted assembly artifact bundle with GenBank, metadata, primer CSV, and primer FASTA outputs.',
    ],
    fixed: [
      'Previewed Golden Gate optimizer rows are now visually distinct from the committed current design.',
      'Restriction-digest junctions now lock biologically fixed overlap sides instead of exposing invalid edit affordances.',
      'Junction source rows keep non-contributing bases visible while fading them instead of dropping provenance context.',
    ],
    underTheHood: [
      'Added real assembly workflow fixtures for PCR, restriction digest, spacer, Gibson, NEBuilder, and Golden Gate cases.',
      'Added assembly workbench contracts for live preview, capability decisions, provenance projection, optimizer behavior, accepted-artifact writes, and renderer tool allowlisting.',
    ],
  },

  '0.2.0': {
    date: '2026-05-05',
    highlights: [
      'Genome-scale workflows are faster and more reliable. DNAForge now has the foundation for indexing large genomes in the sidecar, with progress and observability hooks built in.',
      'Structure-viewer automation is much more capable. Agent workflows can open structures, focus residues, change representations, and capture screenshots from the Mol* viewer.',
      'Primer orientation is safer. Orientation now belongs to each template binding instead of the primer itself, avoiding mismatches when the same primer is reused in different contexts.',
      'Update checks are quieter and clearer. Background downloads stay silent until a restart is needed, and failed checks now explain whether retrying can actually help.',
    ],
    added: [
      'Genome indexing service foundations for large FASTA/GenBank assets.',
      'Mol* structure-viewer tools for opening PDB, UniProt, allow-listed URLs, and inline structure data from agent workflows.',
      'Screenshot capture from active structure viewers for downstream review and debugging.',
    ],
    fixed: [
      'Packaged-app startup reliability improved for Electron ESM bundles and pnpm dependency layouts.',
      'PostHog analytics dependencies are included correctly in packaged builds.',
      'Download surfaces now show the app version consistently where available.',
    ],
    underTheHood: [
      'CI now scopes common PR checks through the Nx affected graph, with Electron and desktop E2E suites sharded for faster feedback.',
      'Release and packaging gates now validate cache contracts, package contents, and architecture-specific outputs more consistently.',
      'The primer schema migration is guarded so existing projects upgrade without losing orientation data.',
    ],
  },

  '0.1.0': {
    date: '2026-04-26',
    highlights: [
      'New 1D sequence viewer for long sequences. Toggle between 1D (horizontal scroll) and 2D (wrapping) — works smoothly from short plasmids up to chromosome-scale.',
      'Smarter annotation review. Plannotate suggestions are now visually distinct from real annotations (filled = real, outlined = draft), with a two-section review panel separating new candidates from features already on the sequence.',
      'Project Git tracking. The Source Control panel now shows modified, untracked, and deleted files for any folder. Right-click a folder to initialize a Git repository without leaving the app.',
      'Chrome-style tabs. Active tab is now visually unmistakable; hovering an inactive tab fades the dividers around it, exactly like Chrome.',
    ],
    added: [
      '1D sequence viewer with synthetic horizontal scroll, wheel zoom, autoscroll on selection drag. Origin-spanning selections, annotations, primers, and view cursors render correctly across the seam in circular sequences.',
      'Project-level Git tracking with an actionable empty state — initialize a repository from inside the file tree.',
      'Persistent sequence info bar between the tab strip and the canvas (project-relative path + length + topology).',
      'Spreadsheet formula autocomplete in tables (=A1, =SUM(...)) with Tab/Enter completion, drag-pick ranges, and operator separator handling.',
      'Ctrl+Tab / Ctrl+Shift+Tab cycles tabs within the focused pane.',
    ],
    fixed: [
      'Notebook typing no longer lags on pages with embeds (3D structures, Plannotate panels). Each keystroke used to re-render every embed; now embeds stay mounted across edits.',
      'Alignment manager staleness detection now works correctly per-session. Previously, opening multiple sessions could mask staleness in any non-first session.',
      'Re-aligning a non-active alignment session now actually completes (was silently aborting).',
      'Vertical trackpad swipes now scroll the horizontal axis in the 1D sequence viewer.',
      'Settings → About now shows the actual installed version (was hardcoded).',
      'File-tree colors no longer green by default — only git status drives color (modified=yellow, untracked/added=green, deleted=red).',
      'Large-sequence zoom now works down to 0.2% with annotation markup preserved (previously rendered illegible flecks below ~5%).',
      'GenBank file icon redesigned as a tighter Lucide DNA helix.',
    ],
    underTheHood: [
      'Test-fixture audit completed. Lab-derived plasmids (pPCY*, pKKG*, slq*, rubisco-region) replaced with NCBI-accessioned or deterministic-synthetic equivalents. New CI gate enforces provenance metadata for every fixture.',
      'Auto-update verification end-to-end. v0.0.2 → v0.1.0 upgrade rehearsed before release.',
      'Bundle leak class closed: __fixtures__ and __tests__ trees are now excluded from app.asar at packaging time.',
      'Deterministic-rebuild script for synthetic test fixtures (fixed-seed, byte-identical re-runs).',
      'Pre-commit fixture-provenance gate; new e2e-spec-guard CI job; consumer retargeting across all packages.',
    ],
  },

  '0.0.3': {
    date: '2026-04-18',
    highlights: [
      'Auto-update safety layer. Your unsaved work is now protected when an update installs — a system dialog appears if any tabs have pending edits and offers to cancel or proceed.',
      'Automatic database backup before every migration. The last 5 backups are kept under your application support directory; if a destructive migration would proceed without a successful backup, the migration is aborted instead.',
      'Update-banner error states. If a download fails (network timeout, bad signature), the banner switches to a red error state with the failure stage and a Retry option instead of hanging silently.',
      'Beta channel opt-in (settings.beta_updates = 1) and staged rollout support in the release YAMLs.',
    ],
    added: [
      'Single-instance lock — opening a second DNAForge window now focuses the existing window instead of fighting over the local database.',
      'Sidecar version handshake — the Python sidecar is now started with the app version and pinged at startup; mismatch is a hard error.',
    ],
    fixed: [
      'Unsaved-work dialog no longer blanks the sequence tab on Cancel.',
      'quitAndInstall is now idempotent — second call falls back to app.quit() instead of no-op.',
      'Update-download state now resets after a failed retry (was stuck on isDownloading).',
      'Quit consent is granted only AFTER you confirm the dialog (TOCTOU fix).',
      'Before-quit order corrected: dialog → save → kill sidecar → close DB → analytics → quit (was killing the sidecar before prompting).',
      'macOS sidecar smoke test now correctly detects crashes on release runners.',
    ],
    underTheHood: [
      'Release pipeline audit (13 hardening fixes). Validate-tag-matches-package.json runs on every tag push.',
      'verify-package.cjs hard-fails when bundled binaries are missing or wrong arch.',
      'Sentry Release Health alert wired (crash-free sessions < 99%).',
      'PostHog migration-failure webhook + app_migration_backup / app_update_install_* / app_update_error events.',
      'Bad-release runbook (docs/RUNBOOK_BAD_RELEASE.md) — one-page recovery commands.',
      'New mocked-update.e2e.ts stands up a local update server and runs real electron-updater against it.',
    ],
  },

  '0.0.2': {
    date: '2026-04-15',
    highlights: [
      'Code-signed and notarized for macOS — no more Gatekeeper warnings.',
      'Automatic updates via GitHub Releases. The app checks for updates in the background and prompts you when one is ready.',
      'Crash reporting with Sentry (anonymous, opt-out in Privacy settings).',
      'In-app feedback widget — submit a bug or feature request without leaving the app.',
    ],
  },
};

export function compareReleaseVersionsNewestFirst(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

export const VERSION_HISTORY = Object.keys(RELEASE_NOTES).sort(compareReleaseVersionsNewestFirst);

export function getReleaseNote(version: string): ReleaseNote | null {
  return RELEASE_NOTES[version] ?? null;
}
