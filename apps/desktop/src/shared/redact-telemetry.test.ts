// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { redactSensitive } from './redact-sensitive';
import { redactTelemetryText } from './redact-telemetry';

describe('redactTelemetryText ', () => {
  it('keeps everything redactSensitive removes removed', () => {
    expect(redactTelemetryText('login failed for alice@example.com')).toBe(
      'login failed for [redacted-email]'
    );
    expect(redactTelemetryText('api_key=xxxxxxxxxxxx')).toBe('api_key=[redacted]');
  });

  it('removes whole user file paths, including folder and file names with spaces', () => {
    expect(redactTelemetryText('failed to read /Users/alice/Lab Data/My Plasmid.gb now')).toBe(
      'failed to read /Users/[redacted-user]/[redacted-path] now'
    );
    expect(redactTelemetryText('open /home/bob/runs/a.fasta:12:3')).toBe(
      'open /home/[redacted-user]/[redacted-path]:12:3'
    );
    expect(redactTelemetryText('C:\\Users\\user\\Desktop\\KRAS.dna missing')).toBe(
      'C:\\Users\\[redacted-user]\\[redacted-path] missing'
    );
    expect(redactTelemetryText('copy from /Volumes/LabShare/2026/run7.ab1')).toBe(
      'copy from /Volumes/[redacted-path]'
    );
    expect(redactTelemetryText('D:\\Projects\\secret\\x.gb')).toBe('D:\\[redacted-path]');
    expect(redactTelemetryText('\\\\fileserver\\lab\\plasmids')).toBe('\\\\[redacted-path]');
    expect(redactTelemetryText('file:///private/var/folders/xy/T/import/a.gb')).toBe(
      'file:///private/var/folders/[redacted-path]'
    );
  });

  it('removes usernames that contain spaces or apostrophes, and everything after them', () => {
    expect(redactTelemetryText('failed to read /Users/Mary Ann/Lab/KRAS.gb now')).toBe(
      'failed to read /Users/[redacted-user]/[redacted-path] now'
    );
    expect(redactTelemetryText("open /home/o'brien/runs/a.fasta")).toBe(
      'open /home/[redacted-user]/[redacted-path]'
    );
    expect(redactTelemetryText('C:\\Users\\Mary Ann\\Documents\\KRAS.dna missing')).toBe(
      'C:\\Users\\[redacted-user]\\[redacted-path] missing'
    );
    expect(redactTelemetryText('home is /Users/alice today')).toBe(
      'home is /Users/[redacted-user] today'
    );
  });

  it('redacts secrets that sit next to or inside a path', () => {
    expect(redactTelemetryText('read /Users/alice/x token=xxxxxxxxxxxx')).toBe(
      'read /Users/[redacted-user]/[redacted-path] token=[redacted]'
    );
    const stripe = 'sk_live_' + '0'.repeat(20);
    expect(redactTelemetryText(`/tmp/${stripe} failed`)).not.toContain('0000');
    expect(redactTelemetryText(`login alice@example.com at /Users/alice/a.gb`)).toBe(
      'login [redacted-email] at /Users/[redacted-user]/[redacted-path]'
    );
  });

  it('keeps redacting a path after a masked secret inside one of its segments', () => {
    const stripe = 'sk_live_' + '0'.repeat(20);
    expect(redactTelemetryText(`/tmp/${stripe}/Secret.gb`)).toBe('/tmp/[redacted-path]');
    expect(redactTelemetryText('/Volumes/alice@example.com/Lab/plan.gb moved')).toBe(
      '/Volumes/[redacted-path] moved'
    );
    expect(redactTelemetryText('/Users/alice/token=xxxxxxxxxxxx/Notes.txt')).toBe(
      '/Users/[redacted-user]/[redacted-path]'
    );
    expect(redactTelemetryText('\\\\alice@example.com\\share\\Plan.gb')).not.toContain('Plan');
  });

  it('keeps the app bundle part of a stack frame', () => {
    expect(
      redactTelemetryText(
        'at C:\\Users\\user\\AppData\\Local\\Programs\\DNAForge\\resources\\app.asar\\out\\main\\index.js:40:9'
      )
    ).toBe('at C:\\Users\\[redacted-user]\\[redacted-path]\\app.asar\\out\\main\\index.js:40:9');
    expect(
      redactTelemetryText('at /Applications/DNAForge.app/Contents/Resources/app.asar/out/a.js:1')
    ).toBe('at /Applications/DNAForge.app/Contents/Resources/app.asar/out/a.js:1');
    expect(redactTelemetryText('at C:\\Program Files\\DNAForge\\resources\\app.asar\\b.js')).toBe(
      'at C:\\Program Files\\DNAForge\\resources\\app.asar\\b.js'
    );
  });

  it('removes nucleotide and protein runs but not short words', () => {
    expect(redactTelemetryText('parse ACGTACGTACGTACGTACGTAC failed')).toBe(
      'parse [redacted-sequence] failed'
    );
    expect(redactTelemetryText('seq acgtnnnnacgtrykmswbd ok')).toBe('seq [redacted-sequence] ok');
    expect(redactTelemetryText('MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ')).toBe('[redacted-sequence]');
    expect(redactTelemetryText('rendered 1200 bases of ACGTACGT')).toBe(
      'rendered 1200 bases of ACGTACGT'
    );
  });

  it('removes quoted text but keeps JSON keys and apostrophes', () => {
    expect(redactTelemetryText('Could not open "KRAS promoter.gb"')).toBe(
      'Could not open "[redacted-text]"'
    );
    expect(redactTelemetryText("Can't apply 'design my primers for BRCA1'")).toBe(
      "Can't apply '[redacted-text]'"
    );
    expect(redactTelemetryText('prompt `explain this plasmid` failed')).toBe(
      'prompt `[redacted-text]` failed'
    );
    expect(redactTelemetryText('{"feature":"KRAS","code":42}')).toBe(
      '{"feature":"[redacted-text]","code":42}'
    );
    expect(redactTelemetryText('title \u201cMy notebook\u201d')).toBe(
      'title \u201c[redacted-text]\u201d'
    );
  });

  it('leaves the user-facing redactSensitive behavior unchanged', () => {
    expect(redactSensitive('opened /Users/alice/Lab/a.gb with "KRAS"')).toBe(
      'opened /Users/[redacted-user]/Lab/a.gb with "KRAS"'
    );
  });
});
