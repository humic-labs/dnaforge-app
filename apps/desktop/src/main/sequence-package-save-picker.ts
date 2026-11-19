interface PickerState {
  open: number;
  listeners: Set<(open: boolean) => void>;
}
const windows = new WeakMap<object, PickerState>();

function pickerFor(sender: object): PickerState {
  let state = windows.get(sender);
  if (!state) {
    state = { open: 0, listeners: new Set() };
    windows.set(sender, state);
  }
  return state;
}

export function watchSequencePackageSavePicker(
  sender: object,
  listener: (open: boolean) => void
): () => void {
  const state = pickerFor(sender);
  state.listeners.add(listener);
  listener(state.open > 0);
  return () => {
    state.listeners.delete(listener);
  };
}

export async function withSequencePackageSavePicker<T>(
  sender: object,
  show: () => Promise<T>
): Promise<T> {
  const state = pickerFor(sender);
  if (++state.open === 1) for (const listener of state.listeners) listener(true);
  try {
    return await show();
  } finally {
    if (--state.open === 0) for (const listener of state.listeners) listener(false);
  }
}
