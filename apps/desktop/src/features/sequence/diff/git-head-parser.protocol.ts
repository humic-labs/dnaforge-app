import type { Annotation } from '@waypoint/sequence-utils';

export interface GitHeadParseResult {
  sequence: string;
  annotations: Annotation[];
}

export type GitHeadParseResponse =
  | { type: 'result'; result: GitHeadParseResult }
  | { type: 'error'; message: string };
