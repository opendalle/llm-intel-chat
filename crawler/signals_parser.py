"""
signals_parser.py — NEXUS ASIA CRE Intelligence Platform
============================================================
Shared keyword classifier and signal extraction utilities.
Consumed by all crawler scripts to produce structured signal objects.
"""

import re
from datetime import datetime, timezone
from typing import Optional

# ── Keyword dictionaries ──────────────────────────────────────────────────────

DISTRESS_KEYWORDS = {
    "insolvency": [
        "insolvency", "insolvent", "nclt", "national company law tribunal",
        "corporate insolvency resolution process", "cirp",
    ],
    "liquidation": [
        "liquidation", "liquidator", "winding up", "wound up",
        "dissolution", "strike off",
    ],
    "debt_restructuring": [
        "debt restructuring", "one time settlement", "ots",
        "npa", "non-performing asset", "wilful defaulter",
        "debt resolution", "moratorium",
    ],
    "sarfaesi": [
        "sarfaesi", "security interest", "possession notice",
        "bank enforcement", "attachment", "e-auction",
        "auction of property", "auction of assets",
    ],
    "default": [
        "loan default", "payment default", "emi default",
        "missed payment", "overdue payment", "debt default",
        "bond default",
    ],
    "bankruptcy": [
        "bankrupt", "bankruptcy", "ibbi",
        "insolvency and bankruptcy board",
    ],
}

EXPANSION_KEYWORDS = {
    "fundraising": [
        "raises", "raised", "fundraise", "series a", "series b", "series c",
        "series d", "seed round", "funding round", "venture capital",
        "invested", "investment round", "secures funding",
    ],
    "hiring": [
        "hiring", "recruitment drive", "job openings", "headcount",
        "adds employees", "expands team", "hiring spree",
        "talent acquisition", "workforce expansion",
    ],
    "new_office": [
        "opens office", "new office", "opening in", "expands to",
        "sets up operations", "new headquarters", "new hq",
        "new campus", "new facility",
    ],
    "expansion": [
        "expansion", "expands", "expanding", "growing presence",
        "entering market", "new market", "geographic expansion",
        "business expansion",
    ],
    "acquisition": [
        "acquires", "acquisition", "merger", "takeover", "buys",
        "purchased", "absorbs", "strategic acquisition",
    ],
    "relocation": [
        "relocating", "relocation", "moving to", "shifting to",
        "new location", "upgraded office",
    ],
}

# ── Utility helpers ───────────────────────────────────────────────────────────

def normalize_text(text: str) -> str:
    """Lowercase, collapse whitespace."""
    return re.sub(r"\s+", " ", text.lower().strip())


def extract_company_names(text: str, known_companies: Optional[list] = None) -> list[str]:
    """
    Simple named-entity heuristic for Indian company names.
    Matches tokens ending with: Ltd, Limited, Pvt, Corp, Inc, LLP, Co
    Also checks against a known_companies list if provided.
    """
    pattern = r"\b([A-Z][A-Za-z0-9&\-\s]{1,50}(?:Ltd|Limited|Pvt|Corp|Inc|LLP|Co|Technologies|Services|Solutions|Group|Holdings|Capital|Ventures|Properties|Realty|Infra|Finance|Bank))\b"
    found = re.findall(pattern, text)
    found = [f.strip() for f in found]

    if known_companies:
        text_lower = text.lower()
        for c in known_companies:
            if c.lower() in text_lower and c not in found:
                found.append(c)

    return list(dict.fromkeys(found))  # deduplicate while preserving order


def classify_signal(text: str) -> dict:
    """
    Returns:
      {
        "type":       "distress" | "expansion" | "neutral",
        "category":   specific category key,
        "confidence": 0.0 – 1.0,
        "matched_keywords": [...]
      }
    """
    norm = normalize_text(text)
    matches = []

    # Check distress
    for category, keywords in DISTRESS_KEYWORDS.items():
        hits = [kw for kw in keywords if kw in norm]
        if hits:
            matches.append(("distress", category, hits))

    # Check expansion
    for category, keywords in EXPANSION_KEYWORDS.items():
        hits = [kw for kw in keywords if kw in norm]
        if hits:
            matches.append(("expansion", category, hits))

    if not matches:
        return {"type": "neutral", "category": None, "confidence": 0.0, "matched_keywords": []}

    # Pick best match by keyword hit count
    matches.sort(key=lambda x: len(x[2]), reverse=True)
    best_type, best_cat, best_hits = matches[0]

    # Calculate confidence: more hits = higher confidence, capped at 0.98
    confidence = min(0.5 + 0.1 * len(best_hits), 0.98)

    return {
        "type": best_type,
        "category": best_cat,
        "confidence": round(confidence, 2),
        "matched_keywords": best_hits,
    }


def build_distress_event(
    company: str,
    signal: str,
    source: str,
    headline: str = "",
    url: str = "",
    details: str = "",
    confidence: float = 0.8,
    severity: Optional[str] = None,
) -> dict:
    """Build a structured distress_events row."""
    if severity is None:
        severity = "high" if confidence >= 0.9 else "medium" if confidence >= 0.7 else "low"
    return {
        "company":     company,
        "signal":      signal,
        "severity":    severity,
        "source":      source,
        "headline":    headline[:512],
        "url":         url[:2048],
        "details":     details[:2000],
        "confidence":  confidence,
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }


def build_demand_signal(
    company: str,
    signal: str,
    source: str,
    city: str = "",
    headline: str = "",
    url: str = "",
    details: str = "",
    confidence: float = 0.8,
) -> dict:
    """Build a structured demand_signals row."""
    return {
        "company":     company,
        "signal":      signal,
        "city":        city,
        "source":      source,
        "headline":    headline[:512],
        "url":         url[:2048],
        "details":     details[:2000],
        "confidence":  confidence,
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Indian city detection ─────────────────────────────────────────────────────

INDIA_CITIES = [
    "mumbai", "delhi", "bangalore", "bengaluru", "hyderabad", "pune",
    "chennai", "kolkata", "ahmedabad", "surat", "jaipur", "lucknow",
    "noida", "gurgaon", "gurugram", "navi mumbai", "thane",
    "chandigarh", "coimbatore", "kochi", "indore", "bhopal",
    "vadodara", "nagpur", "visakhapatnam", "patna", "agra",
]

def detect_city(text: str) -> str:
    """Return first Indian city found in text, or empty string."""
    norm = normalize_text(text)
    for city in INDIA_CITIES:
        if city in norm:
            return city.title()
    return ""


if __name__ == "__main__":
    # Quick self-test
    samples = [
        "NCLT Mumbai admits XYZ Corp for insolvency proceedings under CIRP",
        "ABC Technologies raises $80M Series B, expanding to Bangalore and Pune",
        "Bank auctions Sarfaesi property of defaulted borrower in Hyderabad",
        "Fintech startup opens new office in Noida amid hiring spree",
    ]
    for s in samples:
        result = classify_signal(s)
        companies = extract_company_names(s)
        city = detect_city(s)
        print(f"\nText: {s}")
        print(f"  Signal: {result}")
        print(f"  Companies: {companies}")
        print(f"  City: {city}")
