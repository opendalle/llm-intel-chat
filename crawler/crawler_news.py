"""
crawler_news.py — NEXUS ASIA CRE Intelligence Platform
============================================================
Crawls financial news sources to detect:
  - Corporate expansion / fundraising signals → demand_signals table
  - Distress signals in business news → distress_events table

Sources:
  - Economic Times (ET)
  - Business Standard (BS)
  - Mint
  - Reuters India
  - Bloomberg Quint / BQ Prime

Usage:
  python crawler_news.py
  (or scheduled via GitHub Actions every 30 minutes)
"""

import os
import time
import logging
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential
import requests
from bs4 import BeautifulSoup
from supabase import create_client, Client

from signals_parser import (
    classify_signal,
    extract_company_names,
    detect_city,
    build_distress_event,
    build_demand_signal,
)

# ── Setup ─────────────────────────────────────────────────────────────────────
load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("crawler_news")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
REQUEST_DELAY = 3  # seconds between requests (be polite)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
}

# ── News source configs ───────────────────────────────────────────────────────
NEWS_SOURCES = [
    {
        "name": "economic_times",
        "rss_urls": [
            "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
            "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms",
            "https://economictimes.indiatimes.com/small-biz/startups/rssfeeds/13357270.cms",
        ],
        "item_tag": "item",
        "title_tag": "title",
        "desc_tag": "description",
        "link_tag": "link",
    },
    {
        "name": "business_standard",
        "rss_urls": [
            "https://www.business-standard.com/rss/companies-101.rss",
            "https://www.business-standard.com/rss/markets-106.rss",
        ],
        "item_tag": "item",
        "title_tag": "title",
        "desc_tag": "description",
        "link_tag": "link",
    },
    {
        "name": "mint",
        "rss_urls": [
            "https://www.livemint.com/rss/companies",
            "https://www.livemint.com/rss/market",
        ],
        "item_tag": "item",
        "title_tag": "title",
        "desc_tag": "description",
        "link_tag": "link",
    },
    {
        "name": "reuters_india",
        "rss_urls": [
            "https://feeds.reuters.com/reuters/INbusinessNews",
        ],
        "item_tag": "item",
        "title_tag": "title",
        "desc_tag": "description",
        "link_tag": "link",
    },
]


# ── Supabase client ───────────────────────────────────────────────────────────

def get_supabase() -> Client:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── RSS feed fetcher ──────────────────────────────────────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def fetch_rss(url: str) -> list[dict]:
    """Fetch and parse RSS feed. Returns list of {title, description, link}."""
    log.info(f"Fetching RSS: {url}")
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "xml")
    items = soup.find_all("item")
    results = []
    for item in items:
        title = item.find("title")
        desc  = item.find("description")
        link  = item.find("link")
        results.append({
            "title":       title.get_text(strip=True) if title else "",
            "description": BeautifulSoup(desc.get_text(), "html.parser").get_text(strip=True) if desc else "",
            "link":        link.get_text(strip=True) if link else "",
        })
    return results


# ── Deduplication helper ──────────────────────────────────────────────────────

_seen_urls: set = set()

def is_seen(url: str) -> bool:
    if url in _seen_urls:
        return True
    _seen_urls.add(url)
    return False


# ── Main processing loop ──────────────────────────────────────────────────────

def process_articles(articles: list[dict], source_name: str, supabase: Client):
    """Classify each article and upsert into Supabase."""
    distress_rows = []
    demand_rows   = []

    for art in articles:
        url = art.get("link", "")
        if is_seen(url):
            continue

        headline = art.get("title", "")
        body     = art.get("description", "")
        full_text = f"{headline} {body}"

        signal_result = classify_signal(full_text)
        if signal_result["type"] == "neutral":
            continue

        companies = extract_company_names(full_text)
        city      = detect_city(full_text)
        if not companies:
            log.debug(f"No companies detected in: {headline[:80]}")
            continue

        for company in companies:
            if signal_result["type"] == "distress":
                row = build_distress_event(
                    company=company,
                    signal=signal_result["category"],
                    source=source_name,
                    headline=headline,
                    url=url,
                    details=body[:500],
                    confidence=signal_result["confidence"],
                )
                distress_rows.append(row)
            elif signal_result["type"] == "expansion":
                row = build_demand_signal(
                    company=company,
                    signal=signal_result["category"],
                    source=source_name,
                    city=city,
                    headline=headline,
                    url=url,
                    details=body[:500],
                    confidence=signal_result["confidence"],
                )
                demand_rows.append(row)

    # Batch insert
    if distress_rows:
        res = supabase.table("distress_events").insert(distress_rows).execute()
        log.info(f"[{source_name}] Inserted {len(distress_rows)} distress events")

    if demand_rows:
        res = supabase.table("demand_signals").insert(demand_rows).execute()
        log.info(f"[{source_name}] Inserted {len(demand_rows)} demand signals")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    log.info("=== NEXUS ASIA News Crawler starting ===")
    supabase = get_supabase()

    for source in NEWS_SOURCES:
        for rss_url in source["rss_urls"]:
            try:
                articles = fetch_rss(rss_url)
                log.info(f"[{source['name']}] Fetched {len(articles)} articles from {rss_url}")
                process_articles(articles, source["name"], supabase)
                time.sleep(REQUEST_DELAY)
            except Exception as e:
                log.error(f"[{source['name']}] Failed to fetch {rss_url}: {e}")

    log.info("=== News Crawler complete ===")


if __name__ == "__main__":
    main()
