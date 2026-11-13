"""
Primer Design Tool using Primer3

Provides endpoints for designing PCR primers using the industry-standard
Primer3 library. This is a "hook tool" - designed to work without authentication
for immediate value to scientists.

Supports multiple applications with appropriate parameter presets:
- Basic PCR: Standard amplification
- Sequencing: Sanger sequencing primers
- qPCR: Short amplicons for quantitative PCR
- Colony PCR: Screening primers
- Gibson/HiFi: PBS design for assembly (wizard adds overhangs)
- Golden Gate: PBS design for GG assembly (wizard adds RE sites)
- SDM: Site-directed mutagenesis primers
- RE Cloning: Traditional restriction enzyme cloning
"""

import asyncio
import contextlib
from enum import Enum
from typing import Any, Optional

import primer3
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from ..concurrency.pools import get_pool_manager
from ..concurrency.refusals import QueueRefusal, QueueRefusalResponse
from ..concurrency.schema import PoolName

router = APIRouter(prefix="/api/tools/primers", tags=["Primer Design"])

MAX_PRIMER_DESIGN_TEMPLATE_BP = 50_000


class PrimerApplication(str, Enum):
    """Supported primer design applications."""

    PCR = "pcr"
    SEQUENCING = "sequencing"
    QPCR = "qpcr"
    COLONY_PCR = "colony_pcr"
    GIBSON = "gibson"
    GOLDEN_GATE = "golden_gate"
    SDM = "sdm"
    RE_CLONING = "re_cloning"


APPLICATION_PRESETS = {
    PrimerApplication.PCR: {
        "primer_min_size": 18,
        "primer_opt_size": 20,
        "primer_max_size": 25,
        "primer_min_tm": 55.0,
        "primer_opt_tm": 60.0,
        "primer_max_tm": 65.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 100,
        "product_max_size": 1000,
    },
    PrimerApplication.SEQUENCING: {
        "primer_min_size": 18,
        "primer_opt_size": 20,
        "primer_max_size": 24,
        "primer_min_tm": 55.0,
        "primer_opt_tm": 60.0,
        "primer_max_tm": 65.0,
        "primer_min_gc": 45.0,
        "primer_max_gc": 55.0,
        "product_min_size": 100,
        "product_max_size": 1000,
    },
    PrimerApplication.QPCR: {
        "primer_min_size": 18,
        "primer_opt_size": 20,
        "primer_max_size": 25,
        "primer_min_tm": 59.0,
        "primer_opt_tm": 60.0,
        "primer_max_tm": 63.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 60,
        "product_max_size": 150,
    },
    PrimerApplication.COLONY_PCR: {
        "primer_min_size": 18,
        "primer_opt_size": 20,
        "primer_max_size": 25,
        "primer_min_tm": 58.0,
        "primer_opt_tm": 60.0,
        "primer_max_tm": 65.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 500,
        "product_max_size": 2000,
    },
    PrimerApplication.GIBSON: {
        "primer_min_size": 18,
        "primer_opt_size": 22,
        "primer_max_size": 28,
        "primer_min_tm": 55.0,
        "primer_opt_tm": 60.0,
        "primer_max_tm": 65.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 100,
        "product_max_size": 10000,
    },
    PrimerApplication.GOLDEN_GATE: {
        "primer_min_size": 18,
        "primer_opt_size": 20,
        "primer_max_size": 25,
        "primer_min_tm": 52.0,
        "primer_opt_tm": 58.0,
        "primer_max_tm": 62.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 100,
        "product_max_size": 5000,
    },
    PrimerApplication.SDM: {
        "primer_min_size": 25,
        "primer_opt_size": 35,
        "primer_max_size": 45,
        "primer_min_tm": 65.0,
        "primer_opt_tm": 70.0,
        "primer_max_tm": 75.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 100,
        "product_max_size": 10000,
    },
    PrimerApplication.RE_CLONING: {
        "primer_min_size": 18,
        "primer_opt_size": 20,
        "primer_max_size": 25,
        "primer_min_tm": 55.0,
        "primer_opt_tm": 60.0,
        "primer_max_tm": 65.0,
        "primer_min_gc": 40.0,
        "primer_max_gc": 60.0,
        "product_min_size": 100,
        "product_max_size": 5000,
    },
}


class PrimerDesignRequest(BaseModel):
    """Request model for primer design."""

    sequence: str = Field(
        ...,
        min_length=50,
        max_length=MAX_PRIMER_DESIGN_TEMPLATE_BP,
        description="Template DNA sequence (50-50,000bp)",
    )
    application: PrimerApplication = Field(
        PrimerApplication.PCR,
        description="Application type - determines default parameter presets",
    )
    target_start: Optional[int] = Field(
        None,
        ge=0,
        description="Start position of target region (0-indexed). If not provided, designs primers for entire sequence.",
    )
    target_length: Optional[int] = Field(
        None,
        ge=20,
        description="Length of target region to amplify",
    )
    primer_min_size: Optional[int] = Field(
        None,
        ge=15,
        le=50,
        description="Minimum primer length (default: from application preset)",
    )
    primer_opt_size: Optional[int] = Field(
        None,
        ge=15,
        le=50,
        description="Optimal primer length (default: from application preset)",
    )
    primer_max_size: Optional[int] = Field(
        None,
        ge=15,
        le=50,
        description="Maximum primer length (default: from application preset)",
    )
    primer_min_tm: Optional[float] = Field(
        None, ge=40.0, le=85.0, description="Minimum melting temperature (°C)"
    )
    primer_opt_tm: Optional[float] = Field(
        None, ge=40.0, le=85.0, description="Optimal melting temperature (°C)"
    )
    primer_max_tm: Optional[float] = Field(
        None, ge=40.0, le=85.0, description="Maximum melting temperature (°C)"
    )
    primer_min_gc: Optional[float] = Field(
        None, ge=20.0, le=80.0, description="Minimum GC content (%)"
    )
    primer_max_gc: Optional[float] = Field(
        None, ge=20.0, le=80.0, description="Maximum GC content (%)"
    )
    product_min_size: Optional[int] = Field(
        None, ge=50, description="Minimum PCR product size"
    )
    product_max_size: Optional[int] = Field(
        None, ge=50, description="Maximum PCR product size"
    )
    num_return: int = Field(
        5, ge=1, le=20, description="Number of primer pairs to return"
    )

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, v: str) -> str:
        """Validate and clean DNA sequence."""
        cleaned = "".join(v.split()).upper()
        valid_bases = set("ATCGN")
        invalid = set(cleaned) - valid_bases
        if invalid:
            raise ValueError(
                f"Invalid characters in sequence: {invalid}. Only A, T, C, G, N allowed."
            )
        return cleaned


class PrimerResult(BaseModel):
    """Individual primer result."""

    sequence: str = Field(..., description="Primer sequence (5' to 3')")
    start: int = Field(..., description="Start position in template (0-indexed)")
    length: int = Field(..., description="Primer length in bp")
    tm: float = Field(..., description="Melting temperature (°C)")
    gc_percent: float = Field(..., description="GC content (%)")
    any_th: float = Field(
        ..., description="Self-complementarity score (lower is better)"
    )
    end_th: float = Field(
        ..., description="3' end self-complementarity (lower is better)"
    )
    hairpin_th: float = Field(
        ..., description="Hairpin formation potential (lower is better)"
    )


class PrimerPairResult(BaseModel):
    """A pair of primers (forward and reverse)."""

    forward: PrimerResult
    reverse: PrimerResult
    product_size: int = Field(..., description="Expected PCR product size in bp")
    pair_any_th: float = Field(
        ..., description="Primer pair complementarity (lower is better)"
    )
    pair_end_th: float = Field(
        ..., description="3' end complementarity between primers (lower is better)"
    )
    penalty: float = Field(..., description="Overall penalty score (lower is better)")


class PrimerDesignResponse(BaseModel):
    """Response model for primer design."""

    success: bool
    message: str
    application: PrimerApplication
    primer_pairs: list[PrimerPairResult] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    sequence_length: int
    target_region: Optional[tuple[int, int]] = None
    params_used: dict = Field(default_factory=dict)


def get_effective_params(request: PrimerDesignRequest) -> dict:
    """
    Get effective parameters by merging request overrides with application presets.

    User-provided values override presets. None values use presets.
    """
    preset = APPLICATION_PRESETS[request.application]

    return {
        "primer_min_size": (
            request.primer_min_size
            if request.primer_min_size is not None
            else preset["primer_min_size"]
        ),
        "primer_opt_size": (
            request.primer_opt_size
            if request.primer_opt_size is not None
            else preset["primer_opt_size"]
        ),
        "primer_max_size": (
            request.primer_max_size
            if request.primer_max_size is not None
            else preset["primer_max_size"]
        ),
        "primer_min_tm": (
            request.primer_min_tm
            if request.primer_min_tm is not None
            else preset["primer_min_tm"]
        ),
        "primer_opt_tm": (
            request.primer_opt_tm
            if request.primer_opt_tm is not None
            else preset["primer_opt_tm"]
        ),
        "primer_max_tm": (
            request.primer_max_tm
            if request.primer_max_tm is not None
            else preset["primer_max_tm"]
        ),
        "primer_min_gc": (
            request.primer_min_gc
            if request.primer_min_gc is not None
            else preset["primer_min_gc"]
        ),
        "primer_max_gc": (
            request.primer_max_gc
            if request.primer_max_gc is not None
            else preset["primer_max_gc"]
        ),
        "product_min_size": (
            request.product_min_size
            if request.product_min_size is not None
            else preset["product_min_size"]
        ),
        "product_max_size": (
            request.product_max_size
            if request.product_max_size is not None
            else preset["product_max_size"]
        ),
    }


async def _run_admitted_primer3(
    seq_args: dict[str, Any],
    global_args: dict[str, Any],
    admitted: asyncio.Event,
) -> dict[str, Any]:
    """Run one physical Primer3 call without blocking or escaping CPU ownership."""
    pool = get_pool_manager().get(PoolName.CPU_SLOW.value)
    async with pool.slot():
        admitted.set()
        return await asyncio.to_thread(primer3.design_primers, seq_args, global_args)


def _consume_detached_primer3_outcome(
    task: asyncio.Task[dict[str, Any]],
) -> None:
    """Retrieve an outcome after a cancelled HTTP caller has detached."""
    with contextlib.suppress(asyncio.CancelledError, Exception):
        task.exception()


@router.post(
    "/design",
    response_model=PrimerDesignResponse,
    operation_id="designPrimers",
    responses={
        429: {
            "model": QueueRefusalResponse,
            "description": "Primer-design CPU capacity is temporarily unavailable.",
        }
    },
)
async def design_primers(
    request: PrimerDesignRequest,
) -> PrimerDesignResponse | JSONResponse:
    """
    Design PCR primers for a given DNA sequence.

    Uses Primer3 (the gold standard for primer design) to find optimal
    primer pairs that meet the specified criteria.

    The `application` parameter selects default presets appropriate for:
    - pcr: Standard PCR amplification
    - sequencing: Sanger sequencing primers
    - qpcr: Short amplicons for quantitative PCR
    - colony_pcr: Screening/verification primers
    - gibson: PBS for Gibson/NEBuilder assembly (wizard adds overhangs)
    - golden_gate: PBS for Golden Gate assembly (wizard adds RE sites)
    - sdm: Site-directed mutagenesis (longer primers, higher Tm)
    - re_cloning: Traditional restriction enzyme cloning

    Individual parameters can override presets when provided.

    Returns up to `num_return` primer pairs sorted by quality score.
    """
    sequence = request.sequence
    seq_len = len(sequence)

    params = get_effective_params(request)

    if (request.target_start is None) != (request.target_length is None):
        raise HTTPException(
            status_code=400,
            detail="target_start and target_length must be provided together",
        )

    target_region: Optional[tuple[int, int]] = None
    if request.target_start is not None and request.target_length is not None:
        target_start = request.target_start
        target_length = request.target_length
        if target_start + target_length > seq_len:
            raise HTTPException(
                status_code=400,
                detail=f"Target region extends beyond sequence length ({seq_len}bp)",
            )
        target_region = (target_start, target_length)
        included_region = [target_start, target_length]
    else:
        included_region = None

    seq_args = {
        "SEQUENCE_ID": "user_sequence",
        "SEQUENCE_TEMPLATE": sequence,
    }

    if included_region:
        seq_args["SEQUENCE_TARGET"] = included_region

    global_args = {
        "PRIMER_MIN_SIZE": params["primer_min_size"],
        "PRIMER_OPT_SIZE": params["primer_opt_size"],
        "PRIMER_MAX_SIZE": params["primer_max_size"],
        "PRIMER_MIN_TM": params["primer_min_tm"],
        "PRIMER_OPT_TM": params["primer_opt_tm"],
        "PRIMER_MAX_TM": params["primer_max_tm"],
        "PRIMER_MIN_GC": params["primer_min_gc"],
        "PRIMER_MAX_GC": params["primer_max_gc"],
        "PRIMER_PRODUCT_SIZE_RANGE": [
            [params["product_min_size"], params["product_max_size"]]
        ],
        "PRIMER_NUM_RETURN": request.num_return,
        "PRIMER_TM_FORMULA": 1,
        "PRIMER_SALT_CORRECTIONS": 1,
        "PRIMER_SALT_MONOVALENT": 50.0,
        "PRIMER_SALT_DIVALENT": 1.5,
        "PRIMER_DNTP_CONC": 0.6,
        "PRIMER_DNA_CONC": 50.0,
    }

    admitted = asyncio.Event()
    admitted_task = asyncio.create_task(
        _run_admitted_primer3(seq_args, global_args, admitted)
    )
    admitted_task.add_done_callback(_consume_detached_primer3_outcome)
    try:
        results = await asyncio.shield(admitted_task)
    except QueueRefusal as exc:
        return JSONResponse(
            status_code=429,
            content=exc.to_response(),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        )
    except asyncio.CancelledError:
        if not admitted.is_set():
            admitted_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await admitted_task
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Primer3 error: {str(e)}",
        ) from e

    primer_pairs = []
    warnings = []

    if "PRIMER_WARNING" in results:
        warnings.append(results["PRIMER_WARNING"])
    if "PRIMER_ERROR" in results:
        return PrimerDesignResponse(
            success=False,
            message=f"Primer3 error: {results['PRIMER_ERROR']}",
            application=request.application,
            primer_pairs=[],
            warnings=warnings,
            sequence_length=seq_len,
            target_region=target_region,
            params_used=params,
        )

    num_returned = results.get("PRIMER_PAIR_NUM_RETURNED", 0)

    for i in range(num_returned):
        try:
            fwd_seq = results.get(f"PRIMER_LEFT_{i}_SEQUENCE", "")
            fwd_pos = results.get(f"PRIMER_LEFT_{i}", (0, 0))
            fwd_tm = results.get(f"PRIMER_LEFT_{i}_TM", 0.0)
            fwd_gc = results.get(f"PRIMER_LEFT_{i}_GC_PERCENT", 0.0)
            fwd_any = results.get(f"PRIMER_LEFT_{i}_SELF_ANY_TH", 0.0)
            fwd_end = results.get(f"PRIMER_LEFT_{i}_SELF_END_TH", 0.0)
            fwd_hairpin = results.get(f"PRIMER_LEFT_{i}_HAIRPIN_TH", 0.0)

            rev_seq = results.get(f"PRIMER_RIGHT_{i}_SEQUENCE", "")
            rev_pos = results.get(f"PRIMER_RIGHT_{i}", (0, 0))
            rev_tm = results.get(f"PRIMER_RIGHT_{i}_TM", 0.0)
            rev_gc = results.get(f"PRIMER_RIGHT_{i}_GC_PERCENT", 0.0)
            rev_any = results.get(f"PRIMER_RIGHT_{i}_SELF_ANY_TH", 0.0)
            rev_end = results.get(f"PRIMER_RIGHT_{i}_SELF_END_TH", 0.0)
            rev_hairpin = results.get(f"PRIMER_RIGHT_{i}_HAIRPIN_TH", 0.0)

            product_size = results.get(f"PRIMER_PAIR_{i}_PRODUCT_SIZE", 0)
            pair_any = results.get(f"PRIMER_PAIR_{i}_COMPL_ANY_TH", 0.0)
            pair_end = results.get(f"PRIMER_PAIR_{i}_COMPL_END_TH", 0.0)
            penalty = results.get(f"PRIMER_PAIR_{i}_PENALTY", 0.0)

            primer_pairs.append(
                PrimerPairResult(
                    forward=PrimerResult(
                        sequence=fwd_seq,
                        start=fwd_pos[0],
                        length=fwd_pos[1],
                        tm=round(fwd_tm, 1),
                        gc_percent=round(fwd_gc, 1),
                        any_th=round(fwd_any, 1),
                        end_th=round(fwd_end, 1),
                        hairpin_th=round(fwd_hairpin, 1),
                    ),
                    reverse=PrimerResult(
                        sequence=rev_seq,
                        start=rev_pos[0],
                        length=rev_pos[1],
                        tm=round(rev_tm, 1),
                        gc_percent=round(rev_gc, 1),
                        any_th=round(rev_any, 1),
                        end_th=round(rev_end, 1),
                        hairpin_th=round(rev_hairpin, 1),
                    ),
                    product_size=product_size,
                    pair_any_th=round(pair_any, 1),
                    pair_end_th=round(pair_end, 1),
                    penalty=round(penalty, 2),
                )
            )
        except (KeyError, TypeError) as e:
            warnings.append(f"Could not parse primer pair {i}: {str(e)}")

    if not primer_pairs:
        return PrimerDesignResponse(
            success=False,
            message="No suitable primer pairs found. Try adjusting parameters (wider Tm range, different product size, etc.)",
            application=request.application,
            primer_pairs=[],
            warnings=warnings,
            sequence_length=seq_len,
            target_region=target_region,
            params_used=params,
        )

    return PrimerDesignResponse(
        success=True,
        message=f"Found {len(primer_pairs)} primer pair(s)",
        application=request.application,
        primer_pairs=primer_pairs,
        warnings=warnings,
        sequence_length=seq_len,
        target_region=target_region,
        params_used=params,
    )


@router.get("/applications", operation_id="getPrimerApplications")
async def get_applications() -> dict:
    """
    Get available primer design applications and their default presets.

    Useful for populating application selector dropdowns and showing
    default parameter values in the UI.
    """
    return {
        "applications": [
            {
                "id": app.value,
                "name": app.name.replace("_", " ").title(),
                "description": _get_app_description(app),
                "presets": APPLICATION_PRESETS[app],
            }
            for app in PrimerApplication
        ]
    }


def _get_app_description(app: PrimerApplication) -> str:
    """Get human-readable description for each application."""
    descriptions = {
        PrimerApplication.PCR: "Standard PCR amplification of a target region",
        PrimerApplication.SEQUENCING: "Sanger sequencing primers with optimal read quality",
        PrimerApplication.QPCR: "Short amplicons (60-150bp) for quantitative real-time PCR",
        PrimerApplication.COLONY_PCR: "Screening primers for colony verification",
        PrimerApplication.GIBSON: "Template-binding sequences for Gibson/NEBuilder assembly",
        PrimerApplication.GOLDEN_GATE: "Template-binding sequences for Golden Gate assembly",
        PrimerApplication.SDM: "Site-directed mutagenesis with longer primers and higher Tm",
        PrimerApplication.RE_CLONING: "Traditional restriction enzyme-based cloning",
    }
    return descriptions.get(app, "")


@router.get("/applications/{application}", operation_id="getPrimerApplicationPreset")
async def get_application_preset(application: PrimerApplication) -> dict:
    """
    Get default preset for a specific application.
    """
    return {
        "application": application.value,
        "name": application.name.replace("_", " ").title(),
        "description": _get_app_description(application),
        "presets": APPLICATION_PRESETS[application],
    }


@router.post("/analyze", operation_id="analyzePrimer")
async def analyze_primer(sequence: str) -> dict:
    """
    Analyze a single primer sequence.

    Returns Tm, GC%, and potential issues (hairpins, self-dimers).
    Useful for checking existing primers or custom designs.
    """
    cleaned = "".join(sequence.split()).upper()
    valid_bases = set("ATCG")
    invalid = set(cleaned) - valid_bases
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid characters: {invalid}. Only A, T, C, G allowed.",
        )

    if len(cleaned) < 10:
        raise HTTPException(
            status_code=400,
            detail="Primer too short. Minimum 10bp required.",
        )

    if len(cleaned) > 50:
        raise HTTPException(
            status_code=400,
            detail="Primer too long. Maximum 50bp allowed.",
        )

    tm = primer3.calc_tm(
        cleaned,
        mv_conc=50.0,
        dv_conc=1.5,
        dntp_conc=0.6,
        dna_conc=50.0,
        tm_method="santalucia",
        salt_corrections_method="santalucia",
    )

    gc_count = cleaned.count("G") + cleaned.count("C")
    gc_percent = (gc_count / len(cleaned)) * 100

    hairpin = primer3.calc_hairpin(
        cleaned,
        mv_conc=50.0,
        dv_conc=1.5,
        dntp_conc=0.6,
        dna_conc=50.0,
    )

    homodimer = primer3.calc_homodimer(
        cleaned,
        mv_conc=50.0,
        dv_conc=1.5,
        dntp_conc=0.6,
        dna_conc=50.0,
    )

    warnings = []
    if gc_percent < 40:
        warnings.append(f"Low GC content ({gc_percent:.1f}%) - may have weak binding")
    if gc_percent > 60:
        warnings.append(
            f"High GC content ({gc_percent:.1f}%) - may have secondary structures"
        )
    if tm < 55:
        warnings.append(f"Low Tm ({tm:.1f}°C) - may have low specificity")
    if tm > 65:
        warnings.append(f"High Tm ({tm:.1f}°C) - may require optimization")
    if hairpin.tm > 45:
        warnings.append(f"Potential hairpin formation (Tm={hairpin.tm:.1f}°C)")
    if homodimer.tm > 45:
        warnings.append(f"Potential self-dimer formation (Tm={homodimer.tm:.1f}°C)")

    three_prime = cleaned[-5:] if len(cleaned) >= 5 else cleaned
    gc_clamp = three_prime.count("G") + three_prime.count("C")
    if gc_clamp < 1:
        warnings.append("Weak 3' end - no GC in last 5 bases")
    if gc_clamp > 3:
        warnings.append("Strong 3' GC clamp - may increase mispriming")

    return {
        "sequence": cleaned,
        "length": len(cleaned),
        "tm": round(tm, 1),
        "gc_percent": round(gc_percent, 1),
        "hairpin_tm": round(hairpin.tm, 1) if hairpin.tm > 0 else 0.0,
        "homodimer_tm": round(homodimer.tm, 1) if homodimer.tm > 0 else 0.0,
        "warnings": warnings,
        "quality": (
            "good" if len(warnings) == 0 else ("fair" if len(warnings) <= 2 else "poor")
        ),
    }
