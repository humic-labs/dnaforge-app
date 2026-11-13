if [ -z "${NO_COLOR:-}" ] && [ "${DNAFORGE_TERMINAL_COLORS:-1}" != 0 ] && [ "${CLICOLOR:-1}" != 0 ] &&
   ! alias ls >/dev/null 2>&1 && ! typeset -f ls >/dev/null 2>&1; then
  if command -v eza >/dev/null 2>&1; then
    alias ls='eza --color=auto --group-directories-first'
  elif command -v gls >/dev/null 2>&1; then
    alias ls='gls --color=auto --group-directories-first'
  elif [ "${OSTYPE#darwin}" != "$OSTYPE" ]; then
    alias ls='ls -G'
  else
    alias ls='ls --color=auto'
  fi
fi
