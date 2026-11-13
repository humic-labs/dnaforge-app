"""Compatibility names for the former provider-specific NVIDIA binding.

NVIDIA now selects the reusable NVCF driver from its v2 manifest. Keep these
exports for downstream imports while callers migrate to ``compute.nvcf_binding``.
"""

from ..nvcf_binding import (
    POLL_SECONDS_HEADER,
    REQUEST_ID_HEADER,
    NvcfBinding,
)

NvidiaNimBinding = NvcfBinding
REQID_HEADER = REQUEST_ID_HEADER

__all__ = ["NvidiaNimBinding", "POLL_SECONDS_HEADER", "REQID_HEADER"]
