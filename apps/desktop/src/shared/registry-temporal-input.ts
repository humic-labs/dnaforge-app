import { parseLimsTemporalField } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import { workTimeFromInput } from '@waypoint/scientific-objects';

export type TemporalFieldType = 'date' | 'datetime';
export type RegistryClockInput = { local: string; zone: string; fold: '' | 'earlier' | 'later' };

export function temporalFieldDraft(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function temporalFieldValue(type: TemporalFieldType, text: string): unknown {
  if (!text) return null;
  if (type === 'date') return text;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'timed')
      return value;
  } catch {}
  return text;
}

export function registryClockChoices(input: RegistryClockInput) {
  const specification = { kind: 'timed' as const, local: input.local, zone: input.zone };
  const earlier = workTimeFromInput({ ...specification, fold: 'earlier' });
  const later = workTimeFromInput({ ...specification, fold: 'later' });
  if (earlier.kind !== 'timed' || later.kind !== 'timed') throw new Error('Enter a local time.');
  return { earlier, later, repeated: earlier.instant !== later.instant };
}

export function temporalControlState(type: TemporalFieldType, text: string) {
  const empty: RegistryClockInput = {
    local: '',
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    fold: '',
  };
  const value = temporalFieldValue(type, text);
  const parsed = parseLimsTemporalField(type, value);
  if (parsed.kind === 'exact') {
    const point = parsed.value;
    if (point.kind === 'day') return { input: { ...empty, local: point.date }, raw: null };
    const input = { local: point.local, zone: point.zone, fold: '' } as RegistryClockInput;
    try {
      const choices = registryClockChoices(input);
      if (choices.repeated)
        input.fold = point.instant === choices.later.instant ? 'later' : 'earlier';
    } catch {}
    return { input, raw: null };
  }
  if (type === 'datetime' && text) {
    try {
      const data = JSON.parse(text);
      if (
        data.kind === 'datetime-input' &&
        typeof data.local === 'string' &&
        typeof data.zone === 'string' &&
        ['', 'earlier', 'later'].includes(data.fold)
      )
        return {
          input: { local: data.local, zone: data.zone, fold: data.fold } as RegistryClockInput,
          raw: null,
        };
    } catch {}
  }
  return { input: empty, raw: parsed.kind === 'unresolved' ? text : null };
}

export function encodeClockInput(input: RegistryClockInput): string {
  if (!input.local) return '';
  try {
    const value = workTimeFromInput({
      kind: 'timed',
      local: input.local,
      zone: input.zone,
      ...(input.fold ? { fold: input.fold } : {}),
    });
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ kind: 'datetime-input', ...input });
  }
}

export function temporalFieldDisplay(type: TemporalFieldType, value: unknown) {
  const parsed = parseLimsTemporalField(type, value);
  if (parsed.kind === 'missing') return '–';
  if (parsed.kind === 'unresolved') return temporalFieldDraft(value);
  const point = parsed.value;
  return point.kind === 'day' ? point.date : point.local.replace('T', ' ') + ' · ' + point.zone;
}
