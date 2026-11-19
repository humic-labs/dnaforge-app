# Upstream shell integration

Scripts from Microsoft VS Code, revision
`9ed1adf18f4e746adad3e6ed3264cca607e1bbb8`,
`src/vs/workbench/contrib/terminal/common/scripts/`. MIT license retained in
LICENSE.txt.

Source:
https://github.com/microsoft/vscode/tree/9ed1adf18f4e746adad3e6ed3264cca607e1bbb8/src/vs/workbench/contrib/terminal/common/scripts

DNAForge uses the existing OSC 633 shell-integration protocol. No user shell
startup files are modified. Zsh injection uses a private per-session directory;
bash, fish and PowerShell receive explicit startup arguments.

Local patch: zsh command/property escaping uses `builtin printf -v` to assign
byte values and escaped tokens without creating a subshell for every character.
The OSC 633 wire format and user startup hooks are preserved. This removes
per-character process creation from the path between Enter and command
execution.

Local patch: Bash normalizes its byte values to unsigned eight-bit integers
before escaping control characters. macOS Bash 3.2 otherwise sign-extends UTF-8
bytes and corrupts Unicode command/property markers. Printable UTF-8 bytes
remain unchanged on the OSC 633 wire.

DNAForge starts each subsequent Bash prompt at the left edge of its terminal. This keeps Readline’s cursor position correct when the preceding command prints a partial line and the next command wraps.
