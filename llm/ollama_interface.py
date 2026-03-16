"""
ollama_interface.py — NEXUS ASIA CRE Intelligence Platform
============================================================
Interface to a locally running Ollama LLM.

Responsibilities:
  1. generate_sql(question, schema_context) → SQL string
  2. explain_results(question, rows) → natural language summary
  3. classify_intent(question) → intent string

Anti-hallucination guarantees:
  - LLM is NEVER asked to generate data
  - LLM only receives the question + schema OR question + actual DB rows
  - "Do not fabricate" is always in the system prompt
  - SQL is sanitized before execution (see retriever.js)

Usage (direct test):
  python ollama_interface.py

Environment:
  OLLAMA_URL   — default: http://localhost:11434
  OLLAMA_MODEL — default: mistral
"""

import os
import json
import re
import logging
from typing import Optional

import requests
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ollama")

OLLAMA_URL   = os.environ.get("OLLAMA_URL",   "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "mistral")
TIMEOUT      = int(os.environ.get("OLLAMA_TIMEOUT", "60"))


# ── System prompts ────────────────────────────────────────────────────────────

SQL_SYSTEM_PROMPT = """You are a PostgreSQL SQL expert for a Commercial Real Estate intelligence platform.
Your ONLY job is to generate a valid PostgreSQL SELECT query based on the user's question and the provided schema.

STRICT RULES:
- Output ONLY a single raw SQL SELECT statement. No markdown, no explanation, no code fences.
- Never use INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, or any DDL/DML.
- Never use semicolons inside the query body.
- Only reference tables and columns listed in the schema below.
- If the question cannot be answered from the schema, output: SELECT 'No matching data available' AS message;
- Always add LIMIT 500 unless a more specific LIMIT is present.
- Dates are stored as DATE or TIMESTAMPTZ. Use NOW() for current time.
- All text comparisons must be case-insensitive: use LOWER(column) = LOWER('value') or ILIKE.
- For lease expiry filtering: lease_expiry is a DATE column.

Available schema:
{schema}
"""

EXPLAIN_SYSTEM_PROMPT = """You are a Commercial Real Estate analyst assistant for NEXUS ASIA.
Your ONLY job is to explain the data results provided to you in clear, professional language.

STRICT RULES:
- ONLY reference facts present in the provided data rows.
- Do NOT invent, extrapolate, or guess any data not in the rows.
- If the data is empty, say "No records found matching this query."
- Provide a concise 2–4 sentence summary, then bullet key findings.
- Mention specific company names, building names, and numbers from the data.
- End with a one-line CRE risk implication if relevant.
"""

INTENT_SYSTEM_PROMPT = """Classify the user's question into exactly one of these categories:
leases | buildings | distress | corporate_expansion | financial | knowledge_graph

Rules:
- Output ONLY the category word. Nothing else.
- leases: questions about tenants, lease expiry, sqft, rent
- buildings: questions about office buildings, properties, occupancy
- distress: questions about insolvency, NCLT, bankruptcy, defaulters, SARFAESI
- corporate_expansion: questions about fundraising, hiring, new offices, expansion
- financial: questions about totals, sums, averages, revenue, costs
- knowledge_graph: questions about relationships, connections, lenders, networks
"""


# ── Low-level API call ────────────────────────────────────────────────────────

def _call_ollama(
    prompt: str,
    system: str = "",
    model: str = OLLAMA_MODEL,
    temperature: float = 0.1,
    max_tokens: int = 2048,
) -> str:
    """
    Call Ollama /api/generate endpoint.
    Returns the full response text.
    Raises on network or model error.
    """
    payload = {
        "model":  model,
        "prompt": prompt,
        "system": system,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
            "top_p": 0.9,
        },
    }
    url = f"{OLLAMA_URL}/api/generate"
    log.debug(f"Calling Ollama [{model}] — prompt length: {len(prompt)} chars")
    resp = requests.post(url, json=payload, timeout=TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    return data.get("response", "").strip()


# ── SQL generation ────────────────────────────────────────────────────────────

def generate_sql(question: str, schema_context: str, model: str = OLLAMA_MODEL) -> str:
    """
    Convert a natural language question into a SQL SELECT query.
    Returns a sanitized SQL string.
    """
    system = SQL_SYSTEM_PROMPT.format(schema=schema_context)
    prompt = f"User question: {question}\n\nGenerate the SQL query:"
    raw = _call_ollama(prompt, system=system, model=model, temperature=0.05)

    # Strip markdown fences if LLM added them
    raw = re.sub(r"```sql\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"```\s*", "", raw)
    raw = raw.strip().rstrip(";")

    # Safety: block any data-mutating statements
    forbidden = re.compile(
        r"\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b",
        re.IGNORECASE,
    )
    if forbidden.search(raw):
        log.warning(f"LLM generated unsafe SQL, blocking: {raw[:100]}")
        return "SELECT 'Query blocked for safety' AS message"

    # Ensure LIMIT exists
    if "LIMIT" not in raw.upper():
        raw = raw + " LIMIT 500"

    log.info(f"Generated SQL: {raw[:120]}")
    return raw


# ── Result explanation ────────────────────────────────────────────────────────

def explain_results(
    question: str,
    rows: list[dict],
    model: str = OLLAMA_MODEL,
) -> str:
    """
    Given the user question and actual DB rows, produce a natural language explanation.
    """
    if not rows:
        return "No records were found in the database matching your query."

    row_text = json.dumps(rows[:50], indent=2, default=str)  # cap at 50 rows for context
    prompt = (
        f"User question: {question}\n\n"
        f"Database results ({len(rows)} total rows, showing first 50):\n{row_text}\n\n"
        "Provide your analysis:"
    )
    return _call_ollama(prompt, system=EXPLAIN_SYSTEM_PROMPT, model=model, temperature=0.2)


# ── Intent classification ─────────────────────────────────────────────────────

def classify_intent(question: str, model: str = OLLAMA_MODEL) -> str:
    """
    Classify question intent using LLM.
    Returns one of: leases | buildings | distress | corporate_expansion | financial | knowledge_graph
    """
    VALID_INTENTS = {"leases", "buildings", "distress", "corporate_expansion", "financial", "knowledge_graph"}
    raw = _call_ollama(question, system=INTENT_SYSTEM_PROMPT, model=model,
                       temperature=0.0, max_tokens=20)
    intent = raw.strip().lower().split()[0] if raw.strip() else "leases"
    if intent not in VALID_INTENTS:
        intent = "leases"
    return intent


# ── Health check ──────────────────────────────────────────────────────────────

def health_check() -> dict:
    """Check if Ollama is running and the model is available."""
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        return {
            "status":          "ok",
            "ollama_url":      OLLAMA_URL,
            "available_models": models,
            "target_model":    OLLAMA_MODEL,
            "model_loaded":    any(OLLAMA_MODEL in m for m in models),
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ── CLI test ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Ollama Health Check ===")
    print(json.dumps(health_check(), indent=2))

    test_schema = """
    leases (id, tenant TEXT, building_name TEXT, city TEXT, area NUMERIC, rent NUMERIC, lease_expiry DATE, status TEXT)
    distress_events (id, company TEXT, signal TEXT, severity TEXT, source TEXT, detected_at TIMESTAMPTZ)
    """

    q = "Which distressed companies occupy offices in Mumbai?"
    print(f"\n=== SQL Generation Test ===\nQuestion: {q}")
    sql = generate_sql(q, test_schema)
    print(f"SQL: {sql}")

    print("\n=== Intent Classification Test ===")
    for question in [
        "Show leases expiring in 2026",
        "Which companies raised funds recently?",
        "Which buildings have insolvent tenants?",
    ]:
        intent = classify_intent(question)
        print(f"  Q: {question}\n  Intent: {intent}\n")
