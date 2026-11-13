export class CompiledBroadDemandCellBank<TAddress extends { cellId: string }> {
  readonly required = new Map<string, TAddress>();
  readonly successor = new Map<string, TAddress>();
  readonly interactionPrefetch = new Map<string, TAddress>();
  readonly prefetch = new Map<string, TAddress>();

  addRequired(address: TAddress): void {
    this.successor.delete(address.cellId);
    this.interactionPrefetch.delete(address.cellId);
    this.prefetch.delete(address.cellId);
    this.required.set(address.cellId, address);
  }

  addSuccessor(address: TAddress): void {
    if (this.required.has(address.cellId)) return;
    this.interactionPrefetch.delete(address.cellId);
    this.prefetch.delete(address.cellId);
    this.successor.set(address.cellId, address);
  }

  addInteractionPrefetch(address: TAddress): void {
    if (this.required.has(address.cellId) || this.successor.has(address.cellId)) return;
    this.prefetch.delete(address.cellId);
    this.interactionPrefetch.set(address.cellId, address);
  }

  addPrefetch(address: TAddress): void {
    if (
      this.required.has(address.cellId) ||
      this.successor.has(address.cellId) ||
      this.interactionPrefetch.has(address.cellId)
    ) {
      return;
    }
    this.prefetch.set(address.cellId, address);
  }
}
