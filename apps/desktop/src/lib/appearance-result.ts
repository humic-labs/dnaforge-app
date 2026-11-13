export type AppearancePhase =
  | 'idle'
  | 'loading'
  | 'applying'
  | 'saving'
  | 'saved'
  | 'unsaved'
  | 'apply_failed'
  | 'read_failed'
  | 'temporary';
export interface AppearanceResult {
  revision: number;
  phase: AppearancePhase;
}
