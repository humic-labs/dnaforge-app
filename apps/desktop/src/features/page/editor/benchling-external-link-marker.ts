import { useEffect, useState, useSyncExternalStore } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import {
  isExactProviderStableId,
  isProviderObjectClass,
  isSafeProviderCanonicalUrl,
  providerObjectClassForStableId,
  providerStableIdFromUrl,
  type ProviderObjectClass,
} from '../../../shared/provider-object-reference';
import {
  getReferenceGeneration,
  subscribeToReferenceGeneration,
} from '../entity-ref/reference-generation';
import {
  resolveImportedProviderReferenceDestination,
  type ImportedProviderReferenceDestination,
  type ImportedProviderReferenceInput,
} from './native-entity-links';

export const BENCHLING_EXTERNAL_LINK_MARKER = 'B↗';

type BenchlingMarkerWidget = {
  key: string;
  position: number;
  label: string;
};

const benchlingMarkerPluginKey = new PluginKey<DecorationSet>('benchling-external-link-markers');

function markerWidget(widget: BenchlingMarkerWidget): Decoration {
  return Decoration.widget(
    widget.position,
    () => {
      const marker = document.createElement('span');
      marker.className = 'benchling-external-link-marker';
      marker.textContent = BENCHLING_EXTERNAL_LINK_MARKER;
      marker.title = 'Opens in Benchling';
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', `${widget.label}, opens in Benchling`);
      marker.setAttribute('data-benchling-link-destination', 'external');
      marker.setAttribute('data-benchling-link-marker', BENCHLING_EXTERNAL_LINK_MARKER);
      return marker;
    },
    { side: 1, key: widget.key }
  );
}

export const BenchlingExternalLinkMarkerExtension = Extension.create({
  name: 'benchlingExternalLinkMarkers',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: benchlingMarkerPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, current) {
            const widgets = transaction.getMeta(benchlingMarkerPluginKey) as
              | BenchlingMarkerWidget[]
              | undefined;
            return widgets
              ? DecorationSet.create(transaction.doc, widgets.map(markerWidget))
              : current.map(transaction.mapping, transaction.doc);
          },
        },
        props: {
          decorations(state) {
            return benchlingMarkerPluginKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export type BenchlingLinkDisplayDestination = 'checking' | 'native' | 'benchling' | 'none';

type DestinationResolver = (
  input: ImportedProviderReferenceInput
) => Promise<ImportedProviderReferenceDestination>;

type LinkIdentity = {
  stableObjectId: string;
  objectClass: ProviderObjectClass;
};

let cacheGeneration = -1;
const destinationCache = new Map<string, Promise<ImportedProviderReferenceDestination>>();

function identityFromLink(input: {
  href: string | null;
  stableObjectId: string | null;
  objectClass: string | null;
}): LinkIdentity | null {
  if (isExactProviderStableId(input.stableObjectId) && isProviderObjectClass(input.objectClass)) {
    return {
      stableObjectId: input.stableObjectId,
      objectClass: input.objectClass,
    };
  }

  const stableObjectId = providerStableIdFromUrl(input.href);
  const objectClass = stableObjectId ? providerObjectClassForStableId(stableObjectId) : null;
  return stableObjectId && objectClass ? { stableObjectId, objectClass } : null;
}

function destinationCacheKey(input: ImportedProviderReferenceInput): string {
  return JSON.stringify([input.owningRoot, input.stableObjectId, input.objectClass, input.href]);
}

function resolveCachedDestination(
  input: ImportedProviderReferenceInput,
  generation: number
): Promise<ImportedProviderReferenceDestination> {
  if (cacheGeneration !== generation) {
    destinationCache.clear();
    cacheGeneration = generation;
  }
  const key = destinationCacheKey(input);
  const existing = destinationCache.get(key);
  if (existing) return existing;
  const pending = resolveImportedProviderReferenceDestination(input);
  destinationCache.set(key, pending);
  return pending;
}

function displayDestination(
  destination: ImportedProviderReferenceDestination
): Exclude<BenchlingLinkDisplayDestination, 'checking'> {
  switch (destination.kind) {
    case 'native':
      return 'native';
    case 'benchling':
      return 'benchling';
    case 'none':
      return 'none';
  }
}

function applyExternalMarker(link: HTMLAnchorElement): void {
  link.setAttribute('data-benchling-link-destination', 'external');
  link.setAttribute('data-benchling-link-marker', BENCHLING_EXTERNAL_LINK_MARKER);
  if (!link.hasAttribute('aria-label')) {
    link.setAttribute('aria-label', `${link.textContent?.trim() || 'Link'}, opens in Benchling`);
    link.setAttribute('data-benchling-link-generated-aria-label', 'true');
  }
  if (!link.hasAttribute('title')) {
    link.setAttribute('title', 'Opens in Benchling');
    link.setAttribute('data-benchling-link-generated-title', 'true');
  }
}

function removeExternalMarker(link: HTMLAnchorElement): void {
  link.removeAttribute('data-benchling-link-destination');
  link.removeAttribute('data-benchling-link-marker');
  if (link.getAttribute('data-benchling-link-generated-aria-label') === 'true') {
    link.removeAttribute('aria-label');
    link.removeAttribute('data-benchling-link-generated-aria-label');
  }
  if (link.getAttribute('data-benchling-link-generated-title') === 'true') {
    link.removeAttribute('title');
    link.removeAttribute('data-benchling-link-generated-title');
  }
}

export async function refreshBenchlingExternalLinkMarkers({
  root,
  owningRoot,
  generation,
  resolveDestination,
  isCurrent = () => true,
}: {
  root: ParentNode;
  owningRoot: string | null;
  generation: number;
  resolveDestination?: DestinationResolver;
  isCurrent?: () => boolean;
}): Promise<void> {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')];
  await Promise.all(
    links.map(async (link) => {
      const href = link.getAttribute('href');
      if (!isSafeProviderCanonicalUrl(href)) {
        removeExternalMarker(link);
        return;
      }

      removeExternalMarker(link);
      const identity = identityFromLink({
        href,
        stableObjectId: link.getAttribute('data-provider-stable-id'),
        objectClass: link.getAttribute('data-provider-object-class'),
      });
      const destination = identity
        ? await (resolveDestination ?? ((input) => resolveCachedDestination(input, generation)))({
            ...identity,
            href,
            label: link.textContent?.trim() || identity.stableObjectId,
            owningRoot,
          })
        : ({ kind: 'benchling', url: href } satisfies ImportedProviderReferenceDestination);

      if (!isCurrent() || (!link.isConnected && !root.contains(link))) return;
      const currentIdentity = identityFromLink({
        href: link.getAttribute('href'),
        stableObjectId: link.getAttribute('data-provider-stable-id'),
        objectClass: link.getAttribute('data-provider-object-class'),
      });
      if (
        link.getAttribute('href') !== href ||
        currentIdentity?.stableObjectId !== identity?.stableObjectId ||
        currentIdentity?.objectClass !== identity?.objectClass
      ) {
        return;
      }
      if (destination.kind === 'benchling') {
        applyExternalMarker(link);
      } else if (destination.kind === 'native') {
        link.setAttribute('data-benchling-link-destination', 'native');
      }
    })
  );
}

type BenchlingLinkRange = LinkIdentity & {
  from: number;
  to: number;
  href: string;
  label: string;
};

function benchlingLinkRanges(doc: ProseMirrorNode): BenchlingLinkRange[] {
  const ranges: BenchlingLinkRange[] = [];
  doc.descendants((node, position) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => candidate.type.name === 'link');
    const href = typeof mark?.attrs.href === 'string' ? mark.attrs.href : null;
    if (!mark || !isSafeProviderCanonicalUrl(href)) return;
    const stableObjectId =
      typeof mark.attrs.providerStableId === 'string' ? mark.attrs.providerStableId : null;
    const objectClass =
      typeof mark.attrs.providerObjectClass === 'string' ? mark.attrs.providerObjectClass : null;
    const identity = identityFromLink({ href, stableObjectId, objectClass });
    if (!identity) return;

    const from = position;
    const to = position + node.nodeSize;
    const previous = ranges[ranges.length - 1];
    if (
      previous &&
      previous.to === from &&
      previous.href === href &&
      previous.stableObjectId === identity.stableObjectId &&
      previous.objectClass === identity.objectClass
    ) {
      previous.to = to;
      previous.label += node.textContent;
      return;
    }
    ranges.push({ ...identity, from, to, href, label: node.textContent });
  });
  return ranges;
}

export async function refreshBenchlingExternalLinkDecorations({
  editor,
  owningRoot,
  generation,
  isCurrent = () => true,
}: {
  editor: Editor;
  owningRoot: string | null;
  generation: number;
  isCurrent?: () => boolean;
}): Promise<void> {
  const widgets = (
    await Promise.all(
      benchlingLinkRanges(editor.state.doc).map(async (range) => {
        const destination = await resolveCachedDestination(
          {
            stableObjectId: range.stableObjectId,
            objectClass: range.objectClass,
            href: range.href,
            label: range.label,
            owningRoot,
          },
          generation
        );
        return destination.kind === 'benchling'
          ? ({
              key: `${range.from}:${range.to}:${range.href}`,
              position: range.to,
              label: range.label,
            } satisfies BenchlingMarkerWidget)
          : null;
      })
    )
  ).filter((widget): widget is BenchlingMarkerWidget => widget !== null);

  if (!isCurrent() || editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(benchlingMarkerPluginKey, widgets).setMeta('addToHistory', false)
  );
}

export function useBenchlingLinkDisplayDestination(input: {
  href: string | null;
  label: string;
  owningRoot: string | null;
  stableObjectId: string | null;
  objectClass: ProviderObjectClass | null;
}): BenchlingLinkDisplayDestination {
  const generation = useSyncExternalStore(
    subscribeToReferenceGeneration,
    getReferenceGeneration,
    getReferenceGeneration
  );
  const [destination, setDestination] = useState<BenchlingLinkDisplayDestination>('checking');

  useEffect(() => {
    let cancelled = false;
    if (!isSafeProviderCanonicalUrl(input.href)) {
      setDestination('none');
      return () => {
        cancelled = true;
      };
    }

    if (!input.stableObjectId || !input.objectClass) {
      setDestination('benchling');
      return () => {
        cancelled = true;
      };
    }

    setDestination('checking');
    void resolveCachedDestination(
      {
        stableObjectId: input.stableObjectId,
        objectClass: input.objectClass,
        href: input.href,
        label: input.label,
        owningRoot: input.owningRoot,
      },
      generation
    ).then((result) => {
      if (!cancelled) setDestination(displayDestination(result));
    });
    return () => {
      cancelled = true;
    };
  }, [
    generation,
    input.href,
    input.label,
    input.objectClass,
    input.owningRoot,
    input.stableObjectId,
  ]);

  return destination;
}

export function __resetBenchlingLinkDestinationCacheForTests(): void {
  cacheGeneration = -1;
  destinationCache.clear();
}
