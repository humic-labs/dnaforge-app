import type { Options as ReactMarkdownOptions } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { common } from 'lowlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const MARKDOWN_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  remarkBreaks,
];

export const MARKDOWN_HIGHLIGHT_LANGUAGES = {
  bash: common.bash,
  c: common.c,
  cpp: common.cpp,
  css: common.css,
  diff: common.diff,
  javascript: common.javascript,
  json: common.json,
  markdown: common.markdown,
  plaintext: common.plaintext,
  python: common.python,
  r: common.r,
  shell: common.shell,
  sql: common.sql,
  typescript: common.typescript,
  xml: common.xml,
  yaml: common.yaml,
};

export const MARKDOWN_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions['rehypePlugins']> = [
  [
    rehypeHighlight,
    {
      detect: false,
      languages: MARKDOWN_HIGHLIGHT_LANGUAGES,
    },
  ],
];
