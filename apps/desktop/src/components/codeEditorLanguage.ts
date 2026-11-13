import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { xml } from '@codemirror/legacy-modes/mode/xml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { r } from '@codemirror/legacy-modes/mode/r';
import { c, cpp, java, kotlin, scala } from '@codemirror/legacy-modes/mode/clike';

const LANGUAGE_FACTORIES: Record<string, () => Extension> = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),

  python: () => python(),

  json: () => json(),

  markdown: () => markdown(),

  css: () => css(),
  scss: () => css(),
  sass: () => css(),
  less: () => css(),

  html: () => html(),

  yaml: () => yaml(),

  bash: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
  ini: () => StreamLanguage.define(properties),
  xml: () => StreamLanguage.define(xml),
  docker: () => StreamLanguage.define(dockerFile),

  go: () => StreamLanguage.define(go),
  rust: () => StreamLanguage.define(rust),
  ruby: () => StreamLanguage.define(ruby),
  swift: () => StreamLanguage.define(swift),
  r: () => StreamLanguage.define(r),
  c: () => StreamLanguage.define(c),
  cpp: () => StreamLanguage.define(cpp),
  java: () => StreamLanguage.define(java),
  kotlin: () => StreamLanguage.define(kotlin),
  scala: () => StreamLanguage.define(scala),
};

export function getCodeMirrorLanguage(languageId: string): Extension | null {
  const factory = LANGUAGE_FACTORIES[languageId];
  return factory ? factory() : null;
}

export function hasLanguageSupport(languageId: string): boolean {
  return languageId in LANGUAGE_FACTORIES;
}
