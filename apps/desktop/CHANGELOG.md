# 0.9.23 (2026-11-04)

- Quit and restart without saving after a document edit fails.
- Wait for workspace readiness before reopening restored documents.
- Keep saved Track View close actions with their own document owner.

# Changelog

## [0.9.22] - 2026-11-04

### Highlights

- Recover a damaged DNA sequence into a separate saved copy, with uncertain bases marked as N.

### Fixed

- Recovery keeps the original file unchanged and includes its complete contents inside the recovered sequence.
- Every recovered position is annotated, and the saved sequence can be closed and reopened.
- Invalid-character errors show the character and its source line and column.

## [0.9.20] - 2026-10-31

### Highlights

- Registry can stay in sync with a living Google Sheet or a local Excel master workbook, keeping each row's record identity.
- Notebook sections can place content in two or three columns.
- Paired FASTQ reads can be trimmed and merged as a managed job.
- Primer design can build per-residue saturation mutagenesis libraries.
- The chat box shows each AI agent's own permission settings and asks for approval in one card.

### Fixed

- The sign-in screen says up front that a new code can be requested 60 seconds after the last one.
- Every protein tab is labelled View, with one entry per view.
- Document titles hide file extensions by default.
- The tracks view draws an RNA complement strand with U.
- Assembly design follows your saved PCR temperature and overlap rules, and Save keeps a saved assembly.
- CDS outlines and hover highlights match what is drawn at every zoom.
- Closing a text file saves its latest edit first.
- Terminal colors follow the app theme and no longer flicker when the panel is resized.
- Windows members can pull projects that contain notebooks without sync stalling.
- People with view-only access to a shared project can no longer change its files, sequences or records.
- New company projects start shared only with their creator instead of the whole organization.

### Under the hood

- Reference genomes download from references.dnaforge.com.
- External agents connected through MCP can send app feedback and receive structured tool results.
- Improved reliability of Find, ORF detection and translation copying in sequence views.

## [0.9.19] - 2026-10-28

### Highlights

- The integrated terminal has improved command editing, suggestions and controls.
- Open-source license details are available in Settings.

### Fixed

- Annotated GenBank reference genomes can be imported on desktop.
- Unsaved text and script edits prevent a sync pull from overwriting local work.
- Saved alignments can find their reads by sequence instead of relying on file names.
- Email sign-in explains why a code could not be sent.
- Usage analytics can be enabled again in Settings after being turned off.

### Under the hood

- Improved diagnostic reliability for app startup, sign-in, Hosted AI and saved scientific workflows.

## [0.9.18] - 2026-10-23

### Highlights

- Chat history keeps your conversations and unfinished edits when loading or saving a change fails.
- Jobs keeps active work visible and distinguishes stopping a run from releasing its saved result.
- Skills follows project-specific choices and offers a fresh review when an installation needs to be retried.

### Fixed

- A failed chat-history refresh shows Retry instead of an empty history, while keeping the last loaded chats.
- Late rename and pin results no longer overwrite newer chat edits.
- An older Jobs refresh cannot overwrite a newer Stop or result-import outcome.
- The Jobs sidebar shows active work even when the recent history limit is reached.
- A failed skill-source refresh keeps previously loaded skills, and retrying after a completed install does not install it twice.

## [0.9.17] - 2026-10-22

### Highlights

- Open project sequences reliably from the file menu and keyboard shortcuts.
- Circular map arrowheads and hover outlines follow the visible sequence geometry.

### Fixed

- Opening a sequence package from its context menu no longer opens its folder as a text file.
- Hovering a coding feature with separated segments no longer draws an outline across the gap.
- Circular feature arrows stay within the visible ribbon when zoomed in.
- Recover valid loose sequence files already inside projects and report the exact invalid character for damaged sequence files.
- Update failures distinguish a download interruption from a failure to prepare an already downloaded update.

### Under the hood

- Improved diagnostics for interrupted app updates.

## [0.9.16] - 2026-10-21

### Highlights

- Projects remain available after reloading a window that stopped responding.

### Fixed

- Reload Window no longer leaves every project reporting that its records could not be loaded or blocks further edits.

## [0.9.15] - 2026-10-20

### Highlights

- Open an integrated terminal inside DNAForge, with separate tabs, split panes and searchable output.
- On Windows, use Windows Subsystem for Linux to sign in to saved remote hosts, open alignment and signal tracks, and reopen saved views.
- Notebook insertion dialogs and structure menus have solid backgrounds, clearer keyboard navigation and reliable focus when they close.
- Circular genome maps stay visible in narrow panes, and map zoom changes are saved when you reopen a view.

### Fixed

- The track picker marks loaded catalog tracks on their own rows, keeping the count, sorting and Columns controls in place.
- Applying annotation results no longer asks you to reopen a document that has already refreshed.
- Sequence imports avoid exposing an incomplete project record while files are being written on local disks.
- Quitting DNAForge continues the remaining shutdown steps if stopping one service fails.

## [0.9.14] - 2026-10-14

### Highlights

- The sequence viewer uses graphics-accelerated drawing for wrapped sequences, with the familiar scrolling, zooming and editing controls.
- Import files through a compact selection table, choose destinations across projects and folders, and find every imported result in the project tree.
- AI chats keep your draft and context when a selected model is unavailable, with clearer choices to refresh or change the model.

### Fixed

- Coding-region extension arrows stay inside the visible sequence pane when rows wrap or scroll.
- Primer edits save to the current project and keep unfinished drafts.
- Annotation review keeps your selections and displays the saved document.
- Stopping an AI response keeps its delivered text and shows provider errors once.
- Remote SSH hosts refresh after changes, with clearer Terminal sign-in and reconnect actions.

## [0.9.13] - 2026-10-08

### Organization syncing

- Shared organization sequences keep their identity, history and attachments when teammates edit them in the browser or desktop app.
- Offline edits stay available after a restart. When teammates change the same record, choose which version to keep before syncing.
- Large attachments stay with shared projects and are reused when unchanged.

### Fixed

- Removing a member ends their access to organization projects while preserving the files already on their computer.

## 0.9.3 (2026-09-23)


### Features

* **desktop:** tighten the macOS installer window (#2247)
* **genome:** IGV and UCSC import-channel parity for the genome viewer (#2258)
* **import:** allow ZIP archives in Import with agent  (#2250)


### Bug Fixes

* **desktop:** hard-gate bundled Git readiness  (#2193) (eff2690)
* **desktop:** isolate non-release builds and reinstate a newer preserved database  (#2242) (d8396c8)
* **hosted-ai:** prevent continuation size outages (#2214) (2db6a25)
* **hosted-ai:** remember the chosen tier across sign-in (#2237) (23dc9fb)
* **desktop:** clear a profile lock held by an engine that outlived its app (#2264)
* **desktop:** keep Temurin identity in the minimized PDF runtime  (#2245)
* **desktop:** name telemetry screens and stop chromosome-end sequence reloads (#2265)
* **desktop:** rename a finished plasmid from its tab  (#2253)
* **desktop:** signed packages change the PDF runtime's bytes on macOS too  (#2266)
* **desktop:** stop packaged macOS sidecar after app exit  (#2252)
* **genome-viewer:** stop end-of-chromosome stalls in the indexed viewer  (#2259)
* **chat:** keep AI approvals in their chat and wrap Grok Build output  (#2257)
* **chat:** paste a copied sequence into chat as a source chip  (#2275)
* **lims:** show unconnected relationships on the entity  (#2263)
* **mcp:** external clients reach a live app despite stale runtime registrations  (#2278)
* **registry:** split joined Benchling relationship names  (#2254)
* **sequence:** no black flash or clipped spinner on tab switch  (#2271)


### Performance Improvements

* **desktop:** reduce packaged footprint and remove dead helpers  (#2209) (d257b9c)

## 0.9.2 (2026-09-21)


### Features

* **genome:** compose configurable indexed track views (#2165) (886401b)
* **web:** establish shared hosted workspace runtime  (#2105) (a833b5d)


### Bug Fixes

* **:** contain unsafe extension runtime (#2186) (23b567c)

## 0.9.1 (2026-09-21)


### Features

* Open prepared Chinese Spring wheat (#2153), SARS-CoV-2 Wuhan-Hu-1 (#2115), and eleven bacterial genomes (#2132, #2136) from the References picker.
* Translate each sequence with the genetic code that record declares, and choose a code when the file does not say (#2022).
* Index and browse chromosomes that are too long for the previous TBI index format, including wheat-scale chromosomes (#2144).
* Use a compact toolbar on indexed genomes and a refined chromosome overview (#1927).


### Bug Fixes

* Add a local reference and reopen an indexed genome more reliably (#2092).
* Preview where an incomplete CDS reading frame really ends, not only the annotated span (#2079).
* Show prokaryotic product tracks without requiring an mRNA seed scene (#2106).
* Treat genomic RNA on viral references such as SARS-CoV-2 as genomic sequence, not a transcript envelope (#2099).

## 0.9.0 (2026-09-18)


### Features

* **agent:** expose installed app MCP entry point (#1924) (e0599f1)
* **alignment:** manage pairwise session operations (#1990) (8a10a12)
* **analytics:** restore rich PostHog capture (#1966) (435e467)
* **:** verify saved annotation edit lineage (#2023) (01d3889)
* **:** add interactive pileup read details (#1999) (2488b41)
* **reference:** activate  wave-1 prepared catalog (#2026) (f026751)
* **reference:** add cynomolgus T2T-MFA8 and N. benthamiana KLAB (#2051) (436448c)
* **web:** ship the real hosted DNAForge workspace journey  (#2035) (29a87d4)


### Bug Fixes

* **benchling:** prove manual ZIP transport safety  (#1964) (7636a86)
* **ci:** make native release caches fail closed (#1952) (084b738)
* **ci:** stop stale package inventories blocking releases (#2059) (78a29d8)
* **desktop:** fail closed before Windows updater overwrite (#2052) (a1c2d72)
* **desktop:** prevent Windows updater sidecar race  (#2044) (60d3f6f)
* **desktop:** stop shipping compiler output in packages (#2000) (0095c21)
* **:** make Windows update replacement candidate-owned (#2030) (31ca134)
* **:** prove Windows updates and unblock release caches (#2065) (31296a8)
* **migration:** expose accurate tutorial media state  (#2036) (ea671d6)
* **reference:** align GFF3 circular contig metadata (#1979) (dbaad5b)
* **reference:** align IRGSP circular contig metadata (#1967) (11d81cb)
* **reference:** align tomato chloroplast circular metadata (#1976) (680b20a)
* **release:** consume exact prebuilt macOS sidecars (#1951) (7349a0a)
* **sidecar:** isolate packaged runtime scopes  (#1962) (841a705)


### Performance Improvements

* **migration:** stabilize large append durability (#1972) (d609bb6)

## 0.8.13 (2026-09-16)


### Features

* **agent-tools:** unify renderer tool catalog  (#1306) (7fc794e)
* **compute:** compute endpoints layer, Tamarind first  (#1654) (30ceab9)
* **desktop:** federate hosted compute into Jobs  (#1941) (69df5c6)
* **desktop:** redesign References library intake  (#1917) (b152024)
* **:** manage variant source preparation (#1890) (1a0d6bd)
* make primer library search a durable managed operation (#1930) (7034dec)
* **reference:** complete  hosted rollout foundation (#1931) (da8f39e)


### Bug Fixes

* **analytics:** keep updater origin_index and notebook version  (#1922) (9f6c0a2)
* **ci:** make native desktop release caches durable  (#1926) (86c46c5)
* **desktop:** align tip unit tests with project copy and surfaces (#1943) (9d92c4a)
* **desktop:** exclude reference workspaces from recent edits  (#1911) (d392d02)
* **desktop:** order recent edits after workspace access  (#1916) (755bee3)
* **desktop:** repair current dev suite admission  (#1957) (c4c6f3c)
* **desktop:** repair v0.8.12 migration QA defects (#1959) (215b558)
* **webgl:** keep viewport brackets readable on tiny ranges  (#1909) (92ce885)

## 0.8.12 (2026-09-12)


### Features

* **architecture:** enforce public feature surfaces  (#1765) (ad60d8f)
* **desktop:** open public product docs from Help (#1784) (eccde2d)
* **:** organization sharing surface for desktop (#1772) (93ef031)
* **operations:** manage multiple-sequence alignment  (#1788) (5e55b7f)


### Bug Fixes

* **desktop:** abandon leftover blocked Benchling imports  (#1780) (4e2fa28)
* **desktop:** import Benchling notebooks whose titles contain #  (#1783) (7c6fce9)
* **:** make genome indexing a durable managed operation (#1818) (531d96c)
* **:** make the table selection outline trace the whole cell (#1787) (94309f0)
* **hosted-ai:** recover production Hosted token verify and picker readiness (#1807) (70e3114)
* **release:** backport durable platform replay  (#1816) (9b4b6a3)
* **release:** verify Team ID state across compiled chunks  (#1813) (c193e57)
* **telemetry:** accept the workflows emitters already send  (#1779) (81bfc9e)
* **telemetry:** stamp identity_kind on main-process PostHog events  (#1805) (cfd1944)


### Performance Improvements

* **ci:** warm exact native release caches (#1814) (ec3d0f8)

## 0.8.11 (2026-09-12)


### Features

* **ai:** complete Codex, Claude, and Grok capability parity  (#1703) (c10d5f5)
* **assembly:** add MoClo kit schemas to the assembly drawer (#1440) (a080851)
* compile managed operation kinds into one public system  (#1758) (c108ff2)
* **:** add persistent References and independent saved Track views (#1650) (5667a29)
* **:** shared projects with invitations, permissions, and automatic sync (#1615) (79392f2)
* **:** define desktop/Python service messages once with typed routes (#1618) (676ca34)
* **:** add optional tracked operations and left-sidebar Jobs (#1690) (ef1311b)
* **reference:** make References a full-screen workspace  (#1739) (b5af409)
* **reference:** reconcile hosted caches in background  (#1751) (7e128b5)
* **reference:** save genome views as project files (#1709) (429efef)


### Bug Fixes

* **ai:** render the pause marker after Hosted Stop (#1656) (a913cdd)
* **desktop:** auto-update stale schema without startup lockouts (#1759) (dba61de)
* **desktop:** consolidate notebook creation and isolate checkout validation (70a5b2c)
* **desktop:** harden Windows installer path handling (#1704) (c2f7e5a)
* **desktop:** never relaunch a packaged startup failure into a recovery updater  (#1619) (17a4139)
* **desktop:** repair serial-audit ownership and boundary defects  (#1602) (e5294e6)
* **genome:** restore cached opening and nucleotide visibility  (#1620) (ebe1921)
* **genome:** restore indexed nucleotide and codon visibility  (#1593) (99429e4)
* **import:** make sequence import one native transaction  (#1746) (aedf204)
* **packaging:** verify updater authority across reachable chunks (#1659) (ee6f85b)
* preserve Windows updater signer compatibility (#1728) (2db8e3d)
* **telemetry:** bind stopped journal digest to final answer (#1674) (0c0c50e)
* **telemetry:** classify partial linked-item migration outcomes (4355314)
* **telemetry:** classify rejected migration attempts accurately (4784e39)

## 0.8.10 (2026-09-08)

### Bug Fixes

- **genome:** restore nucleotide letters on both strands in indexed genome views .
- **genome:** preserve nucleotide and codon display after chromosome and same-chromosome revisits .
- **genome:** prevent delayed sequence reads from replacing the region currently on screen .

## 0.8.9 (2026-09-07)

### Bug Fixes

- **desktop:** keep the Windows installer repair active for updates from DNAForge 0.8.3, including replacement and automatic relaunch .
- **release:** test the production installer hook against a real failing predecessor uninstaller before full packaging .

## 0.8.8 (2026-09-06)

### Bug Fixes

- **desktop:** continue automatic updates through the fallback server when Electron reports a refused, reset, closed, or disconnected connection .
- **release:** exercise real network failures and three-platform native replacement before building the full signed application .

## 0.8.7 (2026-09-04)

### Bug Fixes

- **release:** restore bounded updater-mirror publication for the replacement production candidate 

## 0.8.6 (2026-09-03)


### Features

* **telemetry:** implement  trace model (#1396) (b7603d0)


### Bug Fixes

* close tab memory lifecycle owners (#1356) (6ac2a9e)
* **desktop:** bridge broken v0.8.3 updater uninstall (#1434) (1d4e5ab)

## 0.8.5 (2026-09-03)


### Features

* **analytics:** make meaningful WDAU trustworthy  (#1384) (af303c0)
* **reference:** expand hosted genomes with UCSC parity and saved views (#1280) (fb43d32)


### Bug Fixes

* **desktop:** package entities runtime dependency  (#1395) (e527ac7)


### Performance Improvements

* **ci:** plan once and bind exact proof  (#1379) (c6d47fb)

## 0.8.4 (2026-09-02)


### Features

* **benchling:** complete native migration fidelity (#1282) (97b10c5)
* **benchling:** native workspace migration and simplified import flow (#1245) (028c523)
* cut Codex context replay and keep one host-neutral skill catalog (#1355) (e031a15)
* **:** extract domain services and shrink Electron preload (#1299) (eec61fb)
* **reference:** stage hosted source catalog wave 06 (#1248) (fd7b1bd)


### Bug Fixes

* **analytics:** delivery health www URL + founder operator labels (#1297) (7007e2a)
* **ci:** keep Linkedom imports package-compatible (#1321) (929890c)
* **ci:** make the telemetry ingestion canary runnable  (#1330) (74c134e)
* **desktop:** do not prompt Keychain on Sign In (#1311) (0922cbb)
* **desktop:** preserve hosted contribution refusal guidance  (#1234) (4ccf201)
* **desktop:** register startup workspace before publication (#1300) (4a50d73)
* **:** repair qualification prerequisites and deterministic CI (#1281) (95fa085)
* **e2e:** stabilize staging shard 5 interactions  (#1351) (16d61f2)
* preserve hosted sync fidelity and GitNexus availability (#1162) (e0314e2)
* **reference:** preserve exact UCSC annotation coverage (#1244) (9141942)
* register workspace mounts before publication (#1291) (a49f17d)
* **release:** repair staging Electron qualification (#1307) (7e05225)
* **release:** repair staging Electron qualification (#1327) (425b55d)

## 0.8.3 (2026-08-30)


### Features

* add native file associations and read-only Quick Look (#1160) (43903df)
* admit annotated hosted-reference contig authorities (#1209) (44eed1d)
* **hosted-ai:** add production readback and bounded qualification (#1164) (40d7b78)
* **migration:** ship manual Benchling recovery (#1168) (62af92e)
* **reference:** activate hosted catalog wave 04 (#1211) (8da90d3)
* **reference:** activate ten hosted genomes in the picker (#1143) (46d1f8c)
* **reference:** admit UCSC-native hosted sources (#1202) (75900b6)


### Bug Fixes

* **desktop:** make stable sequence identity promotion-safe (#1179) (195acba)
* **desktop:** repair staging qualification matrix (#1183) (e598e9c)
* **desktop:** stabilize staging qualification matrix (#1181) (e2e6a07)
* **desktop:** stabilize staging qualification matrix (#1186) (3deb994)
* make desktop updates redundant and provable (#1214) (4cf6fb4)
* normalize circular hosted-reference GFF3 coordinates (#1185) (4b7e0b3)
* recover v0.8.2 Windows release (#1192) (2c80421)
* **reference:** admit large bounded NCBI sequence reports (#1173) (9816418)
* **reference:** require annotated sources for pending genomes (#1134) (6da325f)
* **release:** reconcile staging repairs before Hosted qualification (#1190) (15d95fc)
* **test:** converge staging approval helper (#1180) (4829abb)

## 0.8.2 (2026-08-26)


### Features

* acquire and admit NCBI packages as review-only catalog candidates (#1056) (e574f5e)
* dual-register add_indexed_bigwig_url for indexed tracks (#1058) (d133c1c)


### Bug Fixes

* keep primer save and MG1655 viewport stable  (#1053) (74da273)
* require external scope for indexed BigWig MCP (#1100) (5b003c2)
* rollback  release regressions  (#1084) (bd4045c)

## 0.8.1 (2026-08-24)


### Features

* add indexed current-view MCP tools (#998) (9ed7bf9)
* add indexed reference interval MCP tool (#1000) (fd59255)
* **benchling:** add destination picker and persistent completion review  (#986) (46a73bf)
* **hosted-ai:** route Codex Responses through gateway  (#982) (3849b4d)


### Bug Fixes

* **benchling:** simplify import review flow (#1002) (c07f274)
* harden cross-platform release package proof (#1015) (b0a44dd)
* **release:** converge v0.8.1 candidate and patch policy (#1016) (ca5a69e)
* **release:** repair proposal state and updater fast loop (#1012) (18657e3)
* repair sequence finalization and harden desktop release proof (#1010) (72e42f1)

## 0.8.0 (2026-08-19)


### Features

* add controlled accepted assembly lifecycle (23b5042)
* add controlled accepted assembly lifecycle (ad96fc9)
* add immutable assembly lineage tools (122ad6d)
* add macOS Team ID cutover hard block  (#771) (bb57825)
* **analytics:** absence monitors + instrument the invisible import funnel (#672) (b897426)
* assembly opens on the plasmid map, and parts can find themselves (#706) (391edfd)
* **benchling:** add local migration adapters (#781) (1992d2e)
* **benchling:** add local migration contracts (#780) (32b68e2)
* **benchling:** run HTML ZIP migrations fully offline (#782) (352003f)
* **benchling:** ship the ZIP-only migration experience (#783) (5f6412f)
* centralize primer lifecycle services for agents (#721) (3d1d6aa)
* **chat:** persist the conversation-sidebar pinned state across launches (f757a22)
* **ci:** enforce single-source toolchain versions (#794) (22c21ab)
* **desktop:** make the Electron main and preload typecheck a required gate  (#737) (b85c49e)
* **:** expose compact interaction authority (6e30927)
* **:** load compact broad interaction in app (f41e7ee)
* **:** transport compact broad interaction (441192a)
* Golden Gate optimizer and accepted plasmid finalize/reopen (#808) (e5e9713)
* **hosted-ai:** run production agent harness  (#772) (62928ea)
* **mcp:** add scoped 2026 discovery (041055a)
* purpose-built Dock tile (ticket + worktree + port) and Cmd-R reload in packaged app  (#814) (aa1cf7b)
* reactivate safe views from chat history (#707) (b4b7117)
* **sequence:** attach clone reads inside the DNA sequence package (#795) (6c7fb23)
* stamp the worktree port onto the Dock icon for local builds  (#803) (93ac48b)


### Bug Fixes

* **agent:** prove first-use MCP tool availability (#715) (babffce)
* **api:** authenticate every sidecar route and drop the wildcard CORS  (#733) (130ed37)
* block packaged apps without BAM runtime (f2117d6)
* **ci:** follow the Package Gate job to the reusable workflow in its guard test  (b3a73cd)
* **ci:** scope Electron sidecar runtime authority (45b97bf)
* decouple annotation detail from search readiness (2b630de)
* default-deny Python sidecar routes  (#747) (40bb447)
* **desktop:** bound annotation cache filenames (2386333)
* **desktop:** declare hosted AI tool-claim bridge methods in preload types  (#801) (21a8c1d)
* **desktop:** dismiss privacy toast from its surface  (#723) (2aab6e3)
* **desktop:** pass absolute paths through the cold-start tab resolver  (56b80e2)
* **desktop:** reach the hosted AI gateway from packaged builds, and label the sign-in button (#704) (9975e4a)
* **dev:** clear assembly tracks in picker preset (17b7ce4)
* **:** decouple scene readiness from worker teardown (75dd7d3)
* **:** expose active reference preparation (454d3c6)
* **:** finalize lane layout before interaction (1cb72f1)
* **:** honor admitted annotation LOD authority (0ee1180)
* **:** present resized annotation canvas atomically (aa2f0aa)
* **:** preserve compact interaction readiness (8e66a43)
* **:** preserve native coverage executable (9adb4d1)
* **:** preserve raster admission across ref commits (fed2ba9)
* **:** prewarm exact annotation views after present (324146c)
* **:** publish annotation count from search readiness (963bb90)
* **:** reject stale coverage helpers at startup (9797ca0)
* **:** repair merge candidate failures (9b0ba3e)
* **:** stabilize cold annotation session authority (27c0fdb)
* **:** stabilize multi-type annotation interactions (2a9be24)
* **:** raise the staging burst cap to 20/min and make throttling legible (#713) (02158af)
* fail closed when BAM runtime is unavailable (f6381ee)
* harden indexed genome loading and rendering (4735ab5)
* harden indexed genome loading and rendering (fb63eef)
* harden provable database recovery (#754) (fdceea3)
* **hosted-ai:** harden manual tool turns  (#786) (0dcd0a2)
* **hosted-ai:** reconcile Hosted AI staging behavior onto dev  (#800) (3dde991)
* keep genome layout stable during preparation (f7a4175)
* keep terminal genome sessions immutable (977e6e5)
* make annotation corridor authority theme-safe (9f72505)
* make annotation theme a runtime projection (e483e89)
* make indexed annotation authority monotonic (367a4a0)
* make indexed annotation ownership path-independent (66ebca4)
* make indexed annotation theme handoff atomic (00f74e4)
* **ops:** reconcile recovery authority drift  (#813) (8ace161)
* preserve annotation authority across local reseals (a46861a)
* preserve assembly lifecycle compatibility (e772339)
* publish and prove Windows auto-update feed (#727) (b87539e)
* remove test fixture from desktop build authority (cfe89e1)
* remove theme from annotation readiness authority (42957cc)
* replay admitted annotation detail on reopen (959ed52)
* restore annotation successor continuity barrier (bbf6059)
* retain annotation reads through publication gaps (b44a4d6)
* separate annotation presentation from runway readiness (97e63cc)
* **structure:** start Mol* when no GPU is available  (#716) (2a0e27f)
* **test:** stop DevPanel retries after teardown (#816) (91b0821)
* **test:** the mock database silently dropped WHERE clauses  (#818) (c55aed4)
* v0.7.11 make architecture guards executable (#745) (cc5bbf4)


### Performance Improvements

* admit compact annotation authority immediately (fe15396)
* admit published reference generations directly (c6285d7)
* bind portable annotation interactions across themes (23596aa)
* cancel stale annotation detail on zoom reversal (8b83d7a)
* cancel stale annotation runway work (c27cf1d)
* **ci:** cut ~$437/mo of GitHub Actions burn  (ba5e303)
* deduplicate tier ancestry admission (9a9d8c0)
* **:** bound annotation work during gestures (b6d0b99)
* **:** gate annotation loading at 120hz (9ba47ad)
* **:** move prepared admission off Electron main (aedf891)
* **:** overlap broad annotation authority loading (a743825)
* **:** project broad interaction in worker (4d1f2ee)
* **:** remove annotation authority scans from gestures (db911a3)
* **:** retain exact scene admissions (3126ccd)
* **:** revoke inactive coverage tile work (223e268)
* **:** stabilize indexed annotations during interaction (9a881d1)
* **:** trust worker-validated compact interaction (51bd49a)
* **:** unblock hosted reference acceptance (1baca20)
* index exact annotation scene partitions (1cf00be)
* keep active annotation runway ahead of gestures (47ac6a1)
* keep annotation detail admission within frame budget (6ca9f4a)
* keep annotation inventory admission stable (34bd49b)
* keep codon carrier residency camera independent (b5730a6)
* make annotation successor handoffs path-independent (cce6928)
* make indexed annotation motion path-independent (a09e7fa)
* parallelize authenticated annotation detail reads (fb892dc)
* persist compact annotation interaction authority (88381fc)
* prioritize live annotation runway before controls (5ed217b)
* publish annotation detail before search (cf619e5)
* remove duplicate pileup depth sorting (16eaa82)
* retain a gesture-safe annotation detail window (70eb720)
* retain genome data preparation across motion (352d70a)
* retire exact pileup work outside detail LOD (fd8e8c1)
* schedule annotation raster work from the live camera (f013828)
* seal path-independent indexed genome rendering (ba09723)
* seal prepared reference readiness tiers (ac9957e)
* stream atomic annotation viewport detail (0eac743)
* stream exact annotation viewport detail (90e0aa4)
* use display pixels for pileup detail authority (de30b35)
* wait for compiled raster GPU completion (75f48ed)

## 0.7.15 (2026-08-14)

### Features

* apps/desktop/package.json change (commit-time CD gate)


## 0.7.14 (2026-08-12)

### Features

* apps/desktop/package.json change (commit-time CD gate)


## 0.7.13 (2026-08-11)

### Features

* apps/desktop/package.json change (commit-time CD gate)


## 0.7.12 (2026-08-11)

### Features

* apps/desktop/package.json change (commit-time CD gate)


## 0.7.11 (2026-08-11)

### Features

* apps/desktop/package.json change


## 0.7.10 (2026-08-04)

### Highlights

* Restore bounded, consent-based product analytics so release, navigation,
  workspace, file, and scientific-tool activity reaches the correct PostHog
  environment without collecting customer content
* Keep desktop and web telemetry joined to one pseudonymous installation while
  preserving immediate opt-out and opt-out silence after restart

### Privacy and Reliability

* Disable session replay and raw interaction firehoses, reject snapshot payloads,
  and reduce updater and diagnostic failures to approved categories
* Verify the real Electron click, form, wheel, rate-limit recovery, and
  revocation paths against a protocol-aware local collector
* Add a reviewer-gated canary that verifies a signed, notarized desktop artifact
  against its exact build tag before reading its synthetic session back from the
  matching staging or production PostHog project
* Exclude synthetic canary traffic from product dashboards and isolate privileged
  read-back credentials from the downloaded application

## 0.7.9 (2026-07-30)

### Highlights

* Download prepared assets for a hosted human reference and open it with
  visible annotations in the packaged desktop app
* Keep indexed genome annotations visible while moving between broad assembly
  views and detailed zoom levels
* Add a public UCSC quantitative track in one click and render its real signal
  as a histogram in the packaged desktop app

### Bug Fixes

* Keep an already-visible reference coordinate view ready while its remaining
  source, annotation, and search data finish loading
* Preserve the selected reference and its prepared annotation products across
  cache publication and reopening

### Under the Hood

* Exercise the packaged acceptance path from an empty reference cache and
  require visible GRCh38 annotations plus non-empty UCSC histogram pixels
* Remove a circular dependency in the pileup renderer without changing its zoom
  thresholds or drawing behavior

## 0.7.8 (2026-07-29)

### Features

- Restore the packaged minimatch dependency required by the release safety baseline.

## 0.7.7 (2026-07-28)

### Highlights

* Open complete hosted reference genomes from the reference library and reopen
  them quickly from a verified local cache
* Import a custom reference from a folder, FASTA file, or NCBI Datasets
  package; DNAForge discovers and indexes included GFF3 annotations
* Add BAM alignments and inspect read-level mismatches, insertions, deletions,
  and skipped bases; DNAForge prepares missing indexes and coverage caches
  automatically
* Browse mutations genome-wide from indexed VCF files and jump to their gene,
  transcript, exon, CDS, and coding-consequence context
* Add public UCSC BigWig signal tracks in one click and keep them available
  across whole-genome views, detailed views, and reopening

### Bug Fixes

* Resolve hidden reverse-strand Find results to the exact rendered annotation
* Complete the local reference capability handoff after the import dialog closes

### Under the Hood

* Publish prepared reference generations atomically and bind cache reuse to the
  exact source content
* Bundle and verify the native genome-indexing and coverage helpers required by
  the desktop app
* Decode BigWig data in a worker through authenticated loopback range requests
* Reuse the shared track lifecycle, bounded tile cache, and retained
  quantitative renderer

## 0.7.6 (2026-07-27)

### Highlights

* Search complete reference genomes for DNA sequences, annotations, and amino-acid matches, then open results directly.
* Load and compare multiple local BAM alignment files on the same reference. DNAForge prepares missing indexes automatically and keeps tracks synchronized while you pan and zoom.
* AI replies now render headings, lists, links, code blocks, and contained tables. Attached references remain visible while resolving and clearly report unavailable results.
* Import primers, strains, DNA sequences, and protein sequences through guided workflows, including protein alignment and back-translation with built-in organism codon tables.
* The workspace file tree remains available across views and restores expanded folders and sidebar layout after relaunch.
* Finalized assemblies and imported plasmids now become self-contained plasmid packages that keep their GenBank product, build history, and generated primers together as one workspace item.

### Bug Fixes

* Closing complex design or genome tabs is now consistently fast and no longer briefly blanks or rebuilds neighboring canvases.
* Older DNAForge versions now recognize a database written by a newer release and ask you to update instead of incorrectly treating it as corrupted.
* Development builds use isolated database profiles and cannot silently migrate the database used by an installed release.
* Genome annotations and read-alignment tracks remain stable across search navigation, theme changes, panning, zooming, and hidden-track reveals.

### Under the Hood

* Historical desktop migrations are now exercised against captured real databases, including upgrades, recovery, and repeated-start safety.
* Hosted reference assets are prepared, pinned, and verified before publication.
* Improved diagnostics and reliability checks across AI chat and desktop workflows.

## 0.7.5 (2026-07-27)

### Features

* Keep local and development builds on isolated database profiles whenever the installed database needs a schema upgrade 
* Show a persistent Development profile marker in every non-release desktop window 

### Bug Fixes

* Stop older builds from treating a healthy newer database as broken or suggesting that users move it aside 
* Preserve the live newer database before a user restores a compatible, dated backup 

### Under the Hood

* Gate shared-profile schema migrations on an exact release-workflow stamp compiled into the Electron main bundle
* Keep the oldest schema recovery point alongside the newest backup, and record the last writer's version, release identity, source fingerprint, and time

## 0.7.4 (2026-07-27)

### Features

* Guided import for primers, strains, and sequences, including paste, drag-and-drop, spreadsheet mapping, and workspace-aware destinations
* First-class amino-acid registry entries with structure viewing, multiple-sequence alignment, and back-translation using built-in organism codon-usage tables
* Local BAM alignment files in indexed genome views, including automatic index preparation and multiple tracks on one reference
* A Home tab with Ask AI, recently edited work, and open tabs in one screen
* A persistent workspace file tree that remains available across views and restores expanded folders and sidebar state after relaunch

### Bug Fixes

* Keep registry links intact when files are moved or renamed inside DNAForge or by external tools
* Keep the WebGL map thumbnail synchronized with the sequence view during fast scrolling
* Stop file-tree reveal and focus actions from scrolling the entire application
* Clear stale nucleotide-range highlights when Find jumps to an annotation
* Make reference-assembly actions independent of the currently active workspace

### Under the Hood

* Improved diagnostics for AI chat quality and reliability.

## 0.7.3 (2026-07-25)

### Maintenance

* Reliability improvements across the desktop app

## 0.7.2 (2026-07-24)

### Features

* A new Home tab with Ask AI, Recently Edited, and open tabs in one screen 
* Keep the WebGL map thumbnail synchronized with the sequence view during fast scrolling

### Under the Hood

* Bundled the Home wordmark font under a private family name so it cannot collide with sequence-viewer fonts


## 0.7.1 (2026-07-22)

### Features

* Load local BAM files into indexed genome views, including multiple alignment tracks and automatic index preparation
* Control annotation density with an exact lane-count field and keep add-track controls accessible at the bottom of the track stack

### Bug Fixes

* Keep every annotation isoform visible across overview and detail zoom levels, including CDS chevrons and amino-acid labels
* Keep coverage histograms and exact reads stable while panning, zooming, and crossing tile or level-of-detail boundaries
* Keep track gutters synchronized with vertical scrolling while the cytoband remains fixed

### Under the Hood

* Add target-scoped presented-frame, framebuffer, ownership, and full-assembly regression gates for genome-viewer rendering


## 0.7.0 (2026-07-22)


### Features

* 3D structure viewer opens .pdb, .cif, .mmcif, and .bcif coordinate files from the workspace, including multi-chain structures 
* Right-click residues in the 3D viewer to ask the AI about them; it answers and highlights those exact residues back in the structure 
* Structure sequence track marks residues absent from the coordinate model, surfacing unmodeled gaps 
* Select multiple disjoint residue ranges in the 3D viewer, with shift-click to extend a range 
* Save residue selections as durable objects usable as chat reference chips across the viewer and the AI agent 
* Rebuilt primer creation form: choose Tm model (SantaLucia, +Owczarzy salt, or NEB Q5), set 3' binding length, and preview live over real dsDNA 
* Created primers are saved as files in the workspace via a built-in folder picker and registered in the primer library 
* Finalizing an assembly records its designed primers as oligos in the primer library and 'Find primers', tagged with their assembly origin 
* New sample content: the Universal Loop (uLoop) Golden Gate assembly kit with 24 public-domain receiver vectors 
* Ready-made CIDAR MoClo Golden Gate notebook demonstrating every embed: live 3D structure, mix-calculator tables, expected-gel image, and clickable part links 
* Example workspace bundles 400+ redistributable MoClo/Golden Gate kit parts (YTK, CIDAR, EcoFlex, Plant, Open Yeast, Open Plasmids) plus curated NCBI plasmids 
* @-mention a sequence, design, or page in a notebook — mentions are now live, clickable links that jump to the target 
* App opens with a pre-loaded Samples workspace: MoClo Golden Gate kits, AAV vectors, yeast & B. subtilis genomes, cloning notebook + alignment demo 
* Notebook table editor gains spreadsheet basics: row-number-gutter selection, drag-to-resize rows, and double-click-to-auto-fit column width
* Connect AI provider (Claude/ChatGPT subscription or API key) directly from the Ask-AI chat panel; keys validated before saving, no Settings detour 
* When an org member is demoted, removed, or leaves, any pending invitations they held are automatically revoked 
* Workspace file tree hides file extensions by default (Finder-style), with the full name shown on hover and when renaming

### Bug Fixes

* Right-button drag to rotate or pan the 3D camera is no longer interrupted by residue selection handling 
* A structure that fails to load can be retried in place instead of leaving a dead viewer pane 
* Clearer error when a saved primer can't be rebuilt into the library: names the exact file to fix, with likely cause and recovery 
* Find-in-sequence now appears in every viewer layout, including map-only view where it used to vanish; arrow keys browse matches and a click jumps to a hit 
* Creating a new file or folder scrolls it into view instead of landing off-screen in a long file tree 
* Ask AI about a selection now opens its inline chat docked beside the source pane instead of detaching from the source view
* Notification toasts capture the click and dismiss, instead of letting the click fall through to hidden buttons underneath 
* Entity-named tabs (e.g. 'E. coli MG1655', 'Construct v2.1') now show their full name instead of being cut off at a dot 
* Desktop sign-in error toast now shows a clear, neutral 'temporarily unavailable' message instead of leaking internal configuration details 
* Windows: signing in to and running the Claude or Codex CLI in Ask-AI now works reliably regardless of installer (npm, pnpm, yarn), and the in-app assistant's Sign-in button no longer errors , , 
* The 3D structure drawer gets its own toolbar icon and joins per-tab drawer exclusivity, so opening another drawer cleanly swaps to it instead of the structure view staying on top and hiding it 

### Under the Hood

* 3D viewer reuses a single Mol* renderer per pane, cutting memory use and avoiding duplicate GPU contexts on tab switch 
* Structure views hand off safely across coordinate revisions and gate interaction until the renderer is ready, preventing stale or blank panes 
* Notebooks with 3D-structure and table embeds scroll smoothly with no cold-open lag or trackpad judder; table column/row sizes persist across reopen 
* Same notebook opened in two workspaces no longer collapses into one shared record — per-workspace copies, DB-level duplicate-corruption prevention, and re-keying of existing notebooks on upgrade , 
* Notebooks are now portable files as the source of truth: drop a notebook folder into a workspace to register it; edits write to disk first (crash-safe) 
* Local AI agents (Claude/Codex) can read and set the app-wide primer Tm model, matching the in-app assistant 
* Saved residue selections and structure coordinates created via the AI assistant persist reliably with crash-safe writes
* Bioinformatics engine refuses to start with a clear error when its bundled binary doesn't match the machine's chip, instead of failing silently
* Hardened the enterprise SSO (WorkOS) sign-in pilot: stricter callback validation, fail-closed config handling, and reliable webhook processing 


## 0.6.3 (2026-07-16)

### Bug Fixes

* **ai:** restore Codex CLI execution for ChatGPT-authenticated sessions and ignore unsupported saved model overrides


### Under the Hood

* **ai:** select the newest runnable Codex binary across PATH, known install locations, and the ChatGPT desktop app bundle


## 0.6.2 (2026-07-14)


### Bug Fixes

* **update:** the "update ready — restart to apply" notification no longer repeats/stacks while the app is left open 


## 0.6.1 (2026-07-14)


### Features

* **windows:** Windows installer is now Authenticode-signed (Azure Trusted Signing), clearing the SmartScreen/Dell warning path 
* **annotations:** faster, more complete annotation engine on large sequences 


### Bug Fixes

* **onboarding:** clearer Golden Gate polarity message when a fragment is on the wrong strand 


### Under the Hood

* **ci:** release pipeline builds macOS + Windows in a native parallel job DAG (no cross-workflow poll gate) 


## 0.6.0 (2026-07-14)


### Features

* **sync:** cloud backup + share snapshot + light cross-device sync for managed desktop projects 
* **auth:** WorkOS SSO overlay for institutional sign-in pilots 
* **agent:** in-app agent permission model + guardrail; workspace mount/empty handling , 
* **ai:** closed-loop Ask-Agent — right-click / slash to ask, agent highlights the answer back 
* **reliability:** automatic crash + error reporting with privacy scrubbing 


### Bug Fixes

* **structure:** never hard-error on large multi-chain structure loads; pane-drag stretch , 
* **packaging:** symlink-dedup dugite git-core to roughly halve the macOS download 
* **update:** clearer post-update toast states (position, styling, installing feedback)


## 0.5.0 (2026-07-08)


### Features

* add annotation color viewing modes (fbaa91a)
* add large-file tabular viewer (#306) (e4e41c1)
* **analytics:** generate closed-beta allowlists from the registry  (9ce7ef3)
* **analytics:** generated analytics event registry  (fce78eb)
* **ci:**  atomic desktop release — dispatch Windows publish after approval (c1a99c7)
* **ci:**  symmetric Windows desktop release on v* tags (62d5dbf)
* extend canvas annotation polish (e49abb7)
* **sequence:** add SnapGene decoder and sequence document model (bf95e9e)
* **sequence:** add SnapGene dna decoder (e919a9d)
* **sequence:** annotation drawer UX overhaul, viewport-stable add, scroll-sync off by default (41f0428)
* **sequence:**  annotation-drawer UX overhaul + viewport-stable add (a167105)
* **sequence:**  single enzyme-color authority for 2D + WebGL (d19f81f)
* **sequence:**  single enzyme-color authority for 2D + WebGL (5f8426f)
* **sequence:** draft highlighted annotations live (4db4a1e)
* **sequence:** polish sequence viewer onboarding (2f7b824)
* **sequence:** six-frame Copy Translation modal + copy-menu UX (b9490ff)


### Bug Fixes

* **auth:**  decouple desktop sign-in visibility from PostHog init (997cf10)
* **chrome:** restore tab surface after rebase (bf19964)
* **ci:** clear dirty $LASTEXITCODE so non-blocking GATE E doesn't fail the step (daf0761)
* **ci:** retry NSIS silent install past Defender 0xC0000005 race (adcc74c)
* **ci:** unblock calendar blog promotion checks (ae898d2)
* **desktop:**  hide Source Control (git) icon from production left nav (46b8075)
* **desktop:**  Windows workspace-relative file paths (b66546b)
* **desktop:** keep toast dismiss hint hit-test passive (13145e3)
* **desktop:** keep toasts from blocking e2e surfaces (084ed2e)
* **desktop:** make toast surfaces pass through clicks (d81a1ab)
* **desktop:** preserve explicit list_files folder prefix (0797cd4)
* discard ephemeral annotation drafts (401d333)
* polish sequence viewer onboarding (be0ec75)
* preserve SnapGene LIMS provenance (caa14d3)
* **release-notes:** drop unshipped NCBI import claim from 0.4.0 notes (fae9d1e)
* render CDS annotation drafts through CDS lanes (b758f62)
* **security:** harden promotion scan findings (9a1c598)
* **sequence:** address adversarial /review findings on the annotation-drawer batch (6fd3074)
* **sequence:** align annotation drafts (6f3cfa8)
* **sequence:** align mutating context menu actions (b29e086)
* **sequence:** close tier-one onboarding bugs (26072bc)
* **sequence:** close tier-one onboarding gaps (f7c61ba)
* **sequence:** keep WebGL auto full fidelity (6c17223)
* **sequence:** use safeFocus for the annotation-list keyboard-nav focus (c965dbe)
* tighten annotation draft and WebGL cleanup (473c614)
* unify draft annotation styling (9cfa769)
* **windows:**  annotation toolbox +  paths + cross-OS bundle resolver (551771d)
* **windows:** /1200 post-#330 hardening — GATE E blocking + drive-root paths (1236d65)


### Performance Improvements

* **release:**  thin universal BLAST/bio-tools to build arch (#320) (e2f1352)

## 0.4.0 (2026-06-27)


### Features

* add closed-beta PostHog allowlist (ed2ea7c)
* add ledger parity harness (2450d72)
* add LIMS slice one core (52103b0)
* add searchable direct api secret registry (87e9645)
* add shadow conversation ledger (9e2f5aa)
* **assembly:** Golden Gate auto-optimize fix (never errors, ~60× faster) + internal cut-site audit  (#242) (32f401e)
* **chat:** AI chat works without a mounted workspace + diagnosable CLI failures ,  (63f0020)
* **chat:** AI chat works without a workspace + visible send errors + diagnosable CLI failures /513/514) (92fcab7)
* **ci:** Nx Atomizer for Electron e2e per-file tasks  (#295) (cfb2b62)
* complete ledger parity coverage (ce1634d)
* **desktop:** add data-store source-of-truth guard (cff0bf1)
* **dev:** toggle to unmount/remount pinned dev fixtures (simulate fresh machine) (d1eea5e)
* **files:** file-type icons, sandboxed HTML viewer, image-load fix ,  (#275) (8c12374)
* harden assistant host auth readiness (f626949)
* **import:** NCBI sequence import via sidecar + service.py decomposition  (#287) (cbd1eff)
* instrument tool usage telemetry (111a39d)
* introduce assistant host descriptors (0515afd)
* **lims:** Demo LIMS Phase B + managed git-workspace foundation (#252) (8ef27e6)
* persist chat turns for assistant routing (1cabf26)
* **primers:** right-click Attach Primers → region-scoped Find drawer  (#238) (43d69fe)
* project shadow ledger transcripts (d407803)
* record provider ledger terminal events (809b8be)
* replay last dev scenario (46660f0)
* **sequence:** one typed per-file view-state model + persisted WebGL renderer shape  (#220) (eeb526b)
* **sequence:** snap to saved viewport on tab restore (scrollAnimate prop) (18efa36)
* stitch beta install attribution into telemetry (a6e71ca)
* **tabs:** /871/872 Cmd-W close tab + Cmd-Shift-T reopen + unsaved-dot restyle (#279) (1920d47)
* **updater:** packaged fast-loop — package:local + packaged auto-update L3  (#294) (c11cdd1)
* **workspace:**  crossover-edit gate + file-tree move/rename improvements (#277) (89aedac)
* **workspace:** single-file import + folder-import progress + Trash /865) (#272) (a471d1d)


### Bug Fixes

* add assistant settings candidate surface (fd7178b)
* add cli model picker catalog (f7e52e1)
* add desktop release notes for 0.2.18 (331d1ad)
* add direct api configure action to picker (990e54a)
* address sidecar review findings (d34456e)
* **agent-sdk:** scrub ambient OpenAI/Codex env from Codex detection ,  (#201) (4f3274d)
* **agent:** keep background outputs non-interruptive (e4b062f)
* **ai:** close_tab finds the agent's content tab across panels  follow-up) (2c27d8e)
* align process trace bullets (ca8af26)
* align settings dividers and release notes (a144498)
* align sidecar status with health contract (ed9c2e3)
* allow Windows sample workspace reads (18c5d58)
* apply assistant route switches immediately (9fc2166)
* **assembly:** /870/869 correctness + cut-site label canvas↔WebGL parity (#276) (4e08223)
* **assembly:** polish accepted assembly outputs (1136867)
* avoid dev marker in release notes bundle (00ba594)
* avoid duplicate sidecar restart spawn (2f827ab)
* avoid phantom chat messages on turn insert failure (d879cf3)
* centralize cli host capabilities (5a572d7)
* **chat:** address /review findings (CLI checking lock, trace over-capture, tool gaps, log perms) (4d479fa)
* **chat:** surface first-message send failures instead of failing silently (9fa2649)
* **ci:** unblock staging gate — pin dugite arch for x64 + suppress Semgrep FP  (4975d76)
* clarify assistant route and model pickers (dec451b)
* clarify chat setup actions (6a77781)
* clarify external tool access settings (1480bee)
* collapse completed chat activity traces (b5c2dcc)
* collapse completed chat process by turn (c8a8cd3)
* consolidate assistant host settings (c1c2ba2)
* default assistants to local cli tools (aa3160b)
* **desktop:** better-sqlite3 ABI mismatch launch failure + harmful DB dialogs  (#267) (f32d25a)
* **desktop:**  keychain — defer first-run prompt + DNAForge rename + packaged userData migration (#268) (0183763)
* **desktop:** keep filesystem watcher cleanup wired (2a934bf)
* **desktop:** remove retired features from test schema (e3dc1ce)
* **desktop:** restore native Windows window chrome (0540970)
* **desktop:** show packaged e2e startup window (f4d0625)
* **desktop:** stop renderer-bundle guard false-positive on release-note prose (ccea057)
* **desktop:** use platform-aware shortcuts and modifiers (7b3cc87)
* **desktop:** validate git shell cwd boundaries (17dd7f2)
* **:** require release-please token (#301) (d6c5e49)
* **/875:** packaged-app CLI detection (stripped PATH) + install UX + bundled git (#270) (48320c7)
* drive direct api credentials from provider descriptors (f1fb2aa)
* fail closed on uninitialized sidecar URL (0eb4f6b)
* flatten assistant settings hierarchy (c316296)
* gate sentry by deployment environment (b0b05c1)
* gate sentry by deployment environment (d1beacf)
* harden agent grants and chat turn persistence (a9eb580)
* harden electron e2e runtime profile (afdead1)
* harden LIMS query ordering (139acbc)
* harden molstar context fallback (7ec1f43)
* harden molstar live render reconciliation (41f7e29)
* harden shadow ledger flushing (e4d7023)
* harden sidecar supervision (20f35a2)
* honor CI sidecar health timeout (b8816b2)
* keep chat history open on selection (fa762b1)
* keep chat usable when direct api needs a key (72eba06)
* keep permission mode out of host picker (1fe7cf6)
* let reset forget blocked dev replay (16ba4f1)
* **lims:** dev-seed prompt no longer occludes chat composer in E2E (Demo Phase B regression) (7efd1e5)
* **lims:** directional chevrons for registry expand/collapse + database sidebar icon (#278) (ba14465)
* **lims:** mute green 'registered' badge so it reads as a label, not a mystery dot  (dcf868d)
* make chat history surface float in place (c42a286)
* migrate legacy userdata past stub target (f3a6ef4)
* move appbar ai entrypoint right (3b191e0)
* move assistant model controls to chat (ee88cdc)
* pass desktop env into electron dev process (fe721e4)
* polish chat composer and history rail (56b6f9e)
* polish chat history panel rows (c6ce2ee)
* polish settings copy and host selection (9788bda)
* preserve molstar spin after async reconcile (52cc2aa)
* preserve molstar spin after async reconcile (4992cc7)
* prevent cli custom model picker wrapping (80ccc76)
* redesign settings surface (db5b53b)
* refresh toolbox sidecar status after startup (7e5d3ef)
* **release:** desktop package.json is the BASE version (0.3.0); tag carries -beta.1 (b158f11)
* rename cli auth cta (9ab65ad)
* reorder chat history panel actions (504d4ae)
* replace chat history rail with sidebar flyout (d61cb7e)
* restore desktop release-note and settings test gates (88d052d)
* retire stale google api models (1d39566)
* **sequence:** add adaptive WebGL stability mode (887b633)
* **sequence:** batch base edits until explicit Save — stop mid-edit auto-commit  (#280) (bdd06b3)
* **sequence:** center programmatic annotation navigation (5949bb9)
* **sequence:** deterministic auto-commit-on-save + git index-lock retry  follow-up) (#274) (220e3e6)
* **sequence:** move WebGL performance override to settings (03b53de)
* **sequence:** persist pLannotate Apply to disk + clear review state  (#247) (48c2f60)
* **sequence:** use exact 2d navigation for WebGL feature jumps (6313cfd)
* show effective assistant model in picker (308fb0c)
* simplify AI assistant settings hierarchy (cc9614d)
* simplify assistant settings dividers (92decf2)
* soften chat activity surfaces (1391a1e)
* start cli auth from chat (9db9d25)
* **structure:** clarify drawer action labels (edbf037)
* sync chat sidebar conversation selection (adb30c5)
* sync direct api readiness (e8e6f5e)
* sync settings nav with scroll position (2d93424)
* tint chat activity text green (3e51ae5)
* unify assistant responder picker (2c14530)
* unify chat composer picker styling (d3cdff0)
* unify chat composer picker styling (e1feba1)
* **updater:**  auto-update via public R2 generic feed (ship 0.3.2) (70d23db)
* **updater:**  repoint auto-update to public R2 generic feed (b05caf7)
* use gemini 3.5 flash by default (e0a162d)
* use IPv4 loopback for sidecar API URL (f509166)
* **workspace:** make archive/restore work + discoverable, no silent destroy  (9c8a218)
