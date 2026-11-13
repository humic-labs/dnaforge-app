
use crate::fasta_input::fasta_header_id;
use crate::output::{write_sequence_bundle, SequenceBundleOutcome};
use anyhow::{anyhow, Context, Result};
use flate2::read::MultiGzDecoder;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

pub const ASSEMBLY_CONTIG_MAP_CONTRACT: &str = "dna-indexer-ingest-gff3-assembly.v1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AssemblyContigMap {
    contract: String,
    pub(crate) contigs: Vec<AssemblyContigMapping>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssemblyContigMapping {
    pub(crate) source_seq_id: String,
    pub(crate) name: String,
    pub(crate) expected_length_bp: u64,
    pub(crate) circular: Option<bool>,
}

#[derive(Debug)]
pub struct AssemblyFastaIngestOutcome {
    pub bundles: Vec<AssemblyFastaBundleOutcome>,
    pub total_length: u64,
}

#[derive(Debug)]
pub struct AssemblyFastaBundleOutcome {
    pub source_seq_id: String,
    pub name: String,
    pub length: u64,
    pub paths: SequenceBundleOutcome,
}

pub fn ingest_assembly_fasta(
    fasta_path: &Path,
    contig_map_path: &Path,
    out_dir: &Path,
) -> Result<AssemblyFastaIngestOutcome> {
    let plan = read_contig_map(contig_map_path)?;
    ensure_sequence_output_targets_absent(out_dir, &plan.contigs)?;
    fs::create_dir_all(out_dir)
        .with_context(|| format!("could not create output directory {}", out_dir.display()))?;

    let result = (|| {
        let mut outcomes = BTreeMap::new();
        for_each_assembly_fasta_record(fasta_path, &plan.contigs, |mapping, sequence| {
            let actual_length = sequence.len() as u64;
            if actual_length != mapping.expected_length_bp {
                return Err(anyhow!(
                    "{} FASTA length {actual_length} does not match expectedLengthBp {}",
                    mapping.source_seq_id,
                    mapping.expected_length_bp
                ));
            }
            let paths = write_sequence_bundle(&sequence, out_dir, &mapping.name)
                .with_context(|| format!("while writing sequence for {}", mapping.source_seq_id))?;
            outcomes.insert(
                mapping.source_seq_id.clone(),
                AssemblyFastaBundleOutcome {
                    source_seq_id: mapping.source_seq_id.clone(),
                    name: mapping.name.clone(),
                    length: actual_length,
                    paths,
                },
            );
            Ok(())
        })?;

        let mut bundles = Vec::with_capacity(plan.contigs.len());
        for contig in &plan.contigs {
            bundles.push(
                outcomes
                    .remove(contig.source_seq_id.as_str())
                    .expect("every manifest contig produced one sequence bundle"),
            );
        }
        let total_length = bundles.iter().map(|bundle| bundle.length).sum();
        Ok(AssemblyFastaIngestOutcome {
            bundles,
            total_length,
        })
    })();

    if result.is_err() {
        cleanup_sequence_output_targets(out_dir, &plan.contigs);
    }
    result
}

pub(crate) fn read_contig_map(path: &Path) -> Result<AssemblyContigMap> {
    let bytes =
        fs::read(path).with_context(|| format!("could not read contig map {}", path.display()))?;
    let plan: AssemblyContigMap = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid contig map {}", path.display()))?;
    if plan.contract != ASSEMBLY_CONTIG_MAP_CONTRACT {
        return Err(anyhow!(
            "{}: contract must be {ASSEMBLY_CONTIG_MAP_CONTRACT}",
            path.display()
        ));
    }
    if plan.contigs.is_empty() {
        return Err(anyhow!("{}: contigs must not be empty", path.display()));
    }
    let mut source_ids = HashSet::new();
    let mut names = HashSet::new();
    for contig in &plan.contigs {
        if contig.source_seq_id.is_empty() || contig.source_seq_id.chars().any(char::is_whitespace)
        {
            return Err(anyhow!("sourceSeqId must be a non-empty FASTA identifier"));
        }
        if !safe_output_name(&contig.name) {
            return Err(anyhow!("unsafe canonical contig name {}", contig.name));
        }
        if !source_ids.insert(contig.source_seq_id.as_str()) {
            return Err(anyhow!(
                "duplicate sourceSeqId {} in contig map",
                contig.source_seq_id
            ));
        }
        if !names.insert(contig.name.as_str()) {
            return Err(anyhow!(
                "duplicate canonical name {} in contig map",
                contig.name
            ));
        }
        if contig.expected_length_bp == 0 {
            return Err(anyhow!(
                "{} expectedLengthBp must be positive",
                contig.source_seq_id
            ));
        }
    }
    Ok(plan)
}

pub(crate) fn for_each_assembly_fasta_record<F>(
    fasta_path: &Path,
    contigs: &[AssemblyContigMapping],
    mut on_record: F,
) -> Result<usize>
where
    F: FnMut(&AssemblyContigMapping, Vec<u8>) -> Result<()>,
{
    let by_source: HashMap<&str, &AssemblyContigMapping> = contigs
        .iter()
        .map(|contig| (contig.source_seq_id.as_str(), contig))
        .collect();
    let mut reader = BufReader::new(open_maybe_gzip(fasta_path)?);
    let mut line = String::new();
    let mut current_id: Option<String> = None;
    let mut current_sequence = Vec::new();
    let mut seen = HashSet::new();
    let mut submitted = 0usize;

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let raw = line.trim_end_matches(['\r', '\n']);
        if raw.starts_with('>') {
            if let Some(source_id) = current_id.take() {
                let mapping = by_source
                    .get(source_id.as_str())
                    .expect("current FASTA id was validated on admission");
                on_record(mapping, std::mem::take(&mut current_sequence))?;
                submitted += 1;
            }
            let source_id = fasta_header_id(raw)?;
            if !by_source.contains_key(source_id.as_str()) {
                return Err(anyhow!(
                    "{}: FASTA sequence {source_id} is absent from the contig map",
                    fasta_path.display()
                ));
            }
            if !seen.insert(source_id.clone()) {
                return Err(anyhow!(
                    "{}: duplicate FASTA sequence {source_id}",
                    fasta_path.display()
                ));
            }
            current_id = Some(source_id);
            continue;
        }
        if current_id.is_none() && !raw.trim().is_empty() {
            return Err(anyhow!(
                "{}: FASTA sequence appears before its header",
                fasta_path.display()
            ));
        }
        for byte in raw.bytes() {
            if !byte.is_ascii_whitespace() {
                current_sequence.push(byte.to_ascii_lowercase());
            }
        }
    }
    if let Some(source_id) = current_id.take() {
        let mapping = by_source
            .get(source_id.as_str())
            .expect("current FASTA id was validated on admission");
        on_record(mapping, current_sequence)?;
        submitted += 1;
    }
    for contig in contigs {
        if !seen.contains(&contig.source_seq_id) {
            return Err(anyhow!(
                "{}: contig {} is missing from FASTA",
                fasta_path.display(),
                contig.source_seq_id
            ));
        }
    }
    Ok(submitted)
}

pub(crate) fn open_maybe_gzip(path: &Path) -> Result<Box<dyn Read>> {
    let file = File::open(path).with_context(|| format!("could not open {}", path.display()))?;
    let mut buffered = BufReader::new(file);
    let prefix = buffered.fill_buf()?;
    if prefix.len() >= 2 && prefix[0] == 0x1f && prefix[1] == 0x8b {
        Ok(Box::new(MultiGzDecoder::new(buffered)))
    } else {
        Ok(Box::new(buffered))
    }
}

fn safe_output_name(value: &str) -> bool {
    value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric() || (index > 0 && matches!(character, '.' | '_' | '-'))
        })
}

fn ensure_sequence_output_targets_absent(
    out_dir: &Path,
    contigs: &[AssemblyContigMapping],
) -> Result<()> {
    for contig in contigs {
        for path in sequence_output_paths(out_dir, &contig.name) {
            if path.exists() {
                return Err(anyhow!(
                    "assembly ingestion output already exists: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn cleanup_sequence_output_targets(out_dir: &Path, contigs: &[AssemblyContigMapping]) {
    for contig in contigs {
        for path in sequence_output_paths(out_dir, &contig.name) {
            let _ = fs::remove_file(path);
        }
    }
}

fn sequence_output_paths(out_dir: &Path, name: &str) -> [PathBuf; 6] {
    [
        out_dir.join(format!("{name}.fa.gz")),
        out_dir.join(format!("{name}.fa.gz.fai")),
        out_dir.join(format!("{name}.fa.gz.gzi")),
        out_dir.join(format!("{name}.fa.gz.tmp")),
        out_dir.join(format!("{name}.fa.gz.fai.tmp")),
        out_dir.join(format!("{name}.fa.gz.gzi.tmp")),
    ]
}
