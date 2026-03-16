"""
crawler_mca.py — NEXUS ASIA CRE Intelligence Platform
============================================================
Crawls Ministry of Corporate Affairs (MCA21) public data and
SARFAESI enforcement notices to detect:
  - Company strikes-offs / defaults
  - Bank enforcement actions under SARFAESI Act
  - Public notice of debt enforcement
  - DRT (Debt Recovery Tribunal) cases

Data sources:
  - MCA21 public company search (data.gov.in datasets)
  - Bank SARFAESI notices in newspapers (via Google News RSS)
  - RBI's defaulters list (when publicly available)
  - Lok Adalat notices from leading bank websites
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
    classify_signal,
)

# ── Setup ─────────────────────────────────────────────────────────────────────
load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("crawler_mca")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
REQUEST_DELAY = 4

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
}

# ── Google News RSS for SARFAESI notices ──────────────────────────────────────
# Google News RSS is free and requires no API key
SARFAESI_RSS_URLS = [
    "https://news.google.com/rss/search?q=SARFAESI+notice+auction+India&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=bank+NPA+enforcement+notice+India&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=DRT+debt+recovery+tribunal+India&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=wilful+defaulter+RBI+India&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=NCLT+winding+up+company+India&hl=en-IN&gl=IN&ceid=IN:en",
]

# MCA21 data.gov.in datasets (open government data)
MCA_DATASETS = [
    {
        "name": "Strike-off Companies",
        "url": "https://data.gov.in/resource/company-strike-data",   # data.gov.in
        "signal": "liquidation",
        "severity": "high",
    },
]

# Major Indian banks to check for public notice pages
BANK_NOTICE_URLS = [
    {
        "bank":   "SBI",
        "url":    "https://sbi.co.in/web/e-auction",
        "signal": "sarfaesi",
    },
    {
        "bank":   "HDFC Bank",
        "url":    "https://www.hdfcbank.com/content/api/contentstream-id/723fb80a",
        "signal": "sarfaesi",
    },
]


# ── Supabase client ───────────────────────────────────────────────────────────

def get_supabase() -> Client:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Google News RSS scraper ───────────────────────────────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=4, max=20))
def fetch_google_news_rss(url: str) -> list[dict]:
    log.info(f"Fetching Google News RSS: {url[:80]}")
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "xml")
    items = soup.find_all("item")
    articles = []
    for item in items:
        title = item.find("title")
        desc  = item.find("description")
        link  = item.find("link")
        pub   = item.find("pubDate")
        articles.append({
            "title":    title.get_text(strip=True) if title else "",
            "desc":     desc.get_text(strip=True)  if desc  else "",
            "link":     link.get_text(strip=True)   if link  else "",
            "pub_date": pub.get_text(strip=True)   if pub   else "",
        })
    return articles


def process_sarfaesi_articles(articles: list[dict], source_name: str, supabase: Client):
    """Classify SARFAESI articles and insert distress events."""
    events = []
    for art in articles:
        text     = f"{art['title']} {art['desc']}"
        sig      = classify_signal(text)
        companies = extract_company_names(text)
        if not companies or sig["type"] == "neutral":
            continue
        for company in companies[:3]:
            events.append(build_distress_event(
                company=company,
                signal=sig["category"] or "sarfaesi",
                source=source_name,
                headline=art["title"],
                url=art["link"],
                details=art["desc"][:400],
                confidence=sig["confidence"],
                severity="high" if "sarfaesi" in sig["category"] else "medium",
            ))
    if events:
        supabase.table("distress_events").insert(events).execute()
        log.info(f"[{source_name}] Inserted {len(events)} SARFAESI/MCA distress events")


# ── Bank notice page scraper ──────────────────────────────────────────────────

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=2, min=3, max=15))
def scrape_bank_notices(bank_info: dict, supabase: Client):
    log.info(f"Scraping {bank_info['bank']} notices: {bank_info['url']}")
    try:
        resp = requests.get(bank_info["url"], headers=HEADERS, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.content, "lxml")
        text = soup.get_text(" ", strip=True)
        companies = extract_company_names(text)
        events = []
        for company in companies[:20]:
            city = detect_city(text)
            events.append(build_distress_event(
                company=company,
                signal=bank_info["signal"],
                source=f"{bank_info['bank'].lower()}_notice",
                headline=f"{bank_info['bank']} enforcement notice — {company}",
                url=bank_info["url"],
                confidence=0.82,
                severity="high",
            ))
        if events:
            supabase.table("distress_events").insert(events).execute()
            log.info(f"[{bank_info['bank']}] Inserted {len(events)} enforcement events")
    except Exception as e:
        log.error(f"Failed scraping {bank_info['bank']}: {e}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    log.info("=== NEXUS ASIA MCA/SARFAESI Crawler starting ===")
    supabase = get_supabase()

    # ── Google News SARFAESI RSS ──
    for rss_url in SARFAESI_RSS_URLS:
        try:
            articles = fetch_google_news_rss(rss_url)
            log.info(f"RSS: fetched {len(articles)} articles")
            process_sarfaesi_articles(articles, "mca_sarfaesi_news", supabase)
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            log.error(f"RSS failed {rss_url[:60]}: {e}")

    # ── Bank notice pages ──
    for bank in BANK_NOTICE_URLS:
        try:
            scrape_bank_notices(bank, supabase)
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            log.error(f"Bank scrape failed for {bank['bank']}: {e}")

    log.info("=== MCA/SARFAESI Crawler complete ===")


if __name__ == "__main__":
    main()
