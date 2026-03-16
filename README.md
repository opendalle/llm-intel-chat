# NEXUS ASIA CRE Intelligence Platform

> **Commercial Real Estate deal intelligence powered by distress signals, expansion leads, lease risk analytics, and a local Ollama LLM. No paid APIs. Runs on GitHub Pages + Supabase + your laptop.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              NEXUS ASIA CRE INTELLIGENCE                │
├─────────────┬────────────────┬───────────────────────────┤
│  GitHub     │   GitHub Pages │   Local Machine           │
│  Actions    │   chatbot/     │   Ollama LLM              │
│  (crawlers) │   index.html   │   http://localhost:11434  │
│  every 30m  │   chatbot.js   │                           │
│             │   style.css    │                           │
└──────┬──────┴───────┬────────┴───────┬───────────────────┘
       │              │                │
       ▼              ▼                ▼
┌─────────────────────────────────────────────────────────┐
│                SUPABASE (PostgreSQL)                     │
│  companies · buildings · leases · distress_events       │
│  demand_signals · datasets · knowledge_graph_edges      │
│  Views: lease_risk_dashboard · building_distress_exp.   │
└─────────────────────────────────────────────────────────┘
```

## What It Does

| Capability | Description |
|---|---|
| 🔴 **Distress Detection** | Crawls NCLT, IBBI, SARFAESI, news for insolvency/liquidation/default signals |
| 🚀 **Expansion Leads** | Detects fundraising, hiring, new office announcements from ET, Mint, Reuters |
| 📅 **Lease Risk** | Flags leases expiring within 3–12 months, cross-references distress signals |
| 🏢 **Building Exposure** | Shows which buildings have distressed tenants and exposed rent |
| 💬 **AI Chatbot** | Natural language → SQL → Supabase → grounded explanation via Ollama |
| 🕸 **Knowledge Graph** | D3.js force graph: company → building → signal relationships |
| ⬆ **Data Import** | Paste CSV/Excel → auto-create table → register as queryable dataset |

---

## Quickstart

### Step 1 — Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** → paste the entire contents of `database/schema.sql` → Run
3. Copy your **Project URL** and **anon public key** from **Settings → API**

### Step 2 — Fill in Config

Edit `config/config.js`:
```javascript
SUPABASE_URL:      'https://YOUR_PROJECT_ID.supabase.co',
SUPABASE_ANON_KEY: 'YOUR_ANON_KEY',
```

### Step 3 — Deploy to GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Source: `Deploy from a branch` → branch: `main` → folder: `/chatbot`
4. Your platform is live at `https://YOUR_USERNAME.github.io/nexus-asia-cre-intelligence/`

### Step 4 — Add GitHub Secrets (for crawlers)

In repo **Settings → Secrets and variables → Actions**, add:
```
SUPABASE_URL          →  your Supabase project URL
SUPABASE_SERVICE_KEY  →  your Supabase service_role key (NOT anon key)
```

### Step 5 — Start Ollama

```bash
# Install Ollama: https://ollama.com
ollama pull mistral       # or llama3, phi3, gemma2
ollama serve              # starts on http://localhost:11434
```

Then open your GitHub Pages URL — the chatbot will connect to Ollama automatically.

---

## Project Structure

```
nexus-asia-cre-intelligence/
├── .github/
│   └── workflows/
│       └── crawler.yml           ← GitHub Actions (every 30 min)
├── chatbot/
│   ├── index.html                ← Main SPA (GitHub Pages root)
│   ├── chatbot.js                ← Orchestrator + dashboard
│   ├── parser.js                 ← Table renderer + CSV export
│   ├── data_import_panel.js      ← CSV/Excel import
│   └── style.css                 ← Premium dark UI
├── config/
│   └── config.js                 ← ⚠️ Fill in Supabase URL & key
├── crawler/
│   ├── crawler_news.py           ← ET, BS, Mint, Reuters RSS
│   ├── crawler_nclt.py           ← NCLT + IBBI CIRP/Liquidation
│   ├── crawler_mca.py            ← SARFAESI, bank notices, MCA
│   └── signals_parser.py         ← Shared keyword classifier
├── database/
│   └── schema.sql                ← Run this in Supabase SQL Editor
├── intelligence/
│   ├── intent_classifier.js      ← Keyword intent router
│   ├── schema_router.js          ← Intent → table context
│   ├── retriever.js              ← Full RAG pipeline
│   └── knowledge_graph.js        ← Graph query + D3 data
├── llm/
│   └── ollama_interface.py       ← Ollama LLM wrapper (Python)
├── requirements.txt
└── README.md
```

---

## Example Chatbot Queries

> **Which distressed companies occupy offices in Mumbai?**
> → SQL joins `leases` + `distress_events` where city = Mumbai

> **Show tenants with leases expiring in 2026**
> → Queries `leases` where `lease_expiry` between Jan–Dec 2026

> **Which companies expanding in Bangalore may need office space?**
> → Queries `demand_signals` where city = Bangalore and signal in (fundraising, hiring, new_office)

> **Which buildings are exposed to distressed tenants?**
> → Queries pre-built `building_distress_exposure` view

> **Total monthly rent at risk from distressed tenants in Mumbai**
> → SUM(total_monthly) from `leases` joined on `distress_events`

---

## Intelligence Rules Engine

Automatic risk flags applied to all results:

| Rule | Flag |
|---|---|
| Distressed tenant with area ≥ 20,000 sqft | ⚠️ HIGH VACANCY RISK |
| Distressed tenant (any size) | 🔴 Distressed tenant |
| Lease expiry ≤ 3 months | CRITICAL |
| Lease expiry ≤ 6 months | HIGH |
| Lease expiry ≤ 12 months | MEDIUM |

---

## License

Proprietary — NEXUS ASIA Group. All rights reserved.
