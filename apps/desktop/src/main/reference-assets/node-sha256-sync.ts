import { createHash } from 'node:crypto';

import { installSha256HexImplementation } from '../../shared/sha256-sync';

installSha256HexImplementation((...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
});
