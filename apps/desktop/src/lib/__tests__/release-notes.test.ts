// @vitest-environment node

import { describe, expect, it } from 'vitest';
import desktopPackage from '../../../package.json';
import * as releaseNotes from '../release-notes';
import { getReleaseNote, RELEASE_NOTES, VERSION_HISTORY } from '../release-notes';

describe('release notes registry', () => {
  it('makes every registry note reachable without a second version list', () => {
    expect([...VERSION_HISTORY].sort()).toEqual(Object.keys(RELEASE_NOTES).sort());
  });
  it('has notes for the installed desktop package version', () => {
    expect(getReleaseNote(desktopPackage.version)).not.toBeNull();
  });

  it('sorts stable versions numerically across digit and major/minor boundaries', () => {
    expect(
      ['0.9.9', '0.10.0', '0.9.10', '1.0.0'].sort(releaseNotes.compareReleaseVersionsNewestFirst)
    ).toEqual(['1.0.0', '0.10.0', '0.9.10', '0.9.9']);
  });
  it('lists versions newest first', () => {
    const parts = (version: string) => version.split('.').map(Number);
    for (let index = 1; index < VERSION_HISTORY.length; index += 1) {
      const [a, b] = [parts(VERSION_HISTORY[index - 1]), parts(VERSION_HISTORY[index])];
      const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(
        newer,
        `${VERSION_HISTORY[index - 1]} before ${VERSION_HISTORY[index]}`
      ).toBeGreaterThan(0);
    }
  });

  it('does not list versions without release note content', () => {
    for (const version of VERSION_HISTORY) {
      expect(RELEASE_NOTES[version]).toBeTruthy();
    }
  });

  it('uses Peter-approved cumulative public copy for v0.7.6 ', () => {
    expect(RELEASE_NOTES['0.7.6']).toEqual({
      date: '2026-07-27',
      highlights: [
        'Search complete reference genomes for DNA sequences, annotations, and amino-acid matches, then open results directly.',
        'Load and compare multiple local BAM alignment files on the same reference. DNAForge prepares missing indexes automatically and keeps tracks synchronized while you pan and zoom.',
        'AI replies now render headings, lists, links, code blocks, and contained tables. Attached references remain visible while resolving and clearly report unavailable results.',
        'Import primers, strains, DNA sequences, and protein sequences through guided workflows, including protein alignment and back-translation with built-in organism codon tables.',
        'The project file tree remains available across views and restores expanded folders and sidebar layout after relaunch.',
        'Finalized assemblies and imported plasmids now become self-contained plasmid packages that keep their GenBank product, build history, and generated primers together as one project item.',
      ],
      fixed: [
        'Closing complex design or genome tabs is now consistently fast and no longer briefly blanks or rebuilds neighboring canvases.',
        'Older DNAForge versions now recognize a database written by a newer release and ask you to update instead of incorrectly treating it as corrupted.',
        'Development builds use isolated database profiles and cannot silently migrate the database used by an installed release.',
        'Genome annotations and read-alignment tracks remain stable across search navigation, theme changes, panning, zooming, and hidden-track reveals.',
      ],
      underTheHood: [
        'Historical desktop migrations are now exercised against captured real databases, including upgrades, recovery, and repeated-start safety.',
        'Hosted reference assets are prepared, pinned, and verified before publication.',
        'Improved diagnostics and reliability checks across AI chat and desktop workflows.',
      ],
    });
  });

  it('keeps every candidate after 0.7.2 free of post-hoc telemetry mechanics', () => {
    const lastPublicVersionIndex = VERSION_HISTORY.indexOf('0.7.2');
    expect(lastPublicVersionIndex).toBeGreaterThan(0);

    const candidateVersions = VERSION_HISTORY.slice(0, lastPublicVersionIndex);
    const recentCandidateText = JSON.stringify(
      Object.fromEntries(candidateVersions.map((version) => [version, RELEASE_NOTES[version]]))
    );

    expect(recentCandidateText).not.toMatch(/\b(?:PostHog|session replay|autocapture)\b/i);
    expect(recentCandidateText).not.toMatch(
      /ordered record of clicks|keyboard input|clipboard actions|full-fidelity journey/i
    );
    expect(RELEASE_NOTES['0.7.4'].underTheHood).toEqual([
      'Improved diagnostics for AI chat quality and reliability.',
    ]);
  });

  it('does not export unused getReleaseHighlights', () => {
    expect(releaseNotes).not.toHaveProperty('getReleaseHighlights');
    expect(typeof releaseNotes.getReleaseNote).toBe('function');
  });
});
