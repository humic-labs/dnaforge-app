import { sha256Hex } from '@/shared/sha256-sync';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  installProteinExtension,
  listInstalledProteinExtensions,
  runProteinExtension,
  supportsProteinExtensions,
  uninstallProteinExtension,
  type InstalledProteinExtension,
} from '../installed-protein-extensions';
import type { MolstarPlugin } from '../molstar/cache';
import { getMolViewSpecCoordinates } from '../molstar/molViewSpec';

const packagesChanged = new EventTarget();

function extensionMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useProteinExtensionView(plugin: MolstarPlugin | null, viewKey: string) {
  const available = supportsProteinExtensions();
  const storageKey = useMemo(
    () => `dnaforge.protein-extension.v1:${sha256Hex(viewKey)}`,
    [viewKey]
  );
  const [choice, setChoice] = useState<{ key: string; id: string | null } | null>(null);
  const [installed, setInstalled] = useState<InstalledProteinExtension[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const selectedId = choice?.key === storageKey ? choice.id : null;

  useEffect(() => {
    if (!available) return;
    try {
      setChoice({ key: storageKey, id: localStorage.getItem(storageKey) });
    } catch (reason) {
      setError(extensionMessage(reason));
    }
  }, [available, storageKey]);

  useEffect(() => {
    if (!available) return;
    let current = true;
    let generation = 0;
    const refresh = () => {
      const ownGeneration = ++generation;
      void listInstalledProteinExtensions()
        .then((items) => {
          if (!current || ownGeneration !== generation) return;
          setInstalled(items);
        })
        .catch((reason) => {
          if (current) setError(extensionMessage(reason));
        });
    };
    refresh();
    packagesChanged.addEventListener('change', refresh);
    return () => {
      current = false;
      packagesChanged.removeEventListener('change', refresh);
    };
  }, [available]);

  const select = useCallback(
    (id: string | null) => {
      setError(null);
      setChoice({ key: storageKey, id });
      try {
        if (id) localStorage.setItem(storageKey, id);
        else localStorage.removeItem(storageKey);
      } catch (reason) {
        setError(extensionMessage(reason));
      }
    },
    [storageKey]
  );

  useEffect(() => {
    setActive(null);
    if (!plugin || !selectedId || !installed) {
      setPending(false);
      return;
    }
    if (!installed.some(({ id }) => id === selectedId)) {
      setError(
        `The saved protein extension ${selectedId} is unavailable. Install it to restore this view.`
      );
      setPending(false);
      return;
    }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setError(null);
    setPending(true);
    async function activate(viewer: MolstarPlugin, id: string) {
      const { format, text } = getMolViewSpecCoordinates(viewer);
      const { activateExtensionRender } = await import('../molstar/extension-render');
      controller.signal.throwIfAborted();
      const result = await runProteinExtension(
        id,
        { text, filename: `structure.${format}` },
        controller.signal
      );
      controller.signal.throwIfAborted();
      const dispose = await activateExtensionRender(viewer, result, controller.signal);
      if (controller.signal.aborted) {
        dispose();
        return;
      }
      release = dispose;
      setActive(id);
    }
    void activate(plugin, selectedId)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(extensionMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [plugin, selectedId, storageKey, installed]);

  const install = async (file: File) => {
    try {
      const extension = await installProteinExtension(file);
      packagesChanged.dispatchEvent(new Event('change'));
      select(extension.id);
    } catch (reason) {
      setError(extensionMessage(reason));
    }
  };
  const uninstall = async (id: string) => {
    try {
      await uninstallProteinExtension(id);
      if (selectedId === id) select(null);
      packagesChanged.dispatchEvent(new Event('change'));
    } catch (reason) {
      setError(extensionMessage(reason));
    }
  };
  return {
    available,
    installed: installed ?? [],
    active,
    selectedId,
    pending,
    error,
    select,
    install,
    uninstall,
  };
}

export type ProteinExtensionView = ReturnType<typeof useProteinExtensionView>;
