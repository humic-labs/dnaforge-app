import { BrandWordmarkText } from './BrandWordmark';

export const MAC_TEAM_ID_CUTOVER_DOWNLOAD_URL =
  'https://www.dnaforge.com/download?source=mac-team-id-cutover';

export function shouldShowMacTeamIdCutoverBlocker(input: {
  cutoverEnabled: boolean;
  navigatorPlatform: string;
}): boolean {
  return input.cutoverEnabled && input.navigatorPlatform.startsWith('Mac');
}

export function MacTeamIdCutoverBlocker() {
  return (
    <main
      data-testid="mac-team-id-cutover-blocker"
      className="flex h-screen min-h-[560px] items-center justify-center overflow-auto bg-bg px-6 py-20 text-fg"
    >
      <section className="w-full max-w-xl rounded-2xl border border-border bg-bg-subtle p-8 text-center shadow-2xl shadow-black/20 sm:p-12">
        <div className="text-xl tracking-tight" aria-label="DNAForge">
          <BrandWordmarkText />
        </div>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight text-fg">
          Reinstall DNAForge to continue
        </h1>
        <p className="mt-5 text-base leading-7 text-fg-muted">
          Apple has approved our official Developer Account, so you need to reinstall DNAForge from
          the official link below.
        </p>
        <p className="mt-4 text-sm leading-6 text-fg-muted">
          Your local projects will stay on this Mac.
        </p>
        <a
          href={MAC_TEAM_ID_CUTOVER_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Download the new macOS installer
        </a>
      </section>
    </main>
  );
}
