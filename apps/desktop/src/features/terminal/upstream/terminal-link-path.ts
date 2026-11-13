/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/
import { isAbsolutePathLike } from '../../../shared/path-boundary';

export function resolveTerminalLinkPath(
  link: string,
  cwd: string,
  userHome: string | undefined
): string | undefined {
  if (link.charAt(0) === '~') {
    if (!userHome) return undefined;
    return `${userHome.replace(/[\\/]+$/, '')}/${link.substring(1).replace(/^[\\/]+/, '')}`;
  }
  return isAbsolutePathLike(link) ? link : `${cwd.replace(/[\\/]$/, '')}/${link}`;
}
