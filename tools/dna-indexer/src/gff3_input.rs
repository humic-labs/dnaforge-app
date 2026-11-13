
use crate::error::IndexerError;
use crate::fasta_input::fasta_header_id;
use crate::model::{Feature, Interval, ParsedRecord, Strand, Topology};
use crate::ORIGIN_SPANNING_ATTR;
use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

#[derive(Debug)]
pub struct ParsedGff3 {
    pub record: ParsedRecord,
    pub parent_ids: Vec<Option<String>>,
    pub source_ids: Vec<Option<String>>,
    pub source_phases: Vec<Vec<Option<u8>>>,
    pub source_strands: Vec<Vec<Strand>>,
    pub source_interval_qualifiers: Vec<Vec<Vec<(String, Option<String>)>>>,
    pub source_origin_spanning: Vec<bool>,
}

pub fn parse_gff3(gff3_path: &Path, fasta_path: Option<&Path>) -> Result<ParsedGff3> {
    parse_gff3_impl(gff3_path, fasta_path, None, false, None, None)
}

pub fn parse_gff3_for_sequence(gff3_path: &Path, expected_seqid: &str) -> Result<ParsedGff3> {
    parse_gff3_impl(gff3_path, None, Some(expected_seqid), true, None, None)
}

pub fn parse_gff3_for_sequence_with_manifest(
    gff3_path: &Path,
    expected_seqid: &str,
    expected_length: u64,
    expected_circular: Option<bool>,
) -> Result<ParsedGff3> {
    parse_gff3_impl(
        gff3_path,
        None,
        Some(expected_seqid),
        true,
        Some(expected_length),
        expected_circular,
    )
}

fn parse_gff3_impl(
    gff3_path: &Path,
    fasta_path: Option<&Path>,
    expected_seqid: Option<&str>,
    allow_empty_features: bool,
    expected_length: Option<u64>,
    expected_circular: Option<bool>,
) -> Result<ParsedGff3> {
    let file = File::open(gff3_path)
        .map_err(|e| IndexerError::GenbankParseFailed(format!("{}: {}", gff3_path.display(), e)))?;

    let reader: Box<dyn Read> = {
        let mut buffered = BufReader::new(file);
        let buf = buffered.fill_buf().unwrap_or(&[]);
        if buf.len() >= 2 && buf[0] == 0x1f && buf[1] == 0x8b {
            Box::new(flate2::read::MultiGzDecoder::new(buffered))
        } else {
            Box::new(buffered)
        }
    };

    let mut features_in_order: Vec<MultipartAccumulator> = Vec::new();
    let mut feature_index_by_id: HashMap<String, usize> = HashMap::new();
    let mut embedded_fasta: Vec<u8> = Vec::new();
    let mut embedded_fasta_id: Option<String> = None;
    let mut in_fasta_section = false;
    let mut seqid_seen: Option<String> = None;
    let (mut sequence_region_lengths, circular_sequence_ids, globally_circular) =
        discover_gff3_metadata(gff3_path)?;
    if let (Some(expected), Some(length)) = (expected_seqid, expected_length) {
        sequence_region_lengths
            .entry(expected.to_string())
            .or_insert(length);
    }
    let mut circular_sequence_ids = circular_sequence_ids;
    if expected_circular == Some(true) {
        if let Some(expected) = expected_seqid {
            circular_sequence_ids.insert(expected.to_string());
        }
    }
    let mut topology = if globally_circular {
        Topology::Circular
    } else {
        Topology::Linear
    };
    if expected_circular == Some(true) {
        topology = Topology::Circular;
    }
    let mut observed_sequence_lengths: HashMap<String, u64> = HashMap::new();

    for (lineno, line) in BufReader::new(reader).lines().enumerate() {
        let line = line.map_err(|e| anyhow!("read line {}: {}", lineno + 1, e))?;
        if line.is_empty() {
            continue;
        }

        if in_fasta_section {
            if line.starts_with('>') {
                let id = fasta_header_id(&line)?;
                if let Some(first) = &embedded_fasta_id {
                    return Err(anyhow!(
                        "{}: embedded FASTA contains multiple records ({first}, {id}); ingest-gff3 requires exactly one sequence",
                        gff3_path.display()
                    ));
                }
                embedded_fasta_id = Some(id);
                continue;
            }
            if embedded_fasta_id.is_none() {
                return Err(anyhow!(
                    "{}: embedded FASTA sequence appears before its header",
                    gff3_path.display()
                ));
            }
            embedded_fasta.extend_from_slice(line.as_bytes());
            continue;
        }

        if line == "##FASTA" {
            in_fasta_section = true;
            continue;
        }
        if let Some(value) = line.strip_prefix("##sequence-region ") {
            let mut fields = value.split_whitespace();
            let seqid = fields.next();
            let start = fields.next().and_then(|raw| raw.parse::<u64>().ok());
            let end = fields.next().and_then(|raw| raw.parse::<u64>().ok());
            if let (Some(seqid), Some(1), Some(end)) = (seqid, start, end) {
                sequence_region_lengths.insert(seqid.to_string(), end);
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("##dna-indexer-topology ") {
            topology = match value {
                "circular" => Topology::Circular,
                "linear" => Topology::Linear,
                _ => {
                    return Err(anyhow!(
                        "{}:{}: unsupported DNAForge topology {value}",
                        gff3_path.display(),
                        lineno + 1
                    ));
                }
            };
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        let mut row = match parse_row(&line) {
            Ok(row) => row,
            Err(error) => {
                let repaired = repair_reversed_circular_virtual_interval(
                    &line,
                    line.split('\t')
                        .next()
                        .filter(|seqid| circular_sequence_ids.contains(*seqid))
                        .map(|_| Topology::Circular)
                        .unwrap_or(topology),
                    line.split('\t').next().and_then(|seqid| {
                        sequence_region_lengths
                            .get(seqid)
                            .or(observed_sequence_lengths.get(seqid))
                    }),
                );
                match repaired {
                    Some(repaired) => parse_row(&repaired)
                        .map_err(|e| anyhow!("{}:{}: {}", gff3_path.display(), lineno + 1, e))?,
                    None => {
                        return Err(anyhow!("{}:{}: {}", gff3_path.display(), lineno + 1, error))
                    }
                }
            }
        };

        if let Some(expected) = expected_seqid {
            if row.seqid != expected {
                return Err(anyhow!(
                    "{}: expected GFF3 sequence ID {expected}, received {}",
                    gff3_path.display(),
                    row.seqid
                ));
            }
        }

        match &seqid_seen {
            None => seqid_seen = Some(row.seqid.clone()),
            Some(seen) if seen != &row.seqid => {
                return Err(anyhow!(
                    "{}: GFF3 contains multiple sequence IDs ({seen}, {}); ingest-gff3 requires exactly one sequence",
                    gff3_path.display(),
                    row.seqid
                ));
            }
            _ => {}
        }

        if row.feature_type == "region" || row.feature_type == "chromosome" {
            if row.start == 1 {
                observed_sequence_lengths.insert(row.seqid.clone(), row.end);
            }
            if circular_sequence_ids.contains(&row.seqid) {
                topology = Topology::Circular;
            }
            if row.attributes.get("Is_circular") == Some(&"true".to_string()) {
                topology = Topology::Circular;
            }
        }

        let row_id = row.attributes.get("ID").cloned();
        let row_parent = row.attributes.get("Parent").cloned();
        let row_origin_spanning = match row.attributes.get(ORIGIN_SPANNING_ATTR) {
            None => false,
            Some(value) if value == "true" => true,
            Some(value) => {
                return Err(anyhow!(
                    "{}:{}: {ORIGIN_SPANNING_ATTR} must be true, received {value}",
                    gff3_path.display(),
                    lineno + 1
                ));
            }
        };
        let row_qualifiers: Vec<(String, Option<String>)> = std::mem::take(&mut row.attributes)
            .into_iter()
            .filter(|(key, _)| key.as_str() != ORIGIN_SPANNING_ATTR)
            .map(|(key, value)| (key, Some(value)))
            .collect();

        if let Some(id) = &row_id {
            if let Some(existing_idx) = feature_index_by_id.get(id) {
                let existing = &mut features_in_order[*existing_idx];
                if existing.feature_type != row.feature_type || existing.parent_id != row_parent {
                    return Err(anyhow!(
                        "{}:{}: repeated GFF3 ID {id} changes type or Parent relationship",
                        gff3_path.display(),
                        lineno + 1
                    ));
                }
                if existing.origin_spanning != row_origin_spanning {
                    return Err(anyhow!(
                        "{}:{}: repeated GFF3 ID {id} has inconsistent {ORIGIN_SPANNING_ATTR} provenance",
                        gff3_path.display(),
                        lineno + 1
                    ));
                }
                if existing.strand != row.strand {
                    existing.strand = Strand::Unknown;
                }
                existing.intervals.push(Interval {
                    start: row.start,
                    end: row.end,
                });
                existing.phases.push(row.phase);
                existing.strands.push(row.strand);
                existing.interval_qualifiers.push(row_qualifiers);
                continue;
            }
        }

        let acc = MultipartAccumulator {
            feature_type: row.feature_type,
            strand: row.strand,
            intervals: vec![Interval {
                start: row.start,
                end: row.end,
            }],
            phases: vec![row.phase],
            strands: vec![row.strand],
            qualifiers: row_qualifiers.clone(),
            interval_qualifiers: vec![row_qualifiers],
            id: row_id.clone(),
            parent_id: row_parent,
            location_string: format!("{}..{}", row.start, row.end),
            origin_spanning: row_origin_spanning,
        };
        let idx = features_in_order.len();
        features_in_order.push(acc);
        if let Some(id) = row_id {
            feature_index_by_id.insert(id, idx);
        }
    }
    if features_in_order.is_empty() && !allow_empty_features {
        return Err(IndexerError::GenbankParseFailed(format!(
            "{}: GFF3 input contained no feature rows",
            gff3_path.display()
        ))
        .into());
    }

    let name = seqid_seen
        .clone()
        .or_else(|| expected_seqid.map(str::to_owned))
        .unwrap_or_else(|| "unnamed".to_string());

    let sequence = if let Some(fa) = fasta_path {
        let (fasta_id, sequence) = crate::fasta_input::read_single_fasta(fa)?;
        if fasta_id != name {
            return Err(anyhow!(
                "{}: FASTA sequence ID {fasta_id} does not match GFF3 sequence ID {name}",
                fa.display()
            ));
        }
        sequence
    } else if !embedded_fasta.is_empty() {
        if embedded_fasta_id.as_deref() != Some(name.as_str()) {
            return Err(anyhow!(
                "{}: embedded FASTA sequence ID {} does not match GFF3 sequence ID {name}",
                gff3_path.display(),
                embedded_fasta_id.as_deref().unwrap_or("<missing>")
            ));
        }
        embedded_fasta
            .iter()
            .map(|b| b.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };

    let max_end = features_in_order
        .iter()
        .flat_map(|f| f.intervals.iter())
        .map(|iv| iv.end)
        .max()
        .unwrap_or(0);
    let fasta_length = if fasta_path.is_some() || embedded_fasta_id.is_some() {
        Some(sequence.len() as u64)
    } else {
        None
    };
    let length = fasta_length.unwrap_or(max_end);

    let features: Vec<Feature> = features_in_order
        .iter()
        .map(|acc| Feature {
            feature_type: acc.feature_type.clone(),
            strand: acc.strand,
            intervals: acc.intervals.clone(),
            qualifiers: acc.qualifiers.clone(),
            location_string: acc.location_string.clone(),
        })
        .collect();
    let source_ids: Vec<Option<String>> =
        features_in_order.iter().map(|acc| acc.id.clone()).collect();
    let source_phases: Vec<Vec<Option<u8>>> = features_in_order
        .iter()
        .map(|acc| acc.phases.clone())
        .collect();
    let source_strands: Vec<Vec<Strand>> = features_in_order
        .iter()
        .map(|acc| acc.strands.clone())
        .collect();
    let source_interval_qualifiers = features_in_order
        .iter()
        .map(|acc| acc.interval_qualifiers.clone())
        .collect();
    let source_origin_spanning = features_in_order
        .iter()
        .map(|acc| acc.origin_spanning)
        .collect();

    let parent_ids: Vec<Option<String>> = features_in_order
        .iter()
        .map(|acc| acc.parent_id.clone())
        .collect();
    let declared_ids: std::collections::HashSet<&str> =
        source_ids.iter().filter_map(Option::as_deref).collect();
    for parent_id in parent_ids.iter().filter_map(Option::as_deref) {
        if !declared_ids.contains(parent_id) {
            return Err(anyhow!(
                "{}: Parent={parent_id} does not resolve to an ID in sequence {name}",
                gff3_path.display()
            ));
        }
    }

    let record = ParsedRecord {
        name,
        length,
        topology,
        features,
        sequence,
    };

    let mut parsed = ParsedGff3 {
        record,
        parent_ids,
        source_ids,
        source_phases,
        source_strands,
        source_interval_qualifiers,
        source_origin_spanning,
    };
    if let Some(fasta_length) = fasta_length {
        normalize_record_coordinates(&mut parsed, fasta_length, gff3_path)?;
    } else {
        for (feature, marked) in parsed
            .record
            .features
            .iter()
            .zip(&parsed.source_origin_spanning)
        {
            if *marked {
                validate_origin_spanning_marker(
                    feature,
                    parsed.record.topology,
                    parsed.record.length,
                    gff3_path,
                )?;
            }
        }
    }

    Ok(parsed)
}

fn fold_second_copy_circular_interval(
    interval: &mut Interval,
    sequence_length: u64,
    source_path: &Path,
) -> Result<()> {
    if interval.start <= sequence_length {
        return Ok(());
    }
    if sequence_length == 0 || interval.start > sequence_length.saturating_mul(2) {
        return Err(anyhow!(
            "{}: feature start {} exceeds FASTA sequence length {sequence_length}",
            source_path.display(),
            interval.start
        ));
    }
    if interval.end <= sequence_length {
        return Err(anyhow!(
            "{}: feature start {} exceeds FASTA sequence length {sequence_length}",
            source_path.display(),
            interval.start
        ));
    }
    interval.start -= sequence_length;
    interval.end -= sequence_length;
    Ok(())
}

pub fn normalize_record_coordinates(
    parsed: &mut ParsedGff3,
    sequence_length: u64,
    source_path: &Path,
) -> Result<()> {
    let feature_count = parsed.record.features.len();
    if parsed.source_phases.len() != feature_count
        || parsed.source_strands.len() != feature_count
        || parsed.source_interval_qualifiers.len() != feature_count
        || parsed.source_origin_spanning.len() != feature_count
    {
        return Err(anyhow!(
            "{}: canonical GFF3 interval metadata does not match the feature count",
            source_path.display()
        ));
    }

    for feature_index in 0..feature_count {
        {
            let feature = &parsed.record.features[feature_index];
            let phases = &parsed.source_phases[feature_index];
            let strands = &parsed.source_strands[feature_index];
            let interval_qualifiers = &parsed.source_interval_qualifiers[feature_index];
            if phases.len() != feature.intervals.len()
                || strands.len() != feature.intervals.len()
                || interval_qualifiers.len() != feature.intervals.len()
            {
                return Err(anyhow!(
                    "{}: canonical GFF3 interval metadata for {} does not match its interval count",
                    source_path.display(),
                    feature.feature_type
                ));
            }
        }

        if parsed.record.topology == Topology::Circular {
            for interval in parsed.record.features[feature_index].intervals.iter_mut() {
                fold_second_copy_circular_interval(interval, sequence_length, source_path)?;
            }
        }

        let feature = &parsed.record.features[feature_index];
        let phases = &parsed.source_phases[feature_index];
        let strands = &parsed.source_strands[feature_index];
        let interval_qualifiers = &parsed.source_interval_qualifiers[feature_index];
        let mut has_virtual_interval = false;
        for (((interval, phase), strand), qualifiers) in feature
            .intervals
            .iter()
            .zip(phases)
            .zip(strands)
            .zip(interval_qualifiers)
        {
            if interval.start > sequence_length {
                return Err(anyhow!(
                    "{}: feature start {} exceeds FASTA sequence length {sequence_length}",
                    source_path.display(),
                    interval.start
                ));
            }
            if interval.end <= sequence_length {
                continue;
            }
            has_virtual_interval = true;

            if parsed.record.topology != Topology::Circular {
                return Err(anyhow!(
                    "{}: feature end {} exceeds FASTA sequence length {sequence_length}",
                    source_path.display(),
                    interval.end
                ));
            }

            let wrapped_end = interval.end - sequence_length;
            if wrapped_end >= interval.start {
                return Err(anyhow!(
                    "{}: circular virtual interval {}..{} exceeds one origin crossing for sequence length {sequence_length}",
                    source_path.display(),
                    interval.start,
                    interval.end
                ));
            }

            if qualifiers
                .iter()
                .any(|(key, _)| matches!(key.as_str(), "Target" | "Gap"))
            {
                return Err(anyhow!(
                    "{}: origin-spanning feature {}..{} carries Target/Gap alignment metadata that cannot yet be split safely",
                    source_path.display(),
                    interval.start,
                    interval.end
                ));
            }

            let end_of_contig = Interval {
                start: interval.start,
                end: sequence_length,
            };
            let start_of_contig = Interval {
                start: 1,
                end: wrapped_end,
            };
            let first_segment_length = match strand {
                Strand::Plus => end_of_contig.end - end_of_contig.start + 1,
                Strand::Minus => start_of_contig.end,
                Strand::Unknown if feature.feature_type.eq_ignore_ascii_case("CDS") => {
                    return Err(anyhow!(
                        "{}: origin-spanning CDS {}..{} has no known strand, so its split phase cannot be determined",
                        source_path.display(),
                        interval.start,
                        interval.end
                    ));
                }
                Strand::Unknown => end_of_contig.end - end_of_contig.start + 1,
            };
            next_split_cds_phase(
                &feature.feature_type,
                *phase,
                first_segment_length,
                source_path,
            )?;
        }

        if !has_virtual_interval {
            if parsed.source_origin_spanning[feature_index] {
                validate_origin_spanning_marker(
                    feature,
                    parsed.record.topology,
                    sequence_length,
                    source_path,
                )?;
            }
            continue;
        }

        let feature = &mut parsed.record.features[feature_index];
        let intervals = std::mem::take(&mut feature.intervals);
        let phases = std::mem::take(&mut parsed.source_phases[feature_index]);
        let strands = std::mem::take(&mut parsed.source_strands[feature_index]);
        let interval_qualifiers =
            std::mem::take(&mut parsed.source_interval_qualifiers[feature_index]);
        let mut normalized_intervals = Vec::with_capacity(intervals.len() + 1);
        let mut normalized_phases = Vec::with_capacity(phases.len() + 1);
        let mut normalized_strands = Vec::with_capacity(strands.len() + 1);
        let mut normalized_qualifiers = Vec::with_capacity(interval_qualifiers.len() + 1);

        for (((interval, phase), strand), qualifiers) in intervals
            .into_iter()
            .zip(phases)
            .zip(strands)
            .zip(interval_qualifiers)
        {
            if interval.end <= sequence_length {
                normalized_intervals.push(interval);
                normalized_phases.push(phase);
                normalized_strands.push(strand);
                normalized_qualifiers.push(qualifiers);
                continue;
            }

            let wrapped_end = interval.end - sequence_length;
            let end_of_contig = Interval {
                start: interval.start,
                end: sequence_length,
            };
            let start_of_contig = Interval {
                start: 1,
                end: wrapped_end,
            };
            let (start_boundary_qualifiers, end_boundary_qualifiers) =
                split_origin_boundary_qualifiers(qualifiers);
            let first_segment_length = match strand {
                Strand::Plus => end_of_contig.end - end_of_contig.start + 1,
                Strand::Minus => start_of_contig.end,
                Strand::Unknown => end_of_contig.end - end_of_contig.start + 1,
            };
            let next_phase = next_split_cds_phase(
                &feature.feature_type,
                phase,
                first_segment_length,
                source_path,
            )?;

            let mut push_segment =
                |interval: Interval,
                 segment_phase: Option<u8>,
                 segment_qualifiers: Vec<(String, Option<String>)>| {
                    normalized_intervals.push(interval);
                    normalized_phases.push(segment_phase);
                    normalized_strands.push(strand);
                    normalized_qualifiers.push(segment_qualifiers);
                };
            match strand {
                Strand::Minus => {
                    push_segment(start_of_contig, phase, end_boundary_qualifiers);
                    push_segment(end_of_contig, next_phase, start_boundary_qualifiers);
                }
                Strand::Plus | Strand::Unknown => {
                    push_segment(end_of_contig, phase, start_boundary_qualifiers);
                    push_segment(start_of_contig, next_phase, end_boundary_qualifiers);
                }
            }
        }

        feature.intervals = normalized_intervals;
        parsed.source_phases[feature_index] = normalized_phases;
        parsed.source_strands[feature_index] = normalized_strands;
        parsed.source_interval_qualifiers[feature_index] = normalized_qualifiers;
        parsed.source_origin_spanning[feature_index] = true;
        validate_origin_spanning_marker(
            feature,
            parsed.record.topology,
            sequence_length,
            source_path,
        )?;
    }
    parsed.record.length = sequence_length;
    Ok(())
}

fn validate_origin_spanning_marker(
    feature: &Feature,
    topology: Topology,
    sequence_length: u64,
    source_path: &Path,
) -> Result<()> {
    let valid = topology == Topology::Circular
        && feature.intervals.len() > 1
        && feature.intervals.iter().any(|interval| interval.start == 1)
        && feature
            .intervals
            .iter()
            .any(|interval| interval.end == sequence_length);
    if !valid {
        return Err(anyhow!(
            "{}: {ORIGIN_SPANNING_ATTR}=true requires a circular multipart feature with physical rows at coordinate 1 and sequence length {sequence_length}",
            source_path.display()
        ));
    }
    Ok(())
}

fn next_split_cds_phase(
    feature_type: &str,
    phase: Option<u8>,
    first_segment_length: u64,
    source_path: &Path,
) -> Result<Option<u8>> {
    if !feature_type.eq_ignore_ascii_case("CDS") {
        return Ok(None);
    }
    let phase = phase.ok_or_else(|| {
        anyhow!(
            "{}: origin-spanning CDS is missing its required phase",
            source_path.display()
        )
    })?;
    Ok(Some(
        ((u64::from(phase) + 3 - (first_segment_length % 3)) % 3) as u8,
    ))
}

fn split_origin_boundary_qualifiers(
    qualifiers: Vec<(String, Option<String>)>,
) -> (Vec<(String, Option<String>)>, Vec<(String, Option<String>)>) {
    let mut start_boundary = Vec::with_capacity(qualifiers.len());
    let mut end_boundary = Vec::with_capacity(qualifiers.len());
    for qualifier in qualifiers {
        match qualifier.0.as_str() {
            "start_range" => start_boundary.push(qualifier),
            "end_range" => end_boundary.push(qualifier),
            _ => {
                start_boundary.push(qualifier.clone());
                end_boundary.push(qualifier);
            }
        }
    }
    (start_boundary, end_boundary)
}

#[derive(Debug)]
pub(crate) struct Gff3Row {
    pub(crate) seqid: String,
    pub(crate) feature_type: String,
    pub(crate) start: u64,
    pub(crate) end: u64,
    pub(crate) strand: Strand,
    pub(crate) phase: Option<u8>,
    pub(crate) attributes: BTreeMap<String, String>,
}

fn discover_gff3_metadata(
    gff3_path: &Path,
) -> Result<(HashMap<String, u64>, HashSet<String>, bool)> {
    let file = File::open(gff3_path)
        .map_err(|e| IndexerError::GenbankParseFailed(format!("{}: {}", gff3_path.display(), e)))?;
    let reader: Box<dyn Read> = {
        let mut buffered = BufReader::new(file);
        let buf = buffered.fill_buf().unwrap_or(&[]);
        if buf.len() >= 2 && buf[0] == 0x1f && buf[1] == 0x8b {
            Box::new(flate2::read::MultiGzDecoder::new(buffered))
        } else {
            Box::new(buffered)
        }
    };

    let mut sequence_region_lengths = HashMap::new();
    let mut circular_sequence_ids = HashSet::new();
    let mut globally_circular = false;
    for line in BufReader::new(reader).lines() {
        let line = line?;
        if let Some(value) = line.strip_prefix("##sequence-region ") {
            let mut fields = value.split_whitespace();
            let seqid = fields.next();
            let start = fields.next().and_then(|raw| raw.parse::<u64>().ok());
            let end = fields.next().and_then(|raw| raw.parse::<u64>().ok());
            if let (Some(seqid), Some(1), Some(end)) = (seqid, start, end) {
                sequence_region_lengths.insert(seqid.to_string(), end);
            }
            continue;
        }
        if line == "##dna-indexer-topology circular" {
            globally_circular = true;
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let columns: Vec<&str> = line.split('\t').collect();
        if columns.len() < 9 || !matches!(columns[2], "region" | "chromosome") {
            continue;
        }
        if columns[3] != "1" {
            continue;
        }
        if let Ok(end) = columns[4].parse::<u64>() {
            sequence_region_lengths
                .entry(columns[0].to_string())
                .or_insert(end);
        }
        if columns[8]
            .split(';')
            .any(|attribute| attribute == "Is_circular=true")
        {
            circular_sequence_ids.insert(columns[0].to_string());
        }
    }
    Ok((
        sequence_region_lengths,
        circular_sequence_ids,
        globally_circular,
    ))
}

pub(crate) fn repair_reversed_circular_virtual_interval(
    line: &str,
    topology: Topology,
    sequence_region_length: Option<&u64>,
) -> Option<String> {
    if topology != Topology::Circular {
        return None;
    }
    let mut columns: Vec<&str> = line.split('\t').collect();
    if columns.len() < 9 {
        return None;
    }
    let start = columns[3].parse::<u64>().ok()?;
    let end = columns[4].parse::<u64>().ok()?;
    let sequence_length = *sequence_region_length?;
    if end >= start || start <= sequence_length || end == 0 || end > sequence_length {
        return None;
    }
    columns.swap(3, 4);
    Some(columns.join("\t"))
}

pub(crate) struct Gff3RowHead<'a> {
    pub seqid: &'a str,
    pub feature_type: &'a str,
    pub start: u64,
    pub end: u64,
}

pub(crate) fn validate_row(line: &str) -> Result<Gff3RowHead<'_>> {
    let mut cols = [""; 9];
    let mut count = 0;
    for (index, column) in line.split('\t').enumerate() {
        if index < 9 {
            cols[index] = column;
        }
        count = index + 1;
    }
    if count < 9 {
        return Err(anyhow!("expected 9 tab-separated columns, got {}", count));
    }
    let (start, end) = validate_row_columns(&cols)?;
    Ok(Gff3RowHead {
        seqid: cols[0],
        feature_type: cols[2],
        start,
        end,
    })
}

fn validate_row_columns(cols: &[&str]) -> Result<(u64, u64)> {
    let start: u64 = cols[3]
        .parse()
        .map_err(|e| anyhow!("invalid start column: {}", e))?;
    if start == 0 {
        return Err(anyhow!("feature start must be at least 1"));
    }
    let end: u64 = cols[4]
        .parse()
        .map_err(|e| anyhow!("invalid end column: {}", e))?;
    if end < start {
        return Err(anyhow!("feature end {end} precedes feature start {start}"));
    }
    let is_cds = cols[2].eq_ignore_ascii_case("CDS");
    match cols[7] {
        "." if is_cds => return Err(anyhow!("CDS phase must be 0, 1, or 2")),
        "." | "0" | "1" | "2" => {}
        value if is_cds => return Err(anyhow!("invalid CDS phase {value}")),
        value => return Err(anyhow!("non-CDS feature has phase {value}; expected .")),
    }
    if raw_attribute_value(cols[8], "Parent").is_some_and(|parent| parent.contains(',')) {
        return Err(anyhow!(
            "multiple Parent targets are valid GFF3 but are not yet supported"
        ));
    }
    Ok((start, end))
}

pub(crate) fn parse_row(line: &str) -> Result<Gff3Row> {
    let cols: Vec<&str> = line.split('\t').collect();
    if cols.len() < 9 {
        return Err(anyhow!(
            "expected 9 tab-separated columns, got {}",
            cols.len()
        ));
    }
    let (start, end) = validate_row_columns(&cols)?;
    let strand = match cols[6] {
        "+" => Strand::Plus,
        "-" => Strand::Minus,
        _ => Strand::Unknown,
    };
    let phase = if cols[2].eq_ignore_ascii_case("CDS") {
        cols[7].parse::<u8>().ok()
    } else {
        None
    };
    let attributes = parse_attributes(cols[8]);
    Ok(Gff3Row {
        seqid: cols[0].to_string(),
        feature_type: cols[2].to_string(),
        start,
        end,
        strand,
        phase,
        attributes,
    })
}

fn raw_attribute_value<'a>(attributes: &'a str, key: &str) -> Option<&'a str> {
    attributes.split(';').find_map(|entry| {
        let (candidate, value) = entry.trim().split_once('=')?;
        (candidate == key).then_some(value)
    })
}

fn parse_attributes(col: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for entry in col.split(';') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some(eq) = entry.find('=') {
            let key = entry[..eq].to_string();
            let val = url_decode(&entry[eq + 1..]);
            out.insert(key, val);
        }
    }
    out
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h1), Some(h2)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push((h1 << 4) | h2);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone)]
struct MultipartAccumulator {
    feature_type: String,
    strand: Strand,
    intervals: Vec<Interval>,
    phases: Vec<Option<u8>>,
    strands: Vec<Strand>,
    qualifiers: Vec<(String, Option<String>)>,
    interval_qualifiers: Vec<Vec<(String, Option<String>)>>,
    id: Option<String>,
    parent_id: Option<String>,
    location_string: String,
    origin_spanning: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gff_emit::{emit_gff3_with_opts, EmitOpts};
    use std::io::Write;

    fn write_temp(tag: &str, contents: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = dir.join(format!(
            "gff3_input_test_{}_{}_{}.gff3",
            tag,
            std::process::id(),
            nanos
        ));
        let mut f = File::create(&path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        path
    }

    #[test]
    fn parse_simple_gff3() {
        let p = write_temp(
            "simple",
            "##gff-version 3\n\
             chr1\ttest\tgene\t100\t1000\t.\t+\t.\tID=gene-A;Name=A\n\
             chr1\ttest\tmRNA\t100\t1000\t.\t+\t.\tID=mrna-A1;Parent=gene-A\n\
             chr1\ttest\texon\t100\t200\t.\t+\t.\tID=exon-A1-0;Parent=mrna-A1\n\
             chr1\ttest\texon\t400\t500\t.\t+\t.\tID=exon-A1-1;Parent=mrna-A1\n\
             chr1\ttest\tCDS\t150\t200\t.\t+\t0\tID=cds-A1-0;Parent=mrna-A1\n\
             chr1\ttest\tCDS\t400\t500\t.\t+\t0\tID=cds-A1-1;Parent=mrna-A1\n",
        );
        let result = parse_gff3(&p, None).unwrap();
        assert_eq!(result.record.features.len(), 6);
        let exon_count = result
            .record
            .features
            .iter()
            .filter(|f| f.feature_type == "exon")
            .count();
        assert_eq!(exon_count, 2);
        let cds_count = result
            .record
            .features
            .iter()
            .filter(|f| f.feature_type == "CDS")
            .count();
        assert_eq!(cds_count, 2);
        for (i, f) in result.record.features.iter().enumerate() {
            if f.feature_type == "exon" || f.feature_type == "CDS" {
                assert_eq!(
                    result.parent_ids[i],
                    Some("mrna-A1".to_string()),
                    "feature {} ({}) missing Parent= link",
                    i,
                    f.feature_type
                );
            }
        }
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn url_decode_handles_percent_escapes() {
        assert_eq!(url_decode("foo%2Cbar"), "foo,bar");
        assert_eq!(url_decode("a%3Db"), "a=b");
        assert_eq!(url_decode("plain"), "plain");
        assert_eq!(url_decode("%ZZ"), "%ZZ");
    }

    #[test]
    fn skips_comment_and_directive_lines() {
        let p = write_temp(
            "skip",
            "##gff-version 3\n\
             ##sequence-region chr1 1 1000\n\
             # this is a comment\n\
             chr1\ttest\tgene\t100\t1000\t.\t+\t.\tID=gene-A\n",
        );
        let result = parse_gff3(&p, None).unwrap();
        assert_eq!(result.record.features.len(), 1);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn detects_minus_strand() {
        let p = write_temp(
            "minus",
            "##gff-version 3\n\
             chr1\ttest\tCDS\t100\t200\t.\t-\t0\tID=cds-rev\n",
        );
        let result = parse_gff3(&p, None).unwrap();
        assert_eq!(result.record.features[0].strand, Strand::Minus);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn public_gff3_non_cds_phase_zero_is_ignored() {
        let gene = parse_row("chr1\ttest\tgene\t100\t200\t.\t+\t0\tID=gene-A").unwrap();
        assert_eq!(gene.feature_type, "gene");
        assert_eq!(gene.phase, None);

        let exon =
            parse_row("chr1\ttest\texon\t100\t150\t.\t+\t0\tID=exon-A;Parent=mrna-A").unwrap();
        assert_eq!(exon.phase, None);

        let cds = parse_row("chr1\ttest\tCDS\t100\t150\t.\t+\t0\tID=cds-A;Parent=mrna-A").unwrap();
        assert_eq!(cds.phase, Some(0));

        let missing_cds_phase = parse_row("chr1\ttest\tCDS\t100\t150\t.\t+\t.\tID=cds-A");
        assert!(missing_cds_phase
            .unwrap_err()
            .to_string()
            .contains("CDS phase must be 0, 1, or 2"));
    }

    #[test]
    fn empty_gff3_returns_error() {
        let p = write_temp("empty", "##gff-version 3\n# only comments\n");
        let err = parse_gff3(&p, None).unwrap_err();
        assert!(err.to_string().contains("no feature rows"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rejects_multiple_gff3_sequence_ids_instead_of_dropping_later_contigs() {
        let p = write_temp(
            "multiple_seqids",
            "##gff-version 3\n\
             chr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene-1\n\
             chr2\ttest\tgene\t1\t4\t.\t+\t.\tID=gene-2\n",
        );
        let err = parse_gff3(&p, None).unwrap_err();
        assert!(err.to_string().contains("multiple sequence IDs"));
        assert!(err.to_string().contains("chr1"));
        assert!(err.to_string().contains("chr2"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rejects_multiple_fasta_records_instead_of_concatenating_sequences() {
        let gff = write_temp(
            "one_seqid",
            "##gff-version 3\n\
             chr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene-1\n",
        );
        let fasta = write_temp("multiple_fasta", ">chr1\nACGT\n>chr2\nTGCA\n");
        let err = parse_gff3(&gff, Some(&fasta)).unwrap_err();
        assert!(err.to_string().contains("FASTA contains multiple records"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn rejects_mismatched_fasta_and_gff3_sequence_ids() {
        let gff = write_temp(
            "gff_seqid",
            "##gff-version 3\n\
             chr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene-1\n",
        );
        let fasta = write_temp("fasta_seqid", ">chr2\nACGT\n");
        let err = parse_gff3(&gff, Some(&fasta)).unwrap_err();
        assert!(err.to_string().contains("does not match GFF3 sequence ID"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn rejects_feature_with_end_before_start() {
        let gff = write_temp(
            "reversed_interval",
            "##gff-version 3\n\
             chr1\ttest\tgene\t5\t4\t.\t+\t.\tID=gene-1\n",
        );
        let err = parse_gff3(&gff, None).unwrap_err();
        assert!(err
            .to_string()
            .contains("feature end 4 precedes feature start 5"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn repairs_reversed_virtual_interval_on_declared_circular_sequence() {
        let gff = write_temp(
            "reversed_circular_virtual_interval",
            "##gff-version 3\n\
             ##sequence-region chrM 1 100\n\
             chrM\ttest\tregion\t1\t100\t.\t+\t.\tID=chrM;Is_circular=true\n\
             chrM\ttest\tmRNA\t150\t50\t.\t?\t.\tID=rna-wrap;exception=trans-splicing\n",
        );
        let parsed = parse_gff3_for_sequence(&gff, "chrM").unwrap();
        let mrna = parsed
            .record
            .features
            .iter()
            .find(|feature| feature.feature_type == "mRNA")
            .unwrap();
        assert_eq!(
            mrna.intervals,
            vec![Interval {
                start: 50,
                end: 150
            }]
        );
        assert_eq!(parsed.record.topology, Topology::Circular);
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn repairs_reversed_virtual_interval_from_circular_region_length() {
        let gff = write_temp(
            "reversed_circular_region_length",
            "##gff-version 3\n\
             NC_020455.1\tRefSeq\tmRNA\t150\t50\t.\t?\t.\tID=rna-wrap;exception=trans-splicing\n\
             NC_020455.1\tRefSeq\tregion\t1\t100\t.\t+\t.\tID=NC_020455.1:1..100;Is_circular=true\n",
        );
        let parsed = parse_gff3_for_sequence(&gff, "NC_020455.1").unwrap();
        let mrna = parsed
            .record
            .features
            .iter()
            .find(|feature| feature.feature_type == "mRNA")
            .unwrap();
        assert_eq!(
            mrna.intervals,
            vec![Interval {
                start: 50,
                end: 150
            }]
        );
        assert_eq!(parsed.record.topology, Topology::Circular);
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn repairs_reversed_virtual_interval_from_manifest_circular_hint() {
        let gff = write_temp(
            "reversed_circular_manifest_hint",
            "##gff-version 3\n\
             NC_020455.1\tRefSeq\tmRNA\t150\t50\t.\t?\t.\tID=rna-wrap;exception=trans-splicing\n",
        );
        let parsed =
            parse_gff3_for_sequence_with_manifest(&gff, "NC_020455.1", 100, Some(true)).unwrap();
        let mrna = parsed
            .record
            .features
            .iter()
            .find(|feature| feature.feature_type == "mRNA")
            .unwrap();
        assert_eq!(
            mrna.intervals,
            vec![Interval {
                start: 50,
                end: 150
            }]
        );
        assert_eq!(parsed.record.topology, Topology::Circular);
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn manifest_linear_hint_does_not_repair_reversed_interval() {
        let gff = write_temp(
            "reversed_linear_manifest_hint",
            "##gff-version 3\n\
             NC_020455.1\tRefSeq\tmRNA\t150\t50\t.\t?\t.\tID=rna-wrap;exception=trans-splicing\n",
        );
        let err = parse_gff3_for_sequence_with_manifest(&gff, "NC_020455.1", 100, Some(false))
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("feature end 50 precedes feature start 150"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn manifest_length_hint_bounds_circular_repair() {
        let gff = write_temp(
            "reversed_circular_manifest_length_bound",
            "##gff-version 3\n\
             NC_020455.1\tRefSeq\tmRNA\t150\t50\t.\t?\t.\tID=rna-wrap;exception=trans-splicing\n",
        );
        let err = parse_gff3_for_sequence_with_manifest(&gff, "NC_020455.1", 200, Some(true))
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("feature end 50 precedes feature start 150"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn folds_second_copy_circular_interval_to_physical_coordinates() {
        let gff = write_temp(
            "second_copy_circular_interval",
            "##gff-version 3\n\
             NC_001320.1\tRefSeq\tmRNA\t150\t160\t.\t+\t.\tID=rna-second-copy\n",
        );
        let mut parsed =
            parse_gff3_for_sequence_with_manifest(&gff, "NC_001320.1", 100, Some(true)).unwrap();
        normalize_record_coordinates(&mut parsed, 100, &gff).unwrap();
        let mrna = parsed
            .record
            .features
            .iter()
            .find(|feature| feature.feature_type == "mRNA")
            .unwrap();
        assert_eq!(
            mrna.intervals,
            vec![Interval {
                start: 50,
                end: 60
            }]
        );
        assert_eq!(parsed.record.topology, Topology::Circular);
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn rejects_second_copy_start_on_linear_sequence() {
        let gff = write_temp(
            "second_copy_linear_interval",
            "##gff-version 3\n\
             NC_001320.1\tRefSeq\tmRNA\t150\t160\t.\t+\t.\tID=rna-second-copy\n",
        );
        let mut parsed =
            parse_gff3_for_sequence_with_manifest(&gff, "NC_001320.1", 100, Some(false)).unwrap();
        let err = normalize_record_coordinates(&mut parsed, 100, &gff).unwrap_err();
        assert!(err
            .to_string()
            .contains("feature start 150 exceeds FASTA sequence length 100"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn rejects_zero_based_feature_start() {
        let gff = write_temp(
            "zero_start",
            "##gff-version 3\n\
             chr1\ttest\tgene\t0\t4\t.\t+\t.\tID=gene-1\n",
        );
        let err = parse_gff3(&gff, None).unwrap_err();
        assert!(err.to_string().contains("feature start must be at least 1"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn rejects_feature_end_beyond_external_fasta_length() {
        let gff = write_temp(
            "feature_beyond_fasta",
            "##gff-version 3\n\
             chr1\ttest\tgene\t1\t5\t.\t+\t.\tID=gene-1\n",
        );
        let fasta = write_temp("short_fasta", ">chr1\nACGT\n");
        let err = parse_gff3(&gff, Some(&fasta)).unwrap_err();
        assert!(err
            .to_string()
            .contains("feature end 5 exceeds FASTA sequence length 4"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn normalizes_rhesus_mitochondrial_origin_spanning_d_loop() {
        let gff = write_temp(
            "rhesus_mitochondrial_d_loop",
            "##gff-version 3\n\
             NC_005943.1\tRefSeq\tregion\t1\t16564\t.\t+\t.\tID=NC_005943.1:1..16564;Is_circular=true\n\
             NC_005943.1\tRefSeq\tD_loop\t16015\t17099\t.\t+\t.\tID=id-NC_005943.1:1..16564;gbkey=D-loop\n",
        );
        let mut parsed = parse_gff3_for_sequence(&gff, "NC_005943.1").unwrap();
        parsed.record.topology = Topology::Circular;
        normalize_record_coordinates(&mut parsed, 16_564, &gff).unwrap();
        let d_loop_index = parsed
            .record
            .features
            .iter()
            .position(|feature| feature.feature_type == "D_loop")
            .unwrap();
        assert_eq!(
            parsed.record.features[d_loop_index].intervals,
            vec![
                Interval {
                    start: 16_015,
                    end: 16_564,
                },
                Interval { start: 1, end: 535 },
            ]
        );
        assert_eq!(parsed.source_phases[d_loop_index], vec![None, None]);
        assert_eq!(
            parsed.source_strands[d_loop_index],
            vec![Strand::Plus, Strand::Plus]
        );
        assert_eq!(parsed.source_interval_qualifiers[d_loop_index].len(), 2);
        assert!(!parsed.source_origin_spanning[0]);
        assert!(parsed.source_origin_spanning[d_loop_index]);
        let emit_opts = EmitOpts {
            source_ids: Some(parsed.source_ids.clone()),
            explicit_parent_source_ids: Some(parsed.parent_ids.clone()),
            source_phases: Some(parsed.source_phases.clone()),
            source_strands: Some(parsed.source_strands.clone()),
            source_interval_qualifiers: Some(parsed.source_interval_qualifiers.clone()),
            source_origin_spanning: Some(parsed.source_origin_spanning.clone()),
        };
        let emitted = emit_gff3_with_opts(&parsed.record, "NC_005943.1", "0.1.0", &emit_opts);
        let d_loop_rows: Vec<Vec<&str>> = emitted
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .filter(|columns: &Vec<&str>| columns[2] == "D_loop")
            .collect();
        assert_eq!(d_loop_rows.len(), 2);
        assert_eq!(
            d_loop_rows
                .iter()
                .map(|columns| (columns[3], columns[4]))
                .collect::<Vec<_>>(),
            vec![("1", "535"), ("16015", "16564")]
        );
        let d_loop_ids: std::collections::HashSet<&str> = d_loop_rows
            .iter()
            .map(|columns| {
                columns[8]
                    .split(';')
                    .find_map(|attribute| attribute.strip_prefix("ID="))
                    .unwrap()
            })
            .collect();
        assert_eq!(d_loop_ids.len(), 1);
        assert!(d_loop_rows
            .iter()
            .all(|columns| columns[8].contains("gbkey=D-loop")));
        assert!(d_loop_rows
            .iter()
            .all(|columns| columns[8].contains("_dnaforge_origin_spanning=true")));

        let canonical_gff = write_temp("rhesus_mitochondrial_canonical", &emitted);
        let reparsed = parse_gff3(&canonical_gff, None).unwrap();
        let reparsed_d_loop = reparsed
            .record
            .features
            .iter()
            .position(|feature| feature.feature_type == "D_loop")
            .unwrap();
        assert_eq!(reparsed.record.topology, Topology::Circular);
        assert!(reparsed.source_origin_spanning[reparsed_d_loop]);
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&canonical_gff).ok();
    }

    #[test]
    fn preserves_physical_origin_spanning_rows_across_canonical_reparse() {
        let gff = write_temp(
            "physical_origin_spanning_d_loop",
            "##gff-version 3\n\
             ##dna-indexer-topology circular\n\
             NC_005943.1\tDNAForge\tD_loop\t1\t535\t.\t+\t.\tID=origin-d-loop;_dnaforge_origin_spanning=true;gbkey=D-loop\n\
             NC_005943.1\tDNAForge\tD_loop\t16015\t16564\t.\t+\t.\tID=origin-d-loop;_dnaforge_origin_spanning=true;gbkey=D-loop\n",
        );
        let parsed = parse_gff3(&gff, None).unwrap();
        let d_loop_index = parsed
            .record
            .features
            .iter()
            .position(|feature| feature.feature_type == "D_loop")
            .unwrap();
        assert!(parsed.source_origin_spanning[d_loop_index]);

        let emit_opts = EmitOpts {
            source_ids: Some(parsed.source_ids.clone()),
            explicit_parent_source_ids: Some(parsed.parent_ids.clone()),
            source_phases: Some(parsed.source_phases.clone()),
            source_strands: Some(parsed.source_strands.clone()),
            source_interval_qualifiers: Some(parsed.source_interval_qualifiers.clone()),
            source_origin_spanning: Some(parsed.source_origin_spanning.clone()),
        };
        let emitted = emit_gff3_with_opts(&parsed.record, "NC_005943.1", "0.1.0", &emit_opts);
        let coordinates: Vec<(&str, &str)> = emitted
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .filter(|columns| columns[2] == "D_loop")
            .map(|columns| (columns[3], columns[4]))
            .collect();
        assert_eq!(coordinates, vec![("1", "535"), ("16015", "16564")]);
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn unmarked_physical_boundary_rows_keep_schema_v2_bbox_shape() {
        let gff = write_temp(
            "unmarked_physical_boundary_rows",
            "##gff-version 3\n\
             ##dna-indexer-topology circular\n\
             circle\ttest\tmisc_feature\t1\t3\t.\t+\t.\tID=boundary-feature\n\
             circle\ttest\tmisc_feature\t8\t10\t.\t+\t.\tID=boundary-feature\n",
        );
        let parsed = parse_gff3(&gff, None).unwrap();
        assert!(!parsed.source_origin_spanning[0]);
        let emit_opts = EmitOpts {
            source_ids: Some(parsed.source_ids.clone()),
            explicit_parent_source_ids: Some(parsed.parent_ids.clone()),
            source_phases: Some(parsed.source_phases.clone()),
            source_strands: Some(parsed.source_strands.clone()),
            source_interval_qualifiers: Some(parsed.source_interval_qualifiers.clone()),
            source_origin_spanning: Some(parsed.source_origin_spanning.clone()),
        };
        let emitted = emit_gff3_with_opts(&parsed.record, "circle", "0.1.0", &emit_opts);
        let rows: Vec<Vec<&str>> = emitted
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0][3], rows[0][4]), ("1", "10"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn normalizes_minus_strand_origin_spanning_cds_phase_and_boundary_attributes() {
        let gff = write_temp(
            "minus_origin_cds",
            "##gff-version 3\n\
             circle\ttest\tregion\t1\t10\t.\t+\t.\tID=region-1;Is_circular=true\n\
             circle\ttest\tCDS\t7\t14\t.\t-\t1\tID=origin-cds;start_range=7,.;end_range=.,14\n",
        );
        let fasta = write_temp("minus_origin_cds_fasta", ">circle\nACGTACGTAC\n");
        let parsed = parse_gff3(&gff, Some(&fasta)).unwrap();
        let cds_index = parsed
            .record
            .features
            .iter()
            .position(|feature| feature.feature_type == "CDS")
            .unwrap();
        assert_eq!(
            parsed.record.features[cds_index].intervals,
            vec![
                Interval { start: 1, end: 4 },
                Interval { start: 7, end: 10 }
            ]
        );
        assert_eq!(parsed.source_phases[cds_index], vec![Some(1), Some(0)]);
        assert!(parsed.source_origin_spanning[cds_index]);
        assert!(parsed.source_interval_qualifiers[cds_index][0]
            .iter()
            .any(|(key, _)| key == "end_range"));
        assert!(parsed.source_interval_qualifiers[cds_index][0]
            .iter()
            .all(|(key, _)| key != "start_range"));
        assert!(parsed.source_interval_qualifiers[cds_index][1]
            .iter()
            .any(|(key, _)| key == "start_range"));
        assert!(parsed.source_interval_qualifiers[cds_index][1]
            .iter()
            .all(|(key, _)| key != "end_range"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn normalizes_plus_strand_origin_spanning_cds_phase_in_biological_order() {
        let gff = write_temp(
            "plus_origin_cds",
            "##gff-version 3\n\
             circle\ttest\tregion\t1\t10\t.\t+\t.\tID=region-1;Is_circular=true\n\
             circle\ttest\tCDS\t7\t14\t.\t+\t1\tID=origin-cds\n",
        );
        let fasta = write_temp("plus_origin_cds_fasta", ">circle\nACGTACGTAC\n");
        let parsed = parse_gff3(&gff, Some(&fasta)).unwrap();
        let cds_index = parsed
            .record
            .features
            .iter()
            .position(|feature| feature.feature_type == "CDS")
            .unwrap();
        assert_eq!(
            parsed.record.features[cds_index].intervals,
            vec![
                Interval { start: 7, end: 10 },
                Interval { start: 1, end: 4 }
            ]
        );
        assert_eq!(parsed.source_phases[cds_index], vec![Some(1), Some(0)]);
        assert!(parsed.source_origin_spanning[cds_index]);
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn carries_cds_phase_across_a_first_segment_shorter_than_the_phase() {
        let gff = write_temp(
            "short_first_segment_origin_cds",
            "##gff-version 3\n\
             circle\ttest\tregion\t1\t10\t.\t+\t.\tID=region-1;Is_circular=true\n\
             circle\ttest\tCDS\t10\t13\t.\t+\t2\tID=origin-cds\n",
        );
        let fasta = write_temp(
            "short_first_segment_origin_cds_fasta",
            ">circle\nACGTACGTAC\n",
        );
        let parsed = parse_gff3(&gff, Some(&fasta)).unwrap();
        let cds_index = parsed
            .record
            .features
            .iter()
            .position(|feature| feature.feature_type == "CDS")
            .unwrap();
        assert_eq!(
            parsed.record.features[cds_index].intervals,
            vec![
                Interval { start: 10, end: 10 },
                Interval { start: 1, end: 3 }
            ]
        );
        assert_eq!(parsed.source_phases[cds_index], vec![Some(2), Some(1)]);
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn rejects_origin_spanning_alignment_metadata_until_it_can_be_split() {
        let gff = write_temp(
            "origin_alignment_metadata",
            "##gff-version 3\n\
             circle\ttest\tregion\t1\t10\t.\t+\t.\tID=region-1;Is_circular=true\n\
             circle\ttest\tmatch\t8\t13\t.\t+\t.\tID=origin-match;Target=target 1 6 +;Gap=M6\n",
        );
        let fasta = write_temp("origin_alignment_metadata_fasta", ">circle\nACGTACGTAC\n");
        let error = parse_gff3(&gff, Some(&fasta)).unwrap_err();
        assert!(error
            .to_string()
            .contains("Target/Gap alignment metadata that cannot yet be split safely"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn rejects_origin_spanning_cds_without_a_known_strand() {
        let gff = write_temp(
            "unknown_strand_origin_cds",
            "##gff-version 3\n\
             circle\ttest\tregion\t1\t10\t.\t+\t.\tID=region-1;Is_circular=true\n\
             circle\ttest\tCDS\t7\t14\t.\t.\t1\tID=origin-cds\n",
        );
        let fasta = write_temp("unknown_strand_origin_cds_fasta", ">circle\nACGTACGTAC\n");
        let err = parse_gff3(&gff, Some(&fasta)).unwrap_err();
        assert!(err
            .to_string()
            .contains("has no known strand, so its split phase cannot be determined"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn rejects_circular_virtual_interval_that_exceeds_one_origin_crossing() {
        let gff = write_temp(
            "multi_turn_origin_interval",
            "##gff-version 3\n\
             circle\ttest\tregion\t1\t10\t.\t+\t.\tID=region-1;Is_circular=true\n\
             circle\ttest\tgene\t7\t17\t.\t+\t.\tID=overlong-gene\n",
        );
        let fasta = write_temp("multi_turn_origin_fasta", ">circle\nACGTACGTAC\n");
        let err = parse_gff3(&gff, Some(&fasta)).unwrap_err();
        assert!(err
            .to_string()
            .contains("exceeds one origin crossing for sequence length 10"));
        std::fs::remove_file(&gff).ok();
        std::fs::remove_file(&fasta).ok();
    }

    #[test]
    fn preserves_multipart_cds_phases_and_resolves_child_before_parent() {
        let gff = write_temp(
            "multipart_phases",
            "##gff-version 3\n\
             chr1\ttest\tCDS\t1\t3\t.\t+\t0\tID=cds-1;Parent=tx-1;end_range=3,.\n\
             chr1\ttest\tCDS\t7\t9\t.\t+\t2\tID=cds-1;Parent=tx-1\n\
             chr1\ttest\tmRNA\t1\t9\t.\t+\t.\tID=tx-1\n",
        );
        let parsed = parse_gff3(&gff, None).unwrap();
        assert_eq!(parsed.record.features.len(), 2);
        assert_eq!(parsed.record.features[0].intervals.len(), 2);
        assert_eq!(parsed.source_phases[0], vec![Some(0), Some(2)]);
        assert!(parsed.source_interval_qualifiers[0][0]
            .iter()
            .any(|(key, value)| key == "end_range" && value.as_deref() == Some("3,.")));
        assert!(parsed.source_interval_qualifiers[0][1]
            .iter()
            .all(|(key, _)| key != "end_range"));
        assert_eq!(parsed.parent_ids[0].as_deref(), Some("tx-1"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn rejects_unresolved_or_multiple_parent_relationships() {
        let missing = write_temp(
            "missing_parent",
            "##gff-version 3\n\
             chr1\ttest\texon\t1\t3\t.\t+\t.\tID=exon-1;Parent=missing\n",
        );
        let err = parse_gff3(&missing, None).unwrap_err();
        assert!(err.to_string().contains("Parent=missing does not resolve"));
        std::fs::remove_file(&missing).ok();

        let multiple = write_temp(
            "multiple_parents",
            "##gff-version 3\n\
             chr1\ttest\texon\t1\t3\t.\t+\t.\tID=exon-1;Parent=tx-1,tx-2\n",
        );
        let err = parse_gff3(&multiple, None).unwrap_err();
        assert!(err
            .to_string()
            .contains("multiple Parent targets are valid GFF3"));
        std::fs::remove_file(&multiple).ok();
    }

    #[test]
    fn groups_real_shape_trans_spliced_gene_with_interval_strands() {
        let gff = write_temp(
            "trans_spliced_gene",
            "##gff-version 3\n\
             NT_033777.3\tRefSeq\tgene\t21370101\t21377401\t.\t-\t.\tID=gene-Dmel_CG32491;part=1;exception=trans-splicing\n\
             NT_033777.3\tRefSeq\tgene\t21365609\t21370249\t.\t+\t.\tID=gene-Dmel_CG32491;part=2;exception=trans-splicing\n\
             NT_033777.3\tRefSeq\tgene\t21362188\t21365488\t.\t-\t.\tID=gene-Dmel_CG32491;part=3;exception=trans-splicing\n\
             NT_033777.3\tRefSeq\tgene\t21360176\t21362131\t.\t+\t.\tID=gene-Dmel_CG32491;part=4;exception=trans-splicing\n\
             NT_033777.3\tRefSeq\tgene\t21350846\t21359768\t.\t-\t.\tID=gene-Dmel_CG32491;part=5;exception=trans-splicing\n\
             NT_033777.3\tRefSeq\tmRNA\t21350846\t21377401\t.\t-\t.\tID=rna-NM_163881.2;Parent=gene-Dmel_CG32491\n",
        );
        let parsed = parse_gff3(&gff, None).unwrap();
        assert_eq!(parsed.record.features.len(), 2);
        assert_eq!(parsed.record.features[0].intervals.len(), 5);
        assert_eq!(parsed.record.features[0].strand, Strand::Unknown);
        assert_eq!(
            parsed.source_strands[0],
            vec![
                Strand::Minus,
                Strand::Plus,
                Strand::Minus,
                Strand::Plus,
                Strand::Minus
            ]
        );
        assert_eq!(
            parsed.source_interval_qualifiers[0]
                .iter()
                .map(|qualifiers| qualifiers
                    .iter()
                    .find(|(key, _)| key == "part")
                    .and_then(|(_, value)| value.as_deref())
                    .unwrap())
                .collect::<Vec<_>>(),
            vec!["1", "2", "3", "4", "5"]
        );
        assert_eq!(parsed.parent_ids[1].as_deref(), Some("gene-Dmel_CG32491"));
        std::fs::remove_file(&gff).ok();
    }

    #[test]
    fn rejects_repeated_id_type_or_parent_conflicts_but_retains_segment_attributes() {
        let changed_type = write_temp(
            "repeated_id_changed_type",
            "##gff-version 3\n\
             chr1\ttest\tgene\t1\t3\t.\t+\t.\tID=shared-1\n\
             chr1\ttest\tmRNA\t7\t9\t.\t-\t.\tID=shared-1\n",
        );
        let err = parse_gff3(&changed_type, None).unwrap_err();
        assert!(err
            .to_string()
            .contains("repeated GFF3 ID shared-1 changes type or Parent"));
        std::fs::remove_file(&changed_type).ok();

        let changed_parent = write_temp(
            "repeated_id_changed_parent",
            "##gff-version 3\n\
             chr1\ttest\tgene\t1\t9\t.\t+\t.\tID=tx-1\n\
             chr1\ttest\tgene\t10\t18\t.\t+\t.\tID=tx-2\n\
             chr1\ttest\tCDS\t1\t3\t.\t+\t0\tID=cds-1;Parent=tx-1\n\
             chr1\ttest\tCDS\t7\t9\t.\t-\t2\tID=cds-1;Parent=tx-2\n",
        );
        let err = parse_gff3(&changed_parent, None).unwrap_err();
        assert!(err
            .to_string()
            .contains("repeated GFF3 ID cds-1 changes type or Parent"));
        std::fs::remove_file(&changed_parent).ok();

        let attributes = write_temp(
            "colliding_leaf_id_attributes",
            "##gff-version 3\n\
             chr1\ttest\tprimer_bind\t1\t3\t.\t+\t.\tID=primer-1;Name=forward\n\
             chr1\ttest\tprimer_bind\t1\t3\t.\t+\t.\tID=primer-1;Name=reverse\n",
        );
        let parsed = parse_gff3(&attributes, None).unwrap();
        assert_eq!(parsed.record.features.len(), 1);
        assert_eq!(parsed.record.features[0].intervals.len(), 2);
        assert_eq!(
            parsed.source_interval_qualifiers[0]
                .iter()
                .map(|qualifiers| qualifiers
                    .iter()
                    .find(|(key, _)| key == "Name")
                    .and_then(|(_, value)| value.as_deref())
                    .unwrap())
                .collect::<Vec<_>>(),
            vec!["forward", "reverse"]
        );
        std::fs::remove_file(&attributes).ok();
    }
}
