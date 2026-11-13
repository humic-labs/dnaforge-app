import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BOT = /\[bot\]@users\.noreply\.github\.com$/iu;

export function unsignedCommits(commits) {
  return commits.filter(({ email, signOffs }) => {
    if (BOT.test(email)) return false;
    return !signOffs.some((line) => {
      const address = /<([^>]+)>\s*$/u.exec(line)?.[1];
      return address !== undefined && address.toLowerCase() === email.toLowerCase();
    });
  });
}

export function readCommits(base, head, { cwd, env = process.env } = {}) {
  const git = (args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  return git(['rev-list', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
    .map((sha) => ({
      sha,
      email: git(['log', '-1', '--format=%ae', sha]).trim(),
      signOffs: git([
        'log',
        '-1',
        '--format=%(trailers:key=Signed-off-by,valueonly,unfold,separator=%x00)',
        sha,
      ])
        .split('\0')
        .map((line) => line.trim())
        .filter(Boolean),
    }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, head] = process.argv.slice(2);
  const missing = unsignedCommits(readCommits(base, head));
  if (missing.length > 0) {
    console.error(
      'These commits need a Signed-off-by line with their author email (git commit -s):'
    );
    for (const { sha, email } of missing) console.error(`  ${sha.slice(0, 12)}  ${email}`);
    console.error('The line means you agree to the Contributor License Agreement in CLA.md.');
    process.exitCode = 1;
  } else {
    console.log('Every commit agrees to the Contributor License Agreement.');
  }
}
