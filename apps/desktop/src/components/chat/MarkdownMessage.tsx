import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options as ReactMarkdownOptions,
} from 'react-markdown';

import { CopyButton } from './CopyButton';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from './markdown-config';
import { splitMarkdownBlocks } from './markdown-blocks';
import { rehypeInlineReferences } from './rehype-inline-references';
import { buildInlineTextDocument } from '../../features/ai/references/inline/document';
import type {
  InlineReferencePart,
  InlineTextDocument,
} from '../../features/ai/references/inline/types';

const MarkdownSourceContext = createContext('');
const InlineReferenceContext = createContext<{
  parts: ReadonlyMap<string, InlineReferencePart>;
  render?: (part: InlineReferencePart) => ReactNode;
}>({ parts: new Map() });

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function originalNodeSource(source: string, node: ExtraProps['node']): string {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return source;
  return source.slice(start, end);
}

function MarkdownTable({
  node,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  const source = useContext(MarkdownSourceContext);
  const tableMarkdown = originalNodeSource(source, node);
  return (
    <div className="group my-3 max-w-full" data-testid="markdown-table">
      <div
        className="overflow-hidden rounded-lg border border-border"
        data-testid="markdown-table-frame"
      >
        <div className="max-w-full overflow-x-auto" data-testid="markdown-table-scroll">
          <table
            {...props}
            className={classNames(
              'w-max min-w-full border-collapse text-left text-xs text-fg',
              className
            )}
          >
            {children}
          </table>
        </div>
      </div>
      <div className="flex items-center justify-end pt-1" data-testid="markdown-table-actions">
        <CopyButton text={tableMarkdown} size={12} showLabel />
      </div>
    </div>
  );
}

function MarkdownLink({
  node: _node,
  href,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const transformed = href ? defaultUrlTransform(href) : '';
  let parsed: URL | null = null;
  try {
    parsed = transformed ? new URL(transformed) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return <span className="text-fg">{children}</span>;
  }

  return (
    <a
      {...props}
      href={parsed.href}
      target="_blank"
      rel="noreferrer noopener"
      className={classNames(
        'font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent',
        className
      )}
    >
      {children}
    </a>
  );
}

type MarkdownSpanProps = ComponentPropsWithoutRef<'span'> &
  ExtraProps & {
    'data-dnaforge-inline-reference-key'?: string;
  };

function MarkdownSpan({
  node: _node,
  children,
  'data-dnaforge-inline-reference-key': key,
  ...props
}: MarkdownSpanProps) {
  const context = useContext(InlineReferenceContext);
  const part = key ? context.parts.get(key) : undefined;
  if (!part || part.state.status !== 'resolved' || !context.render) {
    return <span {...props}>{children}</span>;
  }
  return <>{context.render(part)}</>;
}

export const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      {...props}
      className={classNames('my-2 border-l-2 border-accent/50 pl-3 text-fg-muted', className)}
    />
  ),
  br: ({ node: _node, className, ...props }) => (
    <br {...props} className={classNames('leading-relaxed', className)} />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      {...props}
      className={classNames(
        'rounded bg-bg-muted px-1 py-0.5 font-mono text-[0.9em] text-fg',
        className
      )}
    />
  ),
  del: ({ node: _node, className, ...props }) => (
    <del {...props} className={classNames('text-fg-muted line-through', className)} />
  ),
  em: ({ node: _node, className, ...props }) => (
    <em {...props} className={classNames('italic text-fg', className)} />
  ),
  h1: ({ node: _node, className, ...props }) => (
    <h1 {...props} className={classNames('mb-2 mt-4 text-lg font-semibold text-fg', className)} />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2
      {...props}
      className={classNames('mb-1.5 mt-3 text-base font-semibold text-fg', className)}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3 {...props} className={classNames('mb-1 mt-3 text-sm font-semibold text-fg', className)} />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4 {...props} className={classNames('mb-1 mt-2 text-sm font-medium text-fg', className)} />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5
      {...props}
      className={classNames(
        'mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-fg-muted',
        className
      )}
    />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6
      {...props}
      className={classNames(
        'mb-1 mt-2 text-xs font-medium uppercase tracking-wide text-fg-subtle',
        className
      )}
    />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr {...props} className={classNames('my-4 border-0 border-t border-border', className)} />
  ),
  img: ({ node: _node, className, alt, ...props }) => (
    <img
      {...props}
      alt={alt ?? ''}
      loading="lazy"
      className={classNames('my-2 max-w-full rounded-lg border border-border', className)}
    />
  ),
  input: ({ node: _node, className, ...props }) => (
    <input
      {...props}
      disabled
      className={classNames('mr-1.5 align-middle accent-accent', className)}
    />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li
      {...props}
      className={classNames('my-0.5 pl-0.5 text-fg marker:text-fg-muted', className)}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol
      {...props}
      className={classNames('my-2 list-decimal space-y-0.5 pl-6 text-fg', className)}
    />
  ),
  p: ({ node: _node, className, ...props }) => (
    <p {...props} className={classNames('my-1.5 whitespace-normal text-fg', className)} />
  ),
  pre: ({ node: _node, className, ...props }) => (
    <pre
      {...props}
      className={classNames(
        'my-2 max-w-full overflow-x-auto rounded-lg border border-border bg-bg-muted p-3 font-mono text-xs text-fg',
        className
      )}
    />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong {...props} className={classNames('font-semibold text-fg', className)} />
  ),
  span: MarkdownSpan,
  table: MarkdownTable,
  tbody: ({ node: _node, className, ...props }) => (
    <tbody {...props} className={classNames('divide-y divide-border bg-bg text-fg', className)} />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td
      {...props}
      className={classNames(
        'max-w-[24rem] border-r border-border px-3 py-2 align-top last:border-r-0',
        className
      )}
    />
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      {...props}
      className={classNames(
        'whitespace-nowrap border-r border-border px-3 py-2 align-bottom font-semibold text-fg last:border-r-0',
        className
      )}
    />
  ),
  thead: ({ node: _node, className, ...props }) => (
    <thead
      {...props}
      className={classNames('border-b border-border bg-bg-muted text-fg', className)}
    />
  ),
  tr: ({ node: _node, className, ...props }) => (
    <tr {...props} className={classNames('border-0 wp-interactive', className)} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul {...props} className={classNames('my-2 list-disc space-y-0.5 pl-6 text-fg', className)} />
  ),
};

interface MarkdownBlockProps {
  source: string;
  sourceOffset: number;
}

const MarkdownBlock = memo(
  function MarkdownBlock({ source, sourceOffset }: MarkdownBlockProps) {
    const rehypePlugins = useMemo(
      () =>
        [[rehypeInlineReferences, { sourceOffset }], ...MARKDOWN_REHYPE_PLUGINS] as NonNullable<
          ReactMarkdownOptions['rehypePlugins']
        >,
      [sourceOffset]
    );
    return (
      <MarkdownSourceContext.Provider value={source}>
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
          components={MARKDOWN_COMPONENTS}
        >
          {source}
        </ReactMarkdown>
      </MarkdownSourceContext.Provider>
    );
  },
  (previous, next) => previous.source === next.source && previous.sourceOffset === next.sourceOffset
);

export function MarkdownMessage({
  content,
  streaming = false,
  document: suppliedDocument,
  renderInlineReference,
}: {
  content: string;
  streaming?: boolean;
  document?: InlineTextDocument;
  renderInlineReference?: (part: InlineReferencePart) => ReactNode;
}): ReactNode {
  const computedDocument = useMemo(
    () => suppliedDocument ?? buildInlineTextDocument(content, { streaming }),
    [content, streaming, suppliedDocument]
  );
  const parts = useMemo(
    () => new Map(computedDocument.parts.map((part) => [part.key, part])),
    [computedDocument.parts]
  );
  const blocks = useMemo(
    () =>
      streaming
        ? splitMarkdownBlocks(computedDocument.renderSource)
        : [
            {
              key: 'markdown-document',
              source: computedDocument.renderSource,
              completed: true,
              startOffset: 0,
              endOffset: computedDocument.renderSource.length,
            },
          ],
    [computedDocument.renderSource, streaming]
  );
  return (
    <InlineReferenceContext.Provider value={{ parts, render: renderInlineReference }}>
      {blocks.map((block) => (
        <MarkdownBlock key={block.key} source={block.source} sourceOffset={block.startOffset} />
      ))}
    </InlineReferenceContext.Provider>
  );
}
