
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Strand {
    Plus,
    Minus,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Topology {
    Linear,
    Circular,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Interval {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Feature {
    pub feature_type: String,
    pub strand: Strand,
    pub intervals: Vec<Interval>,
    pub qualifiers: Vec<(String, Option<String>)>,
    pub location_string: String,
}

impl Feature {
    pub fn start(&self) -> u64 {
        self.intervals.iter().map(|i| i.start).min().unwrap_or(0)
    }

    pub fn end(&self) -> u64 {
        self.intervals.iter().map(|i| i.end).max().unwrap_or(0)
    }

    pub fn qualifier(&self, key: &str) -> Option<&str> {
        self.qualifiers
            .iter()
            .find_map(|(k, v)| if k == key { v.as_deref() } else { None })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ParsedRecord {
    pub name: String,
    pub length: u64,
    pub topology: Topology,
    pub features: Vec<Feature>,
    #[serde(skip)]
    pub sequence: Vec<u8>,
}
