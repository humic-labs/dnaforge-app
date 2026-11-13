import { describe, expect, it } from 'vitest';

import {
  decodeGenomeSessionFile,
  decodeIgvSession,
  decodeUcscCustomTracks,
  detectGenomeSessionFileKind,
  parseLocus,
} from './genome-session-file';

const IGV_SESSION = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Session genome="sacCer3" hasGeneTrack="true" hasSequenceTrack="true" locus="chrIV:3,501-4,000" version="8">
    <Resources>
        <Resource path="reads.cram" type="cram" index="reads.cram.crai" name="Lab reads"/>
        <Resource path="https://variants.example.org/s288c/calls.vcf.gz" index="https://variants.example.org/s288c/calls.vcf.gz.tbi"/>
        <Resource path="/data/signal/coverage.bw" type="bw"/>
        <Resource path="gs://lab-bucket/runs/calls.vcf.gz"/>
        <Resource path="s3://lab-bucket/runs/reads.bam" index="s3://lab-bucket/runs/reads.bam.bai"/>
        <Resource path="https://data.example.org/private.bw?token=abc"/>
        <Resource path="../escape/other.bw"/>
        <Resource path="ftp://ftp.example.org/x.bw"/>
        <Resource path="reads.cram"/>
        <Resource name="empty"/>
    </Resources>
    <Panel height="400" name="DataPanel" width="1200">
        <Track attributeKey="Lab reads Coverage" clazz="org.broad.igv.sam.CoverageTrack" id="reads.cram_coverage" name="Lab reads Coverage" visible="true"/>
        <Track attributeKey="Lab reads" clazz="org.broad.igv.sam.AlignmentTrack" id="reads.cram" name="Lab reads &amp; friends" visible="true"/>
    </Panel>
</Session>
`;

const UCSC_TRACKS = `# custom tracks exported from the browser
browser position chr21:33,031,597-33,041,570
browser hide all
track type=bigWig name="GC signal" description="GC percent" bigDataUrl=https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw visibility=full color=0,0,255
track type=bam name='Lab reads' bigDataUrl=https://reads.example.org/s288c/reads.cram bigDataIndex=https://reads.example.org/s288c/reads.cram.crai
track type=vcfTabix name=Calls bigDataUrl=https://variants.example.org/s288c/calls.vcf.gz
track type=bigGenePred name=Genes bigDataUrl=https://example.org/genes.bb
track name="Inline peaks" description="pasted bed"
chr21\t100\t200\tpeak1
chr21\t300\t400\tpeak2
track type=bigWig name="Again" bigDataUrl=https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw
`;

describe('genome session files', () => {
  it('detects IGV sessions by their Session element and custom tracks by their first line', () => {
    expect(detectGenomeSessionFileKind('lab.xml', IGV_SESSION.slice(0, 200))).toBe('igv-session');
    expect(detectGenomeSessionFileKind('lab.session', IGV_SESSION.slice(0, 200))).toBe(
      'igv-session'
    );
    expect(detectGenomeSessionFileKind('lab.xml', '<?xml version="1.0"?><Other/>')).toBeNull();
    expect(detectGenomeSessionFileKind('tracks.txt', UCSC_TRACKS)).toBe('ucsc-custom-tracks');
    expect(detectGenomeSessionFileKind('tracks.txt', '#comment\ntrack type=bigWig x=1\n')).toBe(
      'ucsc-custom-tracks'
    );
    expect(detectGenomeSessionFileKind('notes.txt', 'hello world')).toBeNull();
    expect(detectGenomeSessionFileKind('peaks.bed', 'chr1\t1\t2\n')).toBeNull();
  });

  it('reads an IGV session into resources, keeping only what names loadable data', () => {
    const session = decodeIgvSession(IGV_SESSION);
    expect(session.kind).toBe('igv-session');
    expect(session.genome).toBe('sacCer3');
    expect(session.locus).toEqual({ chrom: 'chrIV', start0: 3500, end0: 4000 });
    expect(session.resources).toEqual([
      {
        source: { kind: 'path', path: 'reads.cram', relative: true },
        index: { kind: 'path', path: 'reads.cram.crai', relative: true },
        label: 'Lab reads',
        formatId: 'cram',
      },
      {
        source: { kind: 'url', url: 'https://variants.example.org/s288c/calls.vcf.gz' },
        index: { kind: 'url', url: 'https://variants.example.org/s288c/calls.vcf.gz.tbi' },
      },
      {
        source: { kind: 'path', path: '/data/signal/coverage.bw', relative: false },
        formatId: 'bigwig',
      },
      { source: { kind: 'gcs', bucket: 'lab-bucket', object: 'runs/calls.vcf.gz' } },
      {
        source: { kind: 's3', bucket: 'lab-bucket', key: 'runs/reads.bam' },
        index: { kind: 's3', bucket: 'lab-bucket', key: 'runs/reads.bam.bai' },
      },
      { source: { kind: 'path', path: '../escape/other.bw', relative: true } },
    ]);
    expect(session.skipped).toEqual([
      {
        subject: 'https://data.example.org/private.bw?token=abc',
        reason: 'carries credential parameters in its URL',
      },
      { subject: 'ftp://ftp.example.org/x.bw', reason: 'uses unsupported scheme ftp://' },
      { subject: 'Resource', reason: 'names no path' },
    ]);
  });

  it('refuses text that is not an IGV session and bounds the file', () => {
    expect(() => decodeIgvSession('<Genome/>')).toThrow('has no <Session> element');
    expect(() => decodeGenomeSessionFile('igv-session', 'x'.repeat(4 * 1024 * 1024 + 1))).toThrow(
      'larger than 4 MiB'
    );
    expect(decodeIgvSession('<Session genome="hg38" locus="All"/>')).toEqual({
      kind: 'igv-session',
      genome: 'hg38',
      resources: [],
      skipped: [],
    });
  });

  it('reads UCSC custom tracks by their bigDataUrl and reports inline or unsupported ones', () => {
    const tracks = decodeUcscCustomTracks(UCSC_TRACKS);
    expect(tracks.kind).toBe('ucsc-custom-tracks');
    expect(tracks.locus).toEqual({ chrom: 'chr21', start0: 33_031_596, end0: 33_041_570 });
    expect(tracks.genome).toBeUndefined();
    expect(tracks.resources).toEqual([
      {
        source: {
          kind: 'url',
          url: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw',
        },
        label: 'GC signal',
        formatId: 'bigwig',
      },
      {
        source: { kind: 'url', url: 'https://reads.example.org/s288c/reads.cram' },
        index: { kind: 'url', url: 'https://reads.example.org/s288c/reads.cram.crai' },
        label: 'Lab reads',
        formatId: 'bam',
      },
      {
        source: { kind: 'url', url: 'https://variants.example.org/s288c/calls.vcf.gz' },
        label: 'Calls',
        formatId: 'vcf',
      },
    ]);
    expect(tracks.skipped).toEqual([
      { subject: 'Genes', reason: 'has unsupported track type biggenepred' },
      { subject: 'Inline peaks', reason: 'carries inline data lines' },
    ]);
    expect(decodeUcscCustomTracks('browser db sacCer3\nbrowser position chrIV\n')).toEqual({
      kind: 'ucsc-custom-tracks',
      genome: 'sacCer3',
      locus: { chrom: 'chrIV' },
      resources: [],
      skipped: [],
    });
    expect(() => decodeUcscCustomTracks('just text\n')).toThrow('no browser or track lines');
  });

  it('parses loci the way browsers write them', () => {
    expect(parseLocus('chr1:1,000-2,000')).toEqual({ chrom: 'chr1', start0: 999, end0: 2000 });
    expect(parseLocus('chrM')).toEqual({ chrom: 'chrM' });
    expect(parseLocus('All')).toBeUndefined();
    expect(parseLocus('chr1:5-2')).toEqual({ chrom: 'chr1' });
    expect(parseLocus('chr1:0-2')).toEqual({ chrom: 'chr1' });
    expect(parseLocus(undefined)).toBeUndefined();
    expect(parseLocus('not a locus at all')).toBeUndefined();
  });
});
