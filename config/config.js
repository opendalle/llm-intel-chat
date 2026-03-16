// ============================================================
// NEXUS ASIA CRE INTELLIGENCE PLATFORM
// Configuration File
//
// SETUP INSTRUCTIONS:
// 1. Replace SUPABASE_URL with your project URL from Supabase Dashboard > Settings > API
// 2. Replace SUPABASE_ANON_KEY with the "anon public" key from the same page
// 3. OLLAMA_URL: keep as-is if running Ollama on the same machine (default port)
//    Change to your machine's local IP if accessing from another device on the LAN
// 4. Commit this file to your GitHub repo (GitHub Pages will serve it)
//    Do NOT commit your service_role key — that stays in GitHub Secrets for crawlers only
// ============================================================

const CONFIG = {
  // ----- Supabase -----
  SUPABASE_URL:       'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY:  'YOUR_SUPABASE_ANON_PUBLIC_KEY',

  // ----- Ollama (local LLM) -----
  // Must be running on the same machine as the browser (CORS is relaxed for localhost)
  OLLAMA_URL:         'http://localhost:11434',
  OLLAMA_MODEL:       'mistral',          // change to llama3, phi3, gemma2, etc.
  OLLAMA_TIMEOUT_MS:  60000,              // 60 s timeout for LLM calls

  // ----- Platform settings -----
  PLATFORM_NAME:      'NEXUS ASIA CRE Intelligence',
  VERSION:            '1.0.0',
  MAX_ROWS_RETURNED:  500,               // safety cap on DB queries
  CONFIDENCE_THRESHOLD: 0.65,           // min confidence to display a signal

  // ----- Auto-refresh -----
  DASHBOARD_REFRESH_MS: 300000,          // refresh dashboard every 5 minutes

  // ----- Intent detection thresholds -----
  INTENT_KEYWORDS: {
    leases:             ['lease', 'expiry', 'expiring', 'tenant', 'sqft', 'area', 'rent', 'floor'],
    buildings:          ['building', 'tower', 'park', 'campus', 'office', 'property'],
    distress:           ['distress', 'insolvency', 'nclt', 'ibbi', 'sarfaesi', 'default', 'bankrupt', 'liquidat', 'restructur'],
    corporate_expansion:['expand', 'expansion', 'fundrais', 'hiring', 'headcount', 'new office', 'opening', 'relocat', 'acqui'],
    financial:          ['rent', 'revenue', 'cost', 'value', 'total', 'sum', 'average', 'crore', 'lakh', 'monthly'],
    knowledge_graph:    ['linked', 'connected', 'related', 'graph', 'relationship', 'network', 'lender', 'financed']
  }
};

// Prevent accidental modification
Object.freeze(CONFIG);

// Export for both module and browser global use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
