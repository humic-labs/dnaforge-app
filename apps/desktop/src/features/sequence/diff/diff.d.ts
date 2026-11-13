declare module 'diff' {
  interface Change {
    count?: number;
    value: string;
    added?: boolean;
    removed?: boolean;
  }
  export function diffChars(oldStr: string, newStr: string): Change[];
}
