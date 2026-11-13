import type { JSONContent } from '@tiptap/core';

import { nativeEntityReferenceIdFromHref } from './native-entity-reference';
import { savedReferenceHref, savedReferenceIdFromHref } from './saved-reference-url';
import { projectResourceReferenceFromHref } from './project-resource-reference';

export function notebookReferenceFromHref(href: string, label: string): JSONContent | null {
  const resourceReference = projectResourceReferenceFromHref(href);
  if (resourceReference)
    return { type: 'mention', attrs: { entityType: 'project-resource', resourceReference, label } };
  const entityId = nativeEntityReferenceIdFromHref(href);
  if (entityId)
    return { type: 'mention', attrs: { entityType: 'native-catalog', entityId, label } };
  const referenceId = savedReferenceIdFromHref(href);
  if (referenceId)
    return {
      type: 'mention',
      attrs: { entityType: 'reference', referenceUri: savedReferenceHref(referenceId), label },
    };
  if (/^(?:dnaforge-chat|entity):/i.test(href))
    return { type: 'mention', attrs: { entityType: 'reference', referenceUri: href, label } };
  return null;
}

function internalHref(node: JSONContent): string | null {
  if (node.type !== 'text' || node.marks?.some((mark) => mark.type === 'code')) return null;
  const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
  return typeof href === 'string' && notebookReferenceFromHref(href, '') ? href : null;
}

export function normalizeNotebookReferences(node: JSONContent): JSONContent {
  if (
    !node ||
    !Array.isArray(node.content) ||
    node.type === 'codeBlock' ||
    node.type === 'rawMarkdown'
  )
    return node;
  const content: JSONContent[] = [];
  let changed = false;
  for (let index = 0; index < node.content.length; index++) {
    const child = node.content[index];
    const href = internalHref(child);
    if (href) {
      let label = child.text ?? '';
      let marks = child.marks?.filter((mark) => mark.type !== 'link') ?? [];
      while (index + 1 < node.content.length && internalHref(node.content[index + 1]) === href) {
        const next = node.content[++index];
        label += next.text ?? '';
        marks = marks.filter((mark) =>
          next.marks?.some((other) => JSON.stringify(other) === JSON.stringify(mark))
        );
      }
      const reference = notebookReferenceFromHref(href, label)!;
      content.push(marks.length ? { ...reference, marks } : reference);
      changed = true;
    } else {
      const normalized = normalizeNotebookReferences(child);
      content.push(normalized);
      changed ||= normalized !== child;
    }
  }
  return changed ? { ...node, content } : node;
}
