import { platform } from '../../../platform';

export async function readSequenceFileGuarded(path: string): Promise<string> {
  return platform().fs.readTextFile(path);
}
