import { redactSensitive } from './redact-sensitive';

const PATH_REDACTED = '[redacted-path]';
const TEXT_REDACTED = '[redacted-text]';

const PATH_CHAR = String.raw`[^\s"'\x60:,;()\[\]{}<>\\/]`;
const PATH_CHAR_OR_REDACTED_SECRET = String.raw`(?:${PATH_CHAR}|\[redacted(?:-[a-z]+)*\])`;
const DIRECTORY_WITH_SPACES = String.raw`${PATH_CHAR_OR_REDACTED_SECRET}+(?: ${PATH_CHAR_OR_REDACTED_SECRET}+)*`;
const FILE_NAME_TO_EXTENSION = String.raw`(?:[^\\/\n"'\x60]*?\.[A-Za-z0-9]{1,10}\b|${PATH_CHAR_OR_REDACTED_SECRET}+)`;
const PATH_REMAINDER = String.raw`(?:[\\/]${DIRECTORY_WITH_SPACES}(?=[\\/]))*[\\/]${FILE_NAME_TO_EXTENSION}`;

const HOME_PATH_WITH_ANY_USERNAME = new RegExp(
  String.raw`(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)(?:[^\\/\n"\x60]{1,64}(?=[\\/])(${PATH_REMAINDER})|[^\\/\s"'\x60:]+)`,
  'g'
);
const VOLUME_OR_TEMP_PATH = new RegExp(
  String.raw`(\/Volumes|\/mnt|\/media|\/private\/tmp|\/tmp|\/private\/var\/folders|\/var\/folders)(${PATH_REMAINDER})`,
  'g'
);
const DRIVE_PATH_OUTSIDE_SYSTEM_FOLDERS = new RegExp(
  String.raw`\b([A-Za-z]:)(?!\\(?:Program Files\b|Windows\b|Users\\\[redacted-user\]))(${PATH_REMAINDER})`,
  'g'
);
const NETWORK_SHARE_PATH = new RegExp(
  String.raw`\\\\${PATH_CHAR_OR_REDACTED_SECRET}+(?:\\${DIRECTORY_WITH_SPACES})+`,
  'g'
);
const APP_BUNDLE_SEGMENT = /app\.asar(?:\.unpacked)?[\\/]/;

const NUCLEOTIDE_RUN = /\b[ACGTURYKMSWBDHVN]{20,}\b/gi;
const PROTEIN_RUN = /\b[ACDEFGHIKLMNPQRSTVWY]{30,}\b/g;

const DOUBLE_QUOTED_STRINGS_IN_ORDER = /"(?:[^"\\\n]|\\.){0,500}"/g;
const JSON_KEY_COLON = /\s*:/y;
const SINGLE_QUOTED_NOT_APOSTROPHE = /(?<![\w])'[^'\n]{1,500}'(?![\w])/g;
const BACKTICK_QUOTED = /`[^`\n]{1,500}`/g;
const TYPOGRAPHIC_QUOTED = /[“‘][^”’\n]{1,500}[”’]/g;

function redactPathKeepingAppBundleTail(root: string, rest: string): string {
  const separator = rest[0];
  const bundle = rest.search(APP_BUNDLE_SEGMENT);
  const tail = bundle >= 0 ? `${separator}${rest.slice(bundle)}` : '';
  return `${root}${separator}${PATH_REDACTED}${tail}`;
}

function isJsonKey(quoted: string, offset: number, whole: string): boolean {
  JSON_KEY_COLON.lastIndex = offset + quoted.length;
  return JSON_KEY_COLON.test(whole);
}

export function redactTelemetryText(input: string): string {
  if (!input) return input;
  const secretsRedacted = redactSensitive(input);
  return secretsRedacted
    .replace(HOME_PATH_WITH_ANY_USERNAME, (_match, root: string, rest: string | undefined) => {
      const home = `${root}[redacted-user]`;
      return rest ? redactPathKeepingAppBundleTail(home, rest) : home;
    })
    .replace(VOLUME_OR_TEMP_PATH, (_match, root: string, rest: string) =>
      redactPathKeepingAppBundleTail(root, rest)
    )
    .replace(DRIVE_PATH_OUTSIDE_SYSTEM_FOLDERS, (_match, drive: string, rest: string) =>
      redactPathKeepingAppBundleTail(drive, rest)
    )
    .replace(NETWORK_SHARE_PATH, `\\\\${PATH_REDACTED}`)
    .replace(NUCLEOTIDE_RUN, '[redacted-sequence]')
    .replace(PROTEIN_RUN, '[redacted-sequence]')
    .replace(DOUBLE_QUOTED_STRINGS_IN_ORDER, (quoted, offset: number, whole: string) =>
      quoted === '""' || isJsonKey(quoted, offset, whole) ? quoted : `"${TEXT_REDACTED}"`
    )
    .replace(SINGLE_QUOTED_NOT_APOSTROPHE, `'${TEXT_REDACTED}'`)
    .replace(BACKTICK_QUOTED, `\`${TEXT_REDACTED}\``)
    .replace(TYPOGRAPHIC_QUOTED, `“${TEXT_REDACTED}”`);
}
