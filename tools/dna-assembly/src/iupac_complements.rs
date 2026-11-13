#[inline]
pub(super) fn complement(base: u8) -> u8 {
    match base.to_ascii_uppercase() {
        b'A' => b'T',
        b'B' => b'V',
        b'C' => b'G',
        b'D' => b'H',
        b'G' => b'C',
        b'H' => b'D',
        b'K' => b'M',
        b'M' => b'K',
        b'N' => b'N',
        b'R' => b'Y',
        b'S' => b'S',
        b'T' => b'A',
        b'U' => b'A',
        b'V' => b'B',
        b'W' => b'W',
        b'Y' => b'R',
        _ => b'N',
    }
}
