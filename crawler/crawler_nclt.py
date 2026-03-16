"""
crawler_nclt.py — NEXUS ASIA CRE Intelligence Platform
============================================================
Crawls National Company Law Tribunal (NCLT) public order listings
to detect insolvency, liquidation, and winding-up cases.

Data source: https://nclt.gov.in (public case records)

Note: NCLT does not have a public API. This crawler scrapes
the publicly available case listing pages and PDF summaries.
Always respect robots.txt and rate limits.
"""

import os
import re
import time
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential
import requests
from bs4 import BeautifulSoup
from supabase import create_client, Client

from signals_parser import (
    build_distress_event,
    extract_company_names,
    detect_city,
    normalize_text,
)

# ── Setup ─────────────────────────────────────────────────────────────────────
load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("crawler_nclt")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
REQUEST_DELAY = 5

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
}

# ── NCLT bench URLs (public listings) ────────────────────────────────────────
# NCLT maintains 15 benches across India. We target their public order pages.
NCLT_BENCH_URLS = [
    {
        "bench":    "Mumbai",
        "url":      "https://nclt.gov.in/orders-judgments",
        "city":     "Mumbai",
    },
    {
        "bench":    "Delhi",
        "url":      "https://nclt.gov.in/orders-judgments",
        "city":     "Delhi",
    },
    {
        "bench":    "Bangalore",
        "url":      "https://nclt.gov.in/orders-judgments",
        "city":     "Bangalore",
    },
    {
        "bench":    "Hyderabad",
        "url":      "https://nclt.gov.in/orders-judgments",
        "city":     "Hyderabad",
    },
    {
        "bench":    "Chennai",
        "url":      "https://nclt.gov.in/orders-judgments",
        "city":     "Chennai",
    },
]

# IBBI public data CSV (free, updated daily)
IBBI_CIRP_URL = "https://ibbi.gov.in/uploads/cirpdata/cirp_data.csv"
IBBI_LIQ_URL  = "https://ibbi.gov.in/uploads/liquidationdata/liquidation_data.csv"

# Signal classification for NCLT case types
NCLT_SIGNAL_MAP = {
    r"insolvency|cirp":       "insolvency",
    r"liquidat":              "liquidation",
    r"winding.?up":           "liquidation",
    r"dissolution":           "liquidation",
    r"strike.?off":           "liquidation",
    r"restructur":            "debt_restructuring",
    r"merger|amalgamat":      "acquisition",
}


def classify_nclt_signal(text: str) -> str:
    norm = normalize_text(text)
    for pattern, signal in NCLT_SIGNAL_MAP.items():
        if re.search(pattern, norm):
            return signal
    return "insolvency"  # default for NCLT cases


# ── Supabase client ───────────────────────────────────────────────────────────

def get_supabase() -> Client:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── NCLT website scraper ──────────────────────────────────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=4, max=30))
def fetch_nclt_page(url: str) -> BeautifulSoup:
    log.info(f"Fetching NCLT page: {url}")
    resp = requests.get(url, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    return BeautifulSoup(resp.content, "lxml")


def parse_nclt_orders(soup: BeautifulSoup, city: str) -> list[dict]:
    """
    Parse NCLT order listing pages.
    NCLT website structure varies — adapt selectors as needed.
    """
    records = []
    # Look for tables or lists containing company names + case types
    rows = soup.find_all("tr")
    for row in rows:
        cells = [c.get_text(strip=True) for c in row.find_all(["td", "th"])]
        if len(cells) < 2:
            continue
        row_text = " ".join(cells)
        companies = extract_company_names(row_text)
        if not companies:
            continue
        signal = classify_nclt_signal(row_text)
        links = row.find_all("a", href=True)
        url = links[0]["href"] if links else "https://nclt.gov.in"
        for company in companies[:3]:  # cap at 3 companies per row
            records.append({
                "company":  company,
                "headline": row_text[:300],
                "signal":   signal,
                "city":     city,
                "url":      url,
            })
    return records


# ── IBBI CSV scraper ──────────────────────────────────────────────────────────

def fetch_ibbi_csv(url: str) -> list[dict]:
    """Download and parse IBBI public CIRP/Liquidation CSV data."""
    log.info(f"Fetching IBBI CSV: {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        lines = resp.text.splitlines()
        headers_row = [h.strip().lower() for h in lines[0].split(",")]
        records = []
        for line in lines[1:500]:  # process first 500 rows
            cols = line.split(",")
            if len(cols) < len(headers_row):
                continue
            record = {h: cols[i].strip() for i, h in enumerate(headers_row)}
            records.append(record)
        return records
    except Exception as e:
        log.error(f"Failed to fetch IBBI CSV {url}: {e}")
        return []


def parse_ibbi_cirp(records: list[dict]) -> list[dict]:
    """Parse IBBI CIRP rows into structured distress events."""
    events = []
    for rec in records:
        company = rec.get("corporate debtor name", rec.get("company", ""))
        if not company:
            continue
        city = detect_city(str(rec))
        events.append(build_distress_event(
            company=company,
            signal="insolvency",
            source="ibbi_cirp",
            headline=f"CIRP initiated against {company}",
            url="https://ibbi.gov.in",
            details=f"Date of admission: {rec.get('date of commencement of cirp', 'unknown')}. "
                    f"RP: {rec.get('insolvency professional name', 'unknown')}",
            confidence=0.95,
            severity="high",
        ))
    return events


def parse_ibbi_liquidation(records: list[dict]) -> list[dict]:
    """Parse IBBI Liquidation rows into structured distress events."""
    events = []
    for rec in records:
        company = rec.get("corporate debtor name", rec.get("company", ""))
        if not company:
            continue
        events.append(build_distress_event(
            company=company,
            signal="liquidation",
            source="ibbi_liquidation",
            headline=f"Liquidation order for {company}",
            url="https://ibbi.gov.in",
            details=f"Liquidation date: {rec.get('date of liquidation order', 'unknown')}",
            confidence=0.98,
            severity="critical",
        ))
    return events


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    log.info("=== NEXUS ASIA NCLT Crawler starting ===")
    supabase = get_supabase()
    all_events = []

    # ── IBBI public CSVs (most reliable data source) ──
    cirp_rows = fetch_ibbi_csv(IBBI_CIRP_URL)
    log.info(f"IBBI CIRP: fetched {len(cirp_rows)} rows")
    all_events.extend(parse_ibbi_cirp(cirp_rows[:200]))  # process latest 200

    time.sleep(REQUEST_DELAY)

    liq_rows = fetch_ibbi_csv(IBBI_LIQ_URL)
    log.info(f"IBBI Liquidation: fetched {len(liq_rows)} rows")
    all_events.extend(parse_ibbi_liquidation(liq_rows[:200]))

    # ── NCLT website scraping ──
    for bench in NCLT_BENCH_URLS:
        try:
            soup = fetch_nclt_page(bench["url"])
            records = parse_nclt_orders(soup, bench["city"])
            for rec in records:
                all_events.append(build_distress_event(
                    company=rec["company"],
                    signal=rec["signal"],
                    source="nclt",
                    headline=rec["headline"],
                    url=rec["url"],
                    confidence=0.88,
                    severity="high",
                ))
            log.info(f"NCLT {bench['bench']}: found {len(records)} cases")
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            log.error(f"NCLT {bench['bench']} failed: {e}")

    # ── Batch upsert to Supabase ──
    if all_events:
        chunk_size = 50
        for i in range(0, len(all_events), chunk_size):
            chunk = all_events[i:i+chunk_size]
            supabase.table("distress_events").insert(chunk).execute()
            log.info(f"Inserted chunk {i}–{i+len(chunk)} ({len(chunk)} rows)")
        log.info(f"Total: inserted {len(all_events)} distress events")
    else:
        log.info("No events to insert")

    log.info("=== NCLT Crawler complete ===")


if __name__ == "__main__":
    main()
