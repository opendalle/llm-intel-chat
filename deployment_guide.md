# NEXUS ASIA CRE Intelligence Platform — Deployment Guide

## Prerequisites

| Requirement | Details |
|---|---|
| GitHub account | Free tier is sufficient |
| Supabase account | Free tier (500MB, 50k requests/day) at [supabase.com](https://supabase.com) |
| Ollama installed | [ollama.com](https://ollama.com) — runs on your laptop |
| Python 3.10+ | For running crawlers locally if needed |

---

## Step 1 — Create Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Choose a name (e.g. `nexus-asia-cre`) and a strong database password
3. Select region: **ap-south-1 (Mumbai)** for best latency from India
4. Wait ~2 minutes for the project to boot

### Install the schema

5. In Supabase Dashboard → **SQL Editor** → New query
6. Copy the **entire** contents of `database/schema.sql` and paste it in
7. Click **Run** — you should see "Success. No rows returned."
8. Verify in **Table Editor** that 7 tables are created:
   - `companies`, `buildings`, `leases`, `distress_events`
   - `demand_signals`, `datasets`, `knowledge_graph_edges`

### Get your credentials

9. Go to **Settings → API**
10. Copy:
    - **Project URL** → `https://xxxx.supabase.co`
    - **anon public** key → long JWT string starting with `eyJ...`

> ⚠️ **IMPORTANT**: The `service_role` key has FULL database access. Never put it in `config.js` or GitHub Pages. Use it only in GitHub Secrets for crawlers.

---

## Step 2 — Configure the Platform

Open `config/config.js` in your editor:

```javascript
SUPABASE_URL:      'https://YOUR_PROJECT_ID.supabase.co',   // ← paste here
SUPABASE_ANON_KEY: 'YOUR_ANON_PUBLIC_KEY',                   // ← paste here
OLLAMA_URL:        'http://localhost:11434',                  // keep as-is
OLLAMA_MODEL:      'mistral',                                 // or llama3, phi3
```

Save and commit:
```bash
git add config/config.js
git commit -m "chore: configure Supabase and Ollama"
git push
```

---

## Step 3 — Deploy Frontend to GitHub Pages

1. Push your repository to GitHub if you haven't already:
```bash
git init
git remote add origin https://github.com/YOUR_USERNAME/nexus-asia-cre-intelligence.git
git add .
git commit -m "feat: initial platform"
git push -u origin main
```

2. In GitHub → your repo → **Settings → Pages**
3. Under **Source**: select `Deploy from a branch`
4. **Branch**: `main` | **Folder**: `/chatbot`
5. Click **Save**

GitHub will build and deploy in ~1 minute. Your URL:
```
https://YOUR_USERNAME.github.io/nexus-asia-cre-intelligence/
```

> 💡 **Tip**: If the page shows a blank screen, your `config.js` may still have placeholder values. Update it and push.

---

## Step 4 — Set Up GitHub Secrets for Crawlers

1. In GitHub → your repo → **Settings → Secrets and variables → Actions**
2. Click **New repository secret** and add:

| Secret Name | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase `service_role` key |

3. The GitHub Actions workflow (`.github/workflows/crawler.yml`) will now:
   - Run automatically **every 30 minutes**
   - Crawl NCLT, IBBI, news sources
   - Insert new distress/demand signals into Supabase

4. Enable Actions: Go to **Actions** tab → Click **"I understand my workflows, go ahead and enable them"** if prompted.

5. To test immediately: **Actions → NEXUS ASIA CRE Crawler → Run workflow**

---

## Step 5 — Install and Start Ollama

### Install Ollama (Windows)
```bash
# Download installer from https://ollama.com/download/windows
# OR via PowerShell:
winget install Ollama.Ollama
```

### Pull a model
```bash
# Recommended models (free, fast):
ollama pull mistral     # Best: fast, accurate SQL generation (~4GB)
ollama pull llama3      # Alternative: very capable (~4.7GB)
ollama pull phi3        # Lightweight for low-spec machines (~2.4GB)
```

### Start Ollama
```bash
ollama serve
# Ollama is now running at http://localhost:11434
```

### Verify
Open your browser to `http://localhost:11434/api/tags` — you should see JSON listing your models.

Now open your GitHub Pages URL. The Ollama badge in the sidebar should show **🟢 Ollama · mistral**.

---

## Step 6 — Import Your First Dataset

1. Open your GitHub Pages URL
2. Click **⬆ Import Data** tab
3. In **Dataset Name**: enter a descriptive name, e.g. `Q1 2026 Lease Register`
4. In the paste area, paste your CSV or Excel data (copy from Excel and paste — it pastes as TSV which is auto-detected):

```
company,city,sqft,rent,lease_expiry
Infosys BPO,Mumbai,45000,195,2026-06-30
TCS Digital,Pune,28000,115,2027-03-31
```

5. Click **🔍 Preview** — verify columns and types
6. The system shows a `CREATE TABLE` SQL — run this in **Supabase SQL Editor** first (this is the one manual step for new tables)
7. Click **⬆ Import Data** — rows are inserted and the dataset is registered

The chatbot can now answer questions about this data:
> *"Show me all leases from the Q1 2026 Lease Register"*

---

## Step 7 — Verify End-to-End

Open your chatbot and try these test queries:

| Query | Expected result |
|---|---|
| `Which distressed companies occupy offices in Mumbai?` | Table from `leases` + `distress_events` |
| `Show tenants with leases expiring in 2026` | Table from `leases` filtered by year |
| `Which buildings are exposed to distressed tenants?` | Results from `building_distress_exposure` view |
| `Show all fundraising signals detected this month` | Table from `demand_signals` |

If you see **"No records found"**: that's correct if the DB is empty. The seed data in `schema.sql` provides a few sample rows for testing.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Chatbot shows "Ollama offline" | Run `ollama serve` in terminal; ensure port 11434 is not blocked by firewall |
| "No matching data available" every query | Check Supabase URL and anon key in `config.js` are correct |
| Crawlers fail in GitHub Actions | Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` secrets are set; check Actions logs |
| Import fails: "table does not exist" | Run the `CREATE TABLE` SQL shown in the Import panel in Supabase SQL Editor first |
| GitHub Pages is blank | Confirm Pages is set to `/chatbot` folder, not root; check for JS console errors |
| LLM generates wrong SQL | Try a larger model (`ollama pull llama3`); update `OLLAMA_MODEL` in config |

---

## Upgrading the LLM

You can swap models anytime without any code changes:
```bash
ollama pull llama3:8b    # More capable
ollama pull gemma2:9b    # Google's model, good at structured output
```
Then update `config/config.js`:
```javascript
OLLAMA_MODEL: 'llama3:8b',
```

---

## Data Privacy

- All data stays in **your** Supabase project — nothing leaves your control
- Ollama runs entirely **on your laptop** — queries never go to any cloud AI
- The anon key in `config.js` is rate-limited to your Supabase project only
- GitHub Actions crawlers use only public web pages — no scraping behind paywalls
