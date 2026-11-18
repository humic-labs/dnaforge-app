import { useEffect, useRef, useState } from 'react';
import type { LimsRegistrySummary } from '../../../../shared/lims';
import { createWorkTask, useWorkAccount } from '../../../work/public/work';
import { getLimsRegistryPreview } from '../../operations';

type Selection = { workspaceId: number; id: string; name: string };
export function useRegistryTaskSelection() {
  const account = useWorkAccount();
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const [mode, setMode] = useState(false);
  const [items, setItems] = useState<Selection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const locked = useRef(false);
  function clear() {
    generation.current++;
    locked.current = false;
    setBusy(false);
    setItems([]);
    setError('');
    setMode(false);
  }
  useEffect(() => {
    clear();
    return () => {
      generation.current++;
    };
  }, [account]);
  const matches = (item: Selection, row: LimsRegistrySummary) =>
    item.id === row.id && (row.workspaceId == null || item.workspaceId === row.workspaceId);
  async function toggle(row: LimsRegistrySummary) {
    if (locked.current || row.archived) return;
    setError('');
    if (items.some((item) => matches(item, row))) {
      setItems((current) => current.filter((item) => !matches(item, row)));
      return;
    }
    const token = ++generation.current;
    locked.current = true;
    setBusy(true);
    try {
      const workspaceId =
        row.workspaceId ?? (await getLimsRegistryPreview({ entityId: row.id }))?.entity.workspaceId;
      if (generation.current !== token || currentAccount.current !== account) return;
      if (workspaceId == null) throw new Error('This record’s owning project is unavailable.');
      if (items.length && items[0].workspaceId !== workspaceId)
        throw new Error('Choose records from the same project.');
      setItems((current) => [...current, { workspaceId, id: row.id, name: row.name }]);
    } catch (cause) {
      if (generation.current === token)
        setError(cause instanceof Error ? cause.message : 'Record unavailable.');
    } finally {
      if (generation.current === token) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function create() {
    if (!items.length || locked.current || currentAccount.current !== account) return;
    const shown = createWorkTask({
      workspaceId: items[0].workspaceId,
      subjectIds: items.map((item) => item.id),
      subjectName: items.length === 1 ? items[0].name : items.length + ' linked records',
    });
    if (shown) clear();
  }
  return {
    mode,
    items,
    error,
    busy,
    begin: () => setMode(true),
    clear,
    toggle,
    checked: (row: LimsRegistrySummary) => items.some((item) => matches(item, row)),
    create,
  };
}
