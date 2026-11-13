import { selectProvider, useComputeStore } from './store';

export function ConnectComputeProviderChip() {
  const pending = useComputeStore((s) => s.pendingConnectProviderId);
  const providers = useComputeStore((s) => s.providers);
  const openConnectDialog = useComputeStore((s) => s.openConnectDialog);
  if (!pending) return null;
  const specific = pending === '*' ? null : pending;
  const provider = selectProvider({ providers } as Parameters<typeof selectProvider>[0], specific);
  const label = provider ? `Connect ${provider.displayName}` : 'Connect a compute provider';
  return (
    <button
      type="button"
      onClick={() => openConnectDialog(specific)}
      className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
      data-testid="connect-compute-chip"
      title="The agent needs a compute provider key to run this job."
    >
      {label}
    </button>
  );
}
