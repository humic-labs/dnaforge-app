import {
  calendarDay,
  parseWorkTime,
  workTimeFromInput,
  type WorkTime,
} from '@waypoint/scientific-objects';
import type { LimsFieldDefinition } from './lims';

export type LimsTemporalValue =
  | { kind: 'missing' }
  | { kind: 'unresolved'; raw: unknown }
  | { kind: 'exact'; value: WorkTime };

export function assertLimsAgendaDefinition(field: LimsFieldDefinition): void {
  if (field.agenda === undefined) return;
  if (
    !['date', 'datetime'].includes(field.type) ||
    !field.agenda ||
    !['milestone', 'deadline', 'observation'].includes(field.agenda.role)
  )
    throw new Error(`${field.label} requires a supported date role.`);
  const zone = field.agenda.zone;
  if (field.type === 'date' && (!zone || !zone.trim()))
    throw new Error(`${field.label} needs a named time zone to appear in the agenda.`);
  if (zone !== undefined) {
    if (typeof zone !== 'string' || !zone.trim() || /^[+-]/u.test(zone))
      throw new Error(`${field.label} needs a named time zone.`);
    new Intl.DateTimeFormat('en', { timeZone: zone });
  }
}

export function parseLimsTemporalField(type: string, value: unknown): LimsTemporalValue {
  if (value === undefined || value === null || value === '') return { kind: 'missing' };
  try {
    if (type === 'date' && typeof value === 'string') {
      calendarDay(value);
      return { kind: 'exact', value: { kind: 'day', date: value, zone: 'UTC' } };
    }
    if (type === 'datetime') {
      const parsed = parseWorkTime(value);
      if (parsed.kind === 'timed') return { kind: 'exact', value: parsed };
    }
  } catch {}
  return { kind: 'unresolved', raw: value };
}

export function assertLimsTemporalEdits(
  fields: Record<string, unknown>,
  definitions: readonly LimsFieldDefinition[],
  previous?: Record<string, unknown>
): void {
  for (const field of definitions) {
    if (!['date', 'datetime'].includes(field.type) || !Object.hasOwn(fields, field.key)) continue;
    const value = fields[field.key];
    if (previous && JSON.stringify(previous[field.key]) === JSON.stringify(value)) continue;
    const parsed = parseLimsTemporalField(field.type, value);
    if (parsed.kind === 'missing') continue;
    if (parsed.kind !== 'exact')
      throw new Error(
        `${field.label} requires ${field.type === 'date' ? 'a real date in YYYY-MM-DD format' : 'a date, time and named time zone'}.`
      );
    if (parsed.value.kind === 'day') {
      for (const [bound, direction] of [
        [field.minDate, -1],
        [field.maxDate, 1],
      ] as const) {
        if (bound === undefined) continue;
        calendarDay(bound);
        if (direction === -1 ? parsed.value.date < bound : parsed.value.date > bound)
          throw new Error(`${field.label} is outside its permitted dates.`);
      }
    } else {
      const saved = parsed.value;
      const matches = (['earlier', 'later'] as const).some((fold) => {
        try {
          const resolved = workTimeFromInput({
            kind: 'timed',
            local: saved.local,
            zone: saved.zone,
            fold,
          });
          return resolved.kind === 'timed' && resolved.instant === saved.instant;
        } catch {
          return false;
        }
      });
      if (!matches) throw new Error(`${field.label} does not match its local time and named zone.`);
    }
  }
}
