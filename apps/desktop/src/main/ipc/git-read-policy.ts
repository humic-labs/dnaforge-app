import { HARD_CAP_BYTES } from '../../shared/oversized-guard';

export const GIT_READ_CONFIG_ARGS = Object.freeze([
  '-c',
  'core.longpaths=true',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.commitGraph=false',
  '-c',
  'core.multiPackIndex=false',
  '-c',
  'core.pager=false',
]);

export const GIT_READ_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
});

export const GIT_READ_MAX_ACTIVE = 1;
export const GIT_READ_MAX_QUEUED = 32;
export const GIT_READ_MAX_PATH_CODE_UNITS = 32_768;
export const GIT_READ_MAX_BUFFER = HARD_CAP_BYTES;
export const GIT_READ_MAX_METADATA_BUFFER = 1024 * 1024;
