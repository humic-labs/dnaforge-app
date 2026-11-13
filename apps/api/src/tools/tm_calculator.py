"""
Nearest-Neighbor Melting Temperature Calculator

Implements the SantaLucia (1998) unified nearest-neighbor thermodynamic
parameters for DNA/DNA duplex Tm calculation.

Port of the TypeScript implementation in apps/desktop/src/features/design/algorithms/tm-calculator.ts.
Both implementations must produce identical results for the same inputs.

References:
- SantaLucia J Jr. (1998) PNAS 95:1460-1465
- SantaLucia J Jr. & Hicks D. (2004) Annu Rev Biophys Biomol Struct 33:415-440
- Owczarzy R. et al. (2004) Biochemistry 43:3537-3554 (salt corrections)
"""

import math
import re

NN_PARAMS: dict[str, tuple[float, float]] = {
    "AA/TT": (-7.9, -22.2),
    "AT/TA": (-7.2, -20.4),
    "TA/AT": (-7.2, -21.3),
    "CA/GT": (-8.5, -22.7),
    "GT/CA": (-8.4, -22.4),
    "CT/GA": (-7.8, -21.0),
    "GA/CT": (-8.2, -22.2),
    "CG/GC": (-10.6, -27.2),
    "GC/CG": (-9.8, -24.4),
    "GG/CC": (-8.0, -19.9),
}

INIT_GC = (0.1, -2.8)
INIT_AT = (2.3, 4.1)
SYMMETRY = (0, -1.4)

R = 1.987

COMPLEMENT = str.maketrans("ATGC", "TACG")


def _get_nn_key(base1: str, base2: str) -> str | None:
    """Get the nearest-neighbor key for a dinucleotide pair."""
    b1, b2 = base1.upper(), base2.upper()
    c1, c2 = b1.translate(COMPLEMENT), b2.translate(COMPLEMENT)

    for key in [
        f"{b1}{b2}/{c1}{c2}",
        f"{c1}{c2}/{b1}{b2}",
        f"{c2}{c1}/{b2}{b1}",
        f"{b2}{b1}/{c2}{c1}",
    ]:
        if key in NN_PARAMS:
            return key
    return None


def _is_self_complementary(sequence: str) -> bool:
    """Check if a sequence is self-complementary (palindromic)."""
    upper = sequence.upper()
    n = len(upper)
    for i in range(n):
        if upper[i] != upper[n - 1 - i].translate(COMPLEMENT):
            return False
    return True


def calculate_tm_nn(
    sequence: str,
    primer_conc_nm: float = 250.0,
    na_conc_mm: float = 50.0,
) -> float:
    """
    Calculate melting temperature using nearest-neighbor thermodynamics.

    Uses SantaLucia (1998) unified parameters with salt correction
    applied to dS as per Owczarzy et al. (2004):
        dS(Na) = dS(1M) + 0.368 * (N-1) * ln([Na+])

    Args:
        sequence: DNA sequence (5' to 3'), only ATGC characters used
        primer_conc_nm: Primer concentration in nM (default 250)
        na_conc_mm: Monovalent cation concentration in mM (default 50)

    Returns:
        Melting temperature in °C, rounded to 1 decimal place
    """
    upper = re.sub(r"[^ATGC]", "", sequence.upper())

    if len(upper) < 6:
        return calculate_tm_wallace(upper)

    dH = 0.0
    dS = 0.0

    for i in range(len(upper) - 1):
        key = _get_nn_key(upper[i], upper[i + 1])
        if key and key in NN_PARAMS:
            dH += NN_PARAMS[key][0]
            dS += NN_PARAMS[key][1]

    first_base = upper[0]
    last_base = upper[-1]

    if first_base in ("G", "C"):
        dH += INIT_GC[0]
        dS += INIT_GC[1]
    else:
        dH += INIT_AT[0]
        dS += INIT_AT[1]

    if last_base in ("G", "C"):
        dH += INIT_GC[0]
        dS += INIT_GC[1]
    else:
        dH += INIT_AT[0]
        dS += INIT_AT[1]

    if _is_self_complementary(upper):
        dH += SYMMETRY[0]
        dS += SYMMETRY[1]

    Na = na_conc_mm / 1000.0
    N = len(upper)
    if Na > 0:
        dS += 0.368 * (N - 1) * math.log(Na)

    Ct = primer_conc_nm * 1e-9

    conc_term = Ct if _is_self_complementary(upper) else Ct / 4

    dH_cal = dH * 1000
    Tm = dH_cal / (dS + R * math.log(conc_term)) - 273.15

    return round(Tm, 1)


def calculate_tm_wallace(sequence: str) -> float:
    """
    Estimate melting temperature using the Wallace rule.
    Tm = 2(A+T) + 4(G+C)

    Rough approximation, only accurate for oligos < 14bp.
    """
    upper = sequence.upper()
    gc = sum(1 for b in upper if b in ("G", "C"))
    at = sum(1 for b in upper if b in ("A", "T"))
    return float(2 * at + 4 * gc)


def calculate_gc_content(sequence: str) -> float:
    """Calculate GC content as a percentage (0-100)."""
    upper = re.sub(r"[^ATGC]", "", sequence.upper())
    if len(upper) == 0:
        return 0.0
    gc = sum(1 for b in upper if b in ("G", "C"))
    return round(gc / len(upper) * 100, 1)
