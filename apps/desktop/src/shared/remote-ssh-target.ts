export function isRemoteSshTarget(target: string): boolean {
  return (
    target.length > 0 && target.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._@%+:[\]-]*$/u.test(target)
  );
}
