import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

const generate = String.raw`
import hashlib, json, pathlib, sys, zipfile
import pysam

root = pathlib.Path(sys.argv[1])
accession = 'GCF_900000042.1'
contigs = [('NC_900001.1', 320000), ('NC_900002.1', 280000)]
fasta_path = f'ncbi_dataset/data/{accession}/{accession}_dense_genomic.fna'
gff_path = f'ncbi_dataset/data/{accession}/genomic.gff'
sequences = {name: ('ACGT' * ((length + 3) // 4))[:length] for name, length in contigs}
fasta = ''.join(f'>{name} synthetic chromosome, complete sequence\n' + '\n'.join(sequence[i:i+80] for i in range(0, len(sequence), 80)) + '\n' for name, sequence in sequences.items()).encode()
annotation_intervals = []
gff_rows = ['##gff-version 3']
for chrom_index, (chrom, length) in enumerate(contigs):
    gff_rows.append(f'##sequence-region {chrom} 1 {length}')
    gff_rows.append(f'{chrom}\tRefSeq\tregion\t1\t{length}\t.\t+\t.\tID={chrom}')
    for index, start in enumerate(range(20000, 245000, 5000)):
        end = start + 4500
        gene = f'gene-{chrom}-{index}'
        transcript = f'NM_9{chrom_index:03d}{index:04d}.1'
        strand = '+' if index % 2 else '-'
        gff_rows.append(f'{chrom}\tRefSeq\tgene\t{start+1}\t{end}\t.\t{strand}\t.\tID={gene};Name=DENSE{index};gene_biotype=protein_coding')
        gff_rows.append(f'{chrom}\tRefSeq\tmRNA\t{start+1}\t{end}\t.\t{strand}\t.\tID=rna-{gene};Parent={gene};Name={transcript};transcript_id={transcript}')
        for exon in range(3):
            exon_start = start + exon * 1500
            exon_end = exon_start + 1000
            gff_rows.append(f'{chrom}\tRefSeq\texon\t{exon_start+1}\t{exon_end}\t.\t{strand}\t.\tID=exon-{gene}-{exon};Parent=rna-{gene}')
            gff_rows.append(f'{chrom}\tRefSeq\tCDS\t{exon_start+101}\t{exon_end-102}\t.\t{strand}\t0\tID=cds-{gene};Parent=rna-{gene};protein_id=NP_9{chrom_index:03d}{index:04d}.1')
        if chrom == contigs[0][0]:
            annotation_intervals.append({'id': transcript, 'startBp': start, 'endBp': end})
gff = ('\n'.join(gff_rows) + '\n').encode()
zip_path = root / 'dense-reference.zip'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(fasta_path, fasta)
    archive.writestr(gff_path, gff)
    archive.writestr('ncbi_dataset/data/assembly_data_report.jsonl', json.dumps({'accession': accession, 'organism': {'organismName': 'Synthetic dense alignment fixture'}, 'assemblyInfo': {'assemblyName': 'dense-alignment-performance'}}) + '\n')
    archive.writestr('ncbi_dataset/data/dataset_catalog.json', json.dumps({'assemblies': [{'accession': accession, 'files': [{'fileType': 'GENOMIC_NUCLEOTIDE_FASTA', 'filePath': fasta_path}, {'fileType': 'GENOME_GFF', 'filePath': gff_path}]}]}))
    archive.writestr('md5sum.txt', hashlib.md5(fasta).hexdigest() + '  ./' + fasta_path + '\n' + hashlib.md5(gff).hexdigest() + '  ./' + gff_path + '\n')
bam_path = root / 'dense-80x.bam'
header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': name, 'LN': length} for name, length in contigs]}
with pysam.AlignmentFile(str(bam_path), 'wb', header=header) as bam:
    for index in range(120000):
        start = 20000 + index * 150 // 80
        read = pysam.AlignedSegment()
        read.query_name = f'dense-read-{index:06d}'
        read.query_sequence = sequences[contigs[0][0]][start:start+150]
        read.flag = 16 if index % 2 else 0
        read.reference_id = 0
        read.reference_start = start
        read.mapping_quality = 60
        read.cigar = [(0, 150)]
        read.query_qualities = pysam.qualitystring_to_array('I' * 150)
        bam.write(read)
pysam.index(str(bam_path))
with pysam.AlignmentFile(str(bam_path), 'rb') as bam:
    observed_count = bam.count(contigs[0][0])
assert observed_count == 120000, observed_count
print(json.dumps({'fixtureId': 'synthetic-two-contig-80x-120000x150-annotations-v2', 'referencePath': str(zip_path), 'bamPath': str(bam_path), 'indexPath': str(bam_path) + '.bai', 'readLengthBp': 150, 'readCount': observed_count, 'nominalDepth': 80, 'locusStart': 60000, 'annotationExpectation': {'trackId': 'mRNA', 'coverageStartBp': 0, 'coverageEndBp': contigs[0][1], 'intervals': annotation_intervals}, 'source': {'assemblyLengthBp': sum(length for _, length in contigs), 'chromosomeCount': len(contigs), 'bamSizeBytes': bam_path.stat().st_size}, 'contigs': [{'name': name, 'length': length} for name, length in contigs]}))
`;

export async function createDensePileupFixture(directory) {
  assert.ok(path.isAbsolute(directory), 'The fixture directory must be absolute.');
  await mkdir(directory, { recursive: true });
  directory = await realpath(directory);
  const fixture = await runPython(generate, [directory]);
  const result = { ...fixture, workspaceRoot: directory, coldScope: 'fresh-view-prepared-source' };
  await writeFile(path.join(directory, 'fixture.json'), JSON.stringify(result, null, 2));
  return result;
}

function runPython(script, args) {
  const python = path.join(
    repository,
    'apps/api/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  );
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Pileup fixture Python failed (${code}): ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

const queryAnnotations = String.raw`
import json, math, pathlib, sys
import pysam
request = json.loads(sys.argv[1])
start = max(0, math.floor(request['locusStart'] - 44000))
end = math.ceil(request['locusStart'] + 176000)
intervals = []
sources = []
offset = 0
for chromosome in request['chromosomes']:
    length = chromosome['length']
    left, right = max(0, start - offset), min(length, end - offset)
    manifest = chromosome.get('manifest', {})
    if left < right:
        source = manifest.get('gffPath')
        index = manifest.get('tbiPath')
        if not source or not index:
            raise ValueError('The benchmark annotation interval has no indexed GFF source')
        source_stat = pathlib.Path(source).stat()
        sources.append({'path': source, 'sizeBytes': source_stat.st_size, 'mtimeNs': str(source_stat.st_mtime_ns), 'startBp': left + offset, 'endBp': right + offset})
        with pysam.TabixFile(source, index=index) as gff:
            for row in gff.fetch(chromosome['chrom'], left, right):
                columns = row.split('\t')
                if len(columns) != 9 or columns[2] != 'mRNA':
                    continue
                attributes = dict(part.split('=', 1) for part in columns[8].split(';') if '=' in part)
                intervals.append({'id': attributes.get('transcript_id', attributes.get('ID', 'mRNA')), 'startBp': offset + int(columns[3]) - 1, 'endBp': offset + int(columns[4])})
    offset += length
print(json.dumps({'trackId': 'mRNA', 'coverageStartBp': start, 'coverageEndBp': min(end, offset), 'intervals': intervals, 'sources': sources}))
`;

export async function readPileupAnnotationExpectation(chromosomes, locusStart) {
  assert.ok(
    Array.isArray(chromosomes) && chromosomes.length > 0,
    'Expected reference chromosomes.'
  );
  assert.ok(Number.isFinite(locusStart) && locusStart >= 0, 'Expected the benchmark locus.');
  return runPython(queryAnnotations, [JSON.stringify({ chromosomes, locusStart })]);
}
