# VS Code terminal adapters

The pinned xterm 6.0.0 and WebGL addon 0.19.0 dependencies carry the accepted
xterm resize redraw fix from
[xterm.js #5529](https://github.com/xtermjs/xterm.js/pull/5529) (merge
`c975956`). The two version-bound pnpm patches preserve the upstream synchronous
redraw request after either canvas resize path and its propagation through the
render service. Published CommonJS/ES module bundles and source maps are patched
alongside TypeScript sources. Remove both patches together when upgrading to
released versions containing that fix; the shipped-bundle regression in
`scripts/xterm-resize-rendering.test.mjs` must continue passing.

Source revision: `9ed1adf18f4e746adad3e6ed3264cca607e1bbb8`,
`src/vs/workbench/contrib/terminalContrib/links`. The MIT license is preserved
in LICENSE.txt.

Parser changes: replace the two framework imports with local lazy-value and
operating-system adapters. Test changes: use Vitest suite/test names, replace
the platform import, and omit the framework disposable tracker (this parser
creates no disposables). One upstream collection-time assertion block is wrapped
as a test rather than an empty suite for Vitest compatibility. The parser
algorithm and upstream assertions are preserved. The wrapped-range conversion
helper is extracted unchanged with a local structural range type.

Source:
https://github.com/microsoft/vscode/tree/9ed1adf18f4e746adad3e6ed3264cca607e1bbb8/src/vs/workbench/contrib/terminalContrib/links

Regex escapes flagged as unnecessary by the repository linter are normalized
without changing the patterns. All upstream assertions remain the compatibility
oracle.

`terminal-geometry.ts` adapts `getLongestViewportWrappedLineLength` and
`_getWrappedLineCount` from
`src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts` at that same
revision. It keeps the upstream cell/wrapped-line algorithm while accepting the
public xterm buffer and column count instead of a workbench instance.

`terminal-web-links.ts` preserves `isUrl`, `LinkComputer` and the default strict
HTTP URL expression from installed `@xterm/addon-web-links` 0.12.0
(`src/WebLinkProvider.ts` and `src/WebLinksAddon.ts`). The only host adaptation
narrows its terminal parameter to the public buffer interface and exports the
URL expression. This reuses its wrapped-line/wide-cell mapping without importing
a private dependency source path. Its separate MIT license is preserved in
LICENSE-xterm.txt.

The URL expression's unnecessary caret/open-bracket escapes are removed to
satisfy the repository linter; their character-class meaning is unchanged.

`../terminal-command-decorations.ts` adapts the marker/decoration lifecycle,
running/success/error states, gutter visibility and left/right overview-ruler
placement from `terminal/browser/xterm/decorationAddon.ts` and
`decorationStyles.ts` at the same revision. Workbench configuration, context
menus and capabilities are replaced by typed native command snapshots, local
preferences and the application's accessible command-action dialog. Public xterm
markers retain position through scrollback trim and reflow.

`terminal-sticky-scroll.ts` extracts the row-count cap and command-end clipping
from `terminalContrib/stickyScroll/browser/terminalStickyScrollOverlay.ts`.
`../terminal-sticky-scroll.ts` adapts its styled serialization/read-only xterm
overlay, normal-buffer/pager guards, ignored commands, wheel forwarding and
click-to-reveal. The workbench event/theme/configuration services are replaced
by local terminal events and preferences. Defaults match
`terminalStickyScrollConfiguration.ts` at the same revision.

`terminal-link-path.ts` adapts the home-before-cwd path selection from
`terminalContrib/links/browser/terminalLinkResolver.ts::_preprocessPath`. The
native session supplies its host user-home path, as the local process manager
does upstream. File URL decoding, native filesystem admission and the existing
document-opening route remain the host adapters.

The terminal appearance uses the Catppuccin palette at
`07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd`:
https://github.com/catppuccin/palette/tree/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd
The palette's MIT notice is preserved in `CATPPUCCIN-LICENSE`.
`terminal-theme.css` maps the published Mocha/Latte colors to ANSI and chrome
roles. `dnaforge-defaults.sh` is DNAForge code, kept separately from the
vendored Microsoft shell integration; no upstream startup script or user dotfile
is edited.

`terminal-word-links.ts` adapts `TerminalWordLinkDetector._parseWords` and its
2,000-character line / 100-character link limits from
`terminalContrib/links/browser/terminalWordLinkDetector.ts`. It preserves custom
word separators, Powerline separators, source positions and trailing-colon
trimming. The existing terminal preference supplies the selection/link word
boundaries. `terminalLinkOpeners.ts::TerminalSearchLinkOpener` supplies the
unique-versus-ambiguous match behavior; the native adapter uses the existing
`glob` dependency against mounted project roots and the regular document opener.

`terminal-git-quick-fixes.ts` adapts `GitSimilarOutputRegex`, `gitSimilar`,
`GitTwoDashesRegex` and `gitTwoDashes` from
`terminalContrib/quickFix/browser/terminalQuickFixBuiltinActions.ts` at the same
revision. It preserves the bottom-ten/two-line match windows and original
arguments. The host omits compound commands and accepts only subcommand/flag
tokens from output. The existing native command-output range replaces workbench
match services; the command-action dialog requires an explicit choice before the
existing terminal execute queue runs a correction. Additional adaptations use
the same revision's fast-forward pull (hosted as `git pull --ff-only`), upstream
push, GitHub PR link, free-port and PowerShell feedback matchers. Output remains
bounded and can supply only validated literal arguments or an HTTPS GitHub URL.
`shared/terminal-quick-fix.ts` shares the occupied-port matcher with its native
owner. Port release uses owned native process inspection and confirmation,
followed by an owned PTY interrupt; it does not execute a command from output.
