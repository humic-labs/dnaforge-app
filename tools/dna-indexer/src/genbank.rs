
use crate::error::{self, IndexerError};
use crate::model::{Feature, Interval, ParsedRecord, Strand, Topology};
use anyhow::Result;
use gb_io::reader::SeqReader;
use gb_io::seq::{Feature as GbFeature, Location, Seq, Topology as GbTopology};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::rc::Rc;

pub fn parse_genbank(path: &Path) -> Result<Vec<ParsedRecord>> {
    let failed = |e: &dyn std::fmt::Display| IndexerError::GenbankParseFailed(format!("{}: {}", path.display(), e));
    let file = std::fs::File::open(path).map_err(|e| failed(&e))?;
    let names = Rc::new(RefCell::new(Vec::new()));
    let input = ColonSafeLocus {
        inner: BufReader::new(file),
        line: Vec::new(),
        position: 0,
        names: Rc::clone(&names),
    };
    let mut records = SeqReader::new(input)
        .collect::<std::result::Result<Vec<Seq>, _>>()
        .map_err(|e| failed(&e))?;
    if records.is_empty() {
        return Err(IndexerError::GenbankParseFailed(format!(
            "no records parsed from {}",
            path.display()
        ))
        .into());
    }
    for (record, original) in records.iter_mut().zip(names.borrow_mut().drain(..)) {
        if original.is_some() {
            record.name = original;
        }
    }
    records.into_iter().map(convert_seq).collect()
}

fn locus_name_bounds(line: &[u8]) -> Option<(usize, usize)> {
    let rest = line.strip_prefix(b"LOCUS")?;
    let offset = line.len() - rest.len();
    let start = offset
        + rest
            .iter()
            .position(|byte| *byte != b' ' && *byte != b'\t')?;
    let end = line[start..]
        .iter()
        .position(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        .map_or(line.len(), |length| start + length);
    Some((start, end))
}

struct ColonSafeLocus<R> {
    inner: R,
    line: Vec<u8>,
    position: usize,
    names: Rc<RefCell<Vec<Option<String>>>>,
}

impl<R: BufRead> ColonSafeLocus<R> {
    fn next_line(&mut self) -> std::io::Result<bool> {
        self.line.clear();
        self.position = 0;
        if self.inner.read_until(b'\n', &mut self.line)? == 0 {
            return Ok(false);
        }
        if let Some((start, end)) = locus_name_bounds(&self.line) {
            let name = &mut self.line[start..end];
            let original = name
                .contains(&b':')
                .then(|| String::from_utf8_lossy(name).into_owned());
            if original.is_some() {
                for byte in name.iter_mut().filter(|byte| **byte == b':') {
                    *byte = b'_';
                }
            }
            self.names.borrow_mut().push(original);
        }
        Ok(true)
    }
}

impl<R: BufRead> Read for ColonSafeLocus<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let mut filled = 0;
        while filled < buffer.len() {
            if self.position == self.line.len() && !self.next_line()? {
                break;
            }
            let count = (buffer.len() - filled).min(self.line.len() - self.position);
            buffer[filled..filled + count]
                .copy_from_slice(&self.line[self.position..self.position + count]);
            self.position += count;
            filled += count;
        }
        Ok(filled)
    }
}

fn convert_seq(seq: Seq) -> Result<ParsedRecord> {
    let name = seq.name.clone().unwrap_or_else(|| "unnamed".to_string());
    let length = seq.len.unwrap_or(seq.seq.len()) as u64;
    let topology = match seq.topology {
        GbTopology::Linear => Topology::Linear,
        GbTopology::Circular => Topology::Circular,
    };
    let features: Vec<Feature> = seq
        .features
        .into_iter()
        .map(|f| convert_feature(f, length))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    Ok(ParsedRecord {
        name,
        length,
        topology,
        features,
        sequence: seq.seq,
    })
}

fn convert_feature(f: GbFeature, record_length: u64) -> Result<Option<Feature>> {
    let location_string = format!("{}", f.location);

    if location_uses_external(&f.location) {
        let mut ctx = BTreeMap::new();
        ctx.insert(
            "feature_type".to_string(),
            serde_json::Value::String(f.kind.to_string()),
        );
        ctx.insert(
            "location".to_string(),
            serde_json::Value::String(location_string.clone()),
        );
        error::warning_json_stderr(
            "FEATURE_SKIPPED_EXTERNAL_LOCATION",
            "feature references an external accession; skipping (cannot resolve cross-record coords)",
            &ctx,
        );
        return Ok(None);
    }

    let (strand, intervals) = decompose_location(&f.location, record_length)?;
    if intervals.is_empty() {
        return Err(IndexerError::GenbankParseFailed(format!(
            "feature has zero intervals (location={})",
            location_string
        ))
        .into());
    }
    let qualifiers = f
        .qualifiers
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    Ok(Some(Feature {
        feature_type: f.kind.to_string(),
        strand,
        intervals,
        qualifiers,
        location_string,
    }))
}

fn location_uses_external(loc: &Location) -> bool {
    match loc {
        Location::External(_, _) => true,
        Location::Complement(inner) => location_uses_external(inner),
        Location::Join(parts)
        | Location::Order(parts)
        | Location::Bond(parts)
        | Location::OneOf(parts) => parts.iter().any(location_uses_external),
        Location::Range(_, _) | Location::Between(_, _) | Location::Gap(_) => false,
    }
}

pub fn decompose_location(loc: &Location, record_length: u64) -> Result<(Strand, Vec<Interval>)> {
    match loc {
        Location::Range((start, _), (end, _)) => {
            let s_gb = *start as u64;
            let e_gb = *end as u64;
            if *end >= *start {
                let s = s_gb.saturating_add(1);
                let e = e_gb;
                Ok((Strand::Plus, vec![Interval { start: s, end: e }]))
            } else {
                if record_length == 0 {
                    return Err(IndexerError::GenbankParseFailed(
                        "bare-range origin wrap requires non-zero record length".into(),
                    )
                    .into());
                }
                let s = s_gb.saturating_add(1);
                if s > record_length {
                    return Err(IndexerError::GenbankParseFailed(format!(
                        "wrap-range start ({}) > record length ({})",
                        s, record_length
                    ))
                    .into());
                }
                Ok((
                    Strand::Plus,
                    vec![
                        Interval {
                            start: s,
                            end: record_length,
                        },
                        Interval {
                            start: 1,
                            end: e_gb,
                        },
                    ],
                ))
            }
        }
        Location::Complement(inner) => {
            let (_, intervals) = decompose_location(inner, record_length)?;
            let reversed: Vec<Interval> = intervals.into_iter().rev().collect();
            Ok((Strand::Minus, reversed))
        }
        Location::Join(parts) | Location::Order(parts) => {
            let mut all_intervals = Vec::with_capacity(parts.len());
            let mut strand = Strand::Plus;
            for part in parts {
                let (s, ivs) = decompose_location(part, record_length)?;
                if matches!(s, Strand::Minus) {
                    strand = Strand::Minus;
                }
                all_intervals.extend(ivs);
            }
            Ok((strand, all_intervals))
        }
        Location::Between(_, _)
        | Location::Bond(_)
        | Location::OneOf(_)
        | Location::External(_, _)
        | Location::Gap(_) => Err(IndexerError::GenbankParseFailed(format!(
            "unsupported Location variant: {:?}",
            loc
        ))
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gb_io::seq::{After, Before};

    fn range(start: i64, end: i64) -> Location {
        Location::Range((start, Before(false)), (end, After(false)))
    }

    const LEN: u64 = 500;

    #[test]
    fn decompose_simple_range() {
        let (strand, iv) = decompose_location(&range(0, 50), LEN).unwrap();
        assert_eq!(strand, Strand::Plus);
        assert_eq!(iv, vec![Interval { start: 1, end: 50 }]);
    }

    #[test]
    fn decompose_complement_range() {
        let (strand, iv) =
            decompose_location(&Location::Complement(Box::new(range(0, 50))), LEN).unwrap();
        assert_eq!(strand, Strand::Minus);
        assert_eq!(iv, vec![Interval { start: 1, end: 50 }]);
    }

    #[test]
    fn decompose_join_two_parts() {
        let loc = Location::Join(vec![range(0, 50), range(450, 500)]);
        let (strand, iv) = decompose_location(&loc, LEN).unwrap();
        assert_eq!(strand, Strand::Plus);
        assert_eq!(
            iv,
            vec![
                Interval { start: 1, end: 50 },
                Interval {
                    start: 451,
                    end: 500
                }
            ]
        );
    }

    #[test]
    fn decompose_complement_join_reverses_intervals() {
        let inner = Location::Join(vec![range(0, 50), range(450, 500)]);
        let loc = Location::Complement(Box::new(inner));
        let (strand, iv) = decompose_location(&loc, LEN).unwrap();
        assert_eq!(strand, Strand::Minus);
        assert_eq!(
            iv,
            vec![
                Interval {
                    start: 451,
                    end: 500
                },
                Interval { start: 1, end: 50 }
            ]
        );
    }

    #[test]
    fn decompose_bare_range_origin_wrap() {
        let wrap = Location::Range((3298, Before(false)), (678, After(false)));
        let (strand, iv) = decompose_location(&wrap, 3412).unwrap();
        assert_eq!(strand, Strand::Plus);
        assert_eq!(
            iv,
            vec![
                Interval {
                    start: 3299,
                    end: 3412
                },
                Interval { start: 1, end: 678 }
            ]
        );
    }

    #[test]
    fn decompose_complement_bare_range_origin_wrap() {
        let wrap = Location::Range((3298, Before(false)), (678, After(false)));
        let loc = Location::Complement(Box::new(wrap));
        let (strand, iv) = decompose_location(&loc, 3412).unwrap();
        assert_eq!(strand, Strand::Minus);
        assert_eq!(
            iv,
            vec![
                Interval { start: 1, end: 678 },
                Interval {
                    start: 3299,
                    end: 3412
                }
            ]
        );
    }

    #[test]
    fn decompose_bare_range_wrap_requires_length() {
        let wrap = Location::Range((3298, Before(false)), (678, After(false)));
        let err = decompose_location(&wrap, 0).unwrap_err();
        assert!(err.to_string().contains("origin wrap"), "got: {}", err);
    }
}
