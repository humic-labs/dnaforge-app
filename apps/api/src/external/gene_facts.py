"""Small, exact-identifier lookups of public gene/protein annotations."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Literal

import httpx
from pydantic import BaseModel

from .public_http import PublicHttpBoundary

Database = Literal["ncbi", "ensembl", "uniprot"]
_PATTERNS = {
    "ncbi": re.compile(r"[1-9][0-9]{0,11}"),
    "ensembl": re.compile(r"ENS[A-Z]*G[0-9]{11}"),
    "uniprot": re.compile(
        r"(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})"
    ),
}
_HOSTS = frozenset({"eutils.ncbi.nlm.nih.gov", "rest.ensembl.org", "rest.uniprot.org"})


class GeneFact(BaseModel):
    label: str
    value: str


class GeneFacts(BaseModel):
    database: Database
    identifier: str
    url: str
    facts: list[GeneFact]


class GeneFactsNotFound(Exception):
    pass


def normalize_facts(
    database: Database, identifier: str, data: dict[str, Any]
) -> GeneFacts:
    facts: list[GeneFact] = []

    def add(label: str, value: Any) -> None:
        if isinstance(value, (str, int)) and str(value).strip():
            facts.append(GeneFact(label=label, value=str(value).strip()))

    if database == "ncbi":
        record = data.get("result", {}).get(identifier)
        if (
            not isinstance(record, dict)
            or str(record.get("uid")) != identifier
            or record.get("error")
        ):
            raise GeneFactsNotFound()
        url = f"https://www.ncbi.nlm.nih.gov/gene/{identifier}"
        for label, key in [
            ("Gene", "name"),
            ("Description", "description"),
            ("Summary", "summary"),
            ("Aliases", "otheraliases"),
            ("Chromosome", "chromosome"),
            ("Map location", "maplocation"),
        ]:
            add(label, record.get(key))
        add("Organism", record.get("organism", {}).get("scientificname"))
    elif database == "ensembl":
        if data.get("id") != identifier or data.get("object_type") != "Gene":
            raise GeneFactsNotFound()
        url = f"https://www.ensembl.org/id/{identifier}"
        for label, key in [
            ("Gene", "display_name"),
            ("Description", "description"),
            ("Species", "species"),
            ("Biotype", "biotype"),
            ("Assembly", "assembly_name"),
            ("Chromosome", "seq_region_name"),
        ]:
            add(label, data.get(key))
    else:
        if data.get("primaryAccession") != identifier:
            raise GeneFactsNotFound()
        url = f"https://www.uniprot.org/uniprotkb/{identifier}/entry"
        add(
            "Protein",
            data.get("proteinDescription", {})
            .get("recommendedName", {})
            .get("fullName", {})
            .get("value"),
        )
        add("Organism", data.get("organism", {}).get("scientificName"))
        add("Review status", data.get("entryType"))
        for gene in data.get("genes", []):
            add("Gene", gene.get("geneName", {}).get("value"))
        for comment in data.get("comments", []):
            if comment.get("commentType") == "FUNCTION":
                for item in comment.get("texts", []):
                    add("Function", item.get("value"))
    return GeneFacts(database=database, identifier=identifier, url=url, facts=facts)


async def fetch_gene_facts(database: Database, identifier: str) -> GeneFacts:
    if database not in _PATTERNS or not _PATTERNS[database].fullmatch(identifier):
        raise ValueError("An exact database identifier is required")
    urls = {
        "ncbi": f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id={identifier}&retmode=json",
        "ensembl": f"https://rest.ensembl.org/lookup/id/{identifier}",
        "uniprot": f"https://rest.uniprot.org/uniprotkb/{identifier}.json",
    }
    async with asyncio.timeout(20), httpx.AsyncClient(trust_env=False) as client:
        boundary = PublicHttpBoundary(client, allowed_hosts=_HOSTS)
        response, _ = await boundary.open_get(
            urls[database],
            accept="application/json",
            user_agent="DNAForge/1.0",
            timeout=httpx.Timeout(15, connect=5),
        )
        try:
            if response.status_code == 404:
                raise GeneFactsNotFound()
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > 2 * 1024 * 1024:
                    raise ValueError("Database response is too large")
            data = json.loads(content)
            if not isinstance(data, dict):
                raise ValueError("Invalid database response")
            return normalize_facts(database, identifier, data)
        finally:
            await response.aclose()
