import { Buffer } from 'node:buffer';
import { DOMParser } from 'linkedom';
import {
  isExactProviderStableId,
  providerStableIdFromUrl,
} from '../../shared/provider-object-reference';
import { parseUniqueJson } from '../../shared/unique-json';
import type {
  OligoClassificationEvidence,
  OligoClassificationEvidencePacket,
} from '../../shared/oligo-classification';

type HtmlNode = {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<HtmlNode>;
  tagName?: string;
  parentElement?: HtmlNode | null;
  getAttribute?: (name: string) => string | null;
};
type HtmlElement = HtmlNode & {
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => HtmlElement | null;
  querySelectorAll: (selector: string) => Iterable<HtmlElement>;
};

export function extractOligoClassificationEvidence(input: {
  html: string;
  sourceObjectId: string;
  sourceEntryPath: string;
  sourceEntrySha256: string;
}): OligoClassificationEvidencePacket {
  const facts: OligoClassificationEvidence[] = [];
  const result = {
    schema: 'dnaforge.benchling.classification-evidence.v1' as const,
    facts,
    limited: false,
  };
  if (Buffer.byteLength(input.html, 'utf8') > 8 * 1024 * 1024) return { ...result, limited: true };
  const document: { querySelectorAll: (selector: string) => Iterable<HtmlElement> } =
    new DOMParser().parseFromString(input.html, 'text/html');
  let occurrence = 0;
  for (const chip of document.querySelectorAll('.internalLink[data-internal-link]')) {
    if (occurrence >= 4096 || facts.length >= 256) return { ...result, limited: true };
    const index = occurrence++;
    const ancestry = classifyAncestors(chip);
    if (ancestry === 'limited') result.limited = true;
    if (ancestry !== 'included') continue;
    const raw = chip.getAttribute('data-internal-link');
    if (!raw || raw.length > 4096) continue;
    let payload: unknown;
    try {
      payload = parseUniqueJson(raw);
    } catch {
      continue;
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !('id' in payload) ||
      !isExactProviderStableId(payload.id) ||
      !payload.id.startsWith('seq_')
    )
      continue;
    const target = payload.id;
    const anchors = [...chip.querySelectorAll('a[href]')];
    const urls = [
      ...('url' in payload ? [payload.url] : []),
      ...anchors.map((anchor) => anchor.getAttribute('href')),
    ];
    if (urls.some((url) => targetId(url) !== target)) continue;
    const location = {
      sourceObjectId: input.sourceObjectId,
      targetSourceId: target,
      sourceEntryPath: input.sourceEntryPath,
      sourceEntrySha256: input.sourceEntrySha256,
      occurrence: index,
    };
    if (
      'iconId' in payload &&
      typeof payload.iconId === 'string' &&
      /^[a-z][a-z0-9_-]{0,63}$/iu.test(payload.iconId)
    )
      facts.push({ ...location, channel: 'provider_display_type', value: payload.iconId });
    const block = chip.closest(
      '[data-test-component="EditableComponent"][data-test-element="root"],p,li,td'
    );
    if (!block) continue;
    const declaration = boundedDeclaration(block);
    if (declaration === null) {
      result.limited = true;
      continue;
    }
    const prefix = prefixBeforeFirstReference(block, chip);
    if (prefix.status === 'limited') {
      result.limited = true;
      continue;
    }
    if (prefix.status !== 'found') continue;
    if (
      /[?？]|\b(?:not|never|no\s+longer|possibly|possible|maybe|perhaps|uncertain|unlikely|instead|formerly|previously|isn['’]t|wasn['’]t|aren['’]t)\b/iu.test(
        declaration
      ) &&
      /\b(?:primer|probe|sgRNA)\b/iu.test(prefix.text)
    ) {
      if (facts.length >= 256) return { ...result, limited: true };
      facts.push({
        ...location,
        channel: 'authored_role_disputed',
        value: 'review_required',
        excerpt: declaration.trim().replace(/\s+/gu, ' ').slice(0, 512),
      });
      continue;
    }
    const match =
      /^(?:redesigned\s+)?(?:(?:forward|reverse)\s+)?(primer|probe|sgRNA)\s*[:–—-]\s*$/iu.exec(
        prefix.text
      );
    if (!match) continue;
    if (facts.length >= 256) return { ...result, limited: true };
    const value =
      match[1].toLowerCase() === 'sgrna'
        ? 'sgRNA'
        : match[1].toLowerCase() === 'probe'
          ? 'probe'
          : 'primer';
    facts.push({
      ...location,
      channel: 'authored_role',
      value,
      excerpt: prefix.text.replace(/\s*[:–—-]\s*$/u, ''),
    });
  }
  return result;
}

function excludedNode(node: HtmlNode): boolean {
  if (
    node.tagName &&
    /^(?:blockquote|pre|code|script|style|template|del|s|q|strike)$/iu.test(node.tagName)
  )
    return true;
  if (!node.getAttribute) return false;
  return (
    node.getAttribute('hidden') !== null ||
    node.getAttribute('aria-hidden')?.toLowerCase() === 'true' ||
    /(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bline-through\b/iu.test(
      node.getAttribute('style') ?? ''
    ) ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))(?:\s*!important)?\s*(?:;|$)/iu.test(
      node.getAttribute('style') ?? ''
    )
  );
}

function classifyAncestors(node: HtmlNode): 'included' | 'excluded' | 'limited' {
  let current: HtmlNode | null | undefined = node;
  let depth = 0;
  while (current) {
    if (++depth > 128) return 'limited';
    if (excludedNode(current)) return 'excluded';
    current = current.parentElement;
  }
  return 'included';
}

function boundedDeclaration(block: HtmlNode): string | null {
  let text = '';
  let visited = 0;
  const walk = (node: HtmlNode, depth: number): boolean => {
    if (++visited > 1024 || depth > 16 || text.length > 4096) return false;
    if (node.nodeType === 3) text += node.textContent ?? '';
    return (
      text.length <= 4096 && Array.from(node.childNodes).every((child) => walk(child, depth + 1))
    );
  };
  return walk(block, 0) ? text : null;
}

function targetId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return providerStableIdFromUrl(
    value.startsWith('/') && !value.startsWith('//') ? `https://benchling.com${value}` : value
  );
}

function prefixBeforeFirstReference(
  block: HtmlNode,
  chip: HtmlNode
): { status: 'found'; text: string } | { status: 'limited' | 'invalid' | 'continue' } {
  let text = '';
  let visited = 0;
  const walk = (node: HtmlNode, depth: number): 'found' | 'continue' | 'invalid' | 'limited' => {
    if (++visited > 1024 || depth > 16 || text.length > 512) return 'limited';
    if (node === chip) return 'found';
    if (excludedNode(node)) return 'invalid';
    if (
      node.getAttribute?.('data-internal-link') !== undefined &&
      node.getAttribute?.('data-internal-link') !== null
    )
      return 'invalid';
    if (node.getAttribute?.('href')) return 'invalid';
    if (node.nodeType === 3) text += node.textContent ?? '';
    for (const child of Array.from(node.childNodes)) {
      const result = walk(child, depth + 1);
      if (result !== 'continue') return result;
    }
    return 'continue';
  };
  const status = walk(block, 0);
  return status === 'found' ? { status, text: text.trim().replace(/\s+/gu, ' ') } : { status };
}
