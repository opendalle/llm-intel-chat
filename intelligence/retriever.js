/**
 * retriever.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Full retrieval pipeline orchestrator.
 * Flow: question → intent → schema → SQL (Ollama) → Supabase → explanation (Ollama)
 *
 * Anti-hallucination guarantees:
 *   - All answers come strictly from Supabase DB rows
 *   - LLM is NEVER asked to generate data, only SQL and explanations
 *   - SQL is sanitized before execution
 *   - If DB returns 0 rows, the answer says "No records found"
 */

'use strict';

const Retriever = (() => {

  let _supabase   = null;
  let _ollamaUrl  = 'http://localhost:11434';
  let _model      = 'mistral';
  let _maxRows    = 500;
  let _timeoutMs  = 60000;

  // ── SQL safety guard ──────────────────────────────────────────────────────
  const FORBIDDEN_SQL_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i;

  /** Initialize the retriever. */
  function init({ supabase, ollamaUrl, model, maxRows, timeoutMs }) {
    _supabase  = supabase;
    _ollamaUrl = ollamaUrl  || 'http://localhost:11434';
    _model     = model      || 'mistral';
    _maxRows   = maxRows    || 500;
    _timeoutMs = timeoutMs  || 60000;
  }

  // ── Ollama API call ───────────────────────────────────────────────────────

  async function _callOllama(prompt, systemPrompt, temperature = 0.05) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _timeoutMs);
    try {
      const resp = await fetch(`${_ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:  _model,
          prompt,
          system: systemPrompt,
          stream: false,
          options: { temperature, num_predict: 2048, top_p: 0.9 },
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
      const data = await resp.json();
      return (data.response || '').trim();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── SQL generation ────────────────────────────────────────────────────────

  const SQL_SYSTEM = `You are a PostgreSQL SQL expert for a Commercial Real Estate intelligence platform.
Output ONLY a raw SQL SELECT statement. No markdown fences, no explanation.
Rules:
- Never use INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE.
- Use ILIKE for case-insensitive text matching.
- Always add LIMIT {maxRows} unless query already has a tighter LIMIT.
- Only reference tables/columns in the schema below.
- If unanswerable from schema: SELECT 'No matching data available' AS message;
Schema:
{schema}`;

  async function _generateSQL(question, schemaContext) {
    const systemPrompt = SQL_SYSTEM
      .replace('{maxRows}', _maxRows)
      .replace('{schema}', schemaContext);
    const prompt = `User question: ${question}\n\nSQL query:`;
    let sql = await _callOllama(prompt, systemPrompt, 0.05);

    // Strip markdown fences
    sql = sql.replace(/```sql\s*/gi, '').replace(/```\s*/g, '').trim();
    sql = sql.replace(/;+$/, '').trim(); // remove trailing semicolons

    // Safety check
    if (FORBIDDEN_SQL_PATTERN.test(sql)) {
      console.warn('[Retriever] Blocked unsafe SQL:', sql.substring(0, 100));
      return `SELECT 'Query blocked for safety' AS message`;
    }

    // Ensure LIMIT
    if (!/\bLIMIT\b/i.test(sql)) {
      sql += ` LIMIT ${_maxRows}`;
    }

    return sql;
  }

  // ── Explanation generation ────────────────────────────────────────────────

  const EXPLAIN_SYSTEM = `You are a Commercial Real Estate analyst for NEXUS ASIA.
Explain the database results below in clear, professional language.
STRICT RULES:
- ONLY reference facts from the provided data rows.
- Do NOT invent or extrapolate any data.
- If data is empty, say "No records found matching this query."
- Provide a 2-4 sentence summary, then bullet key findings.
- End with a one-line CRE risk implication if applicable.`;

  async function _explainResults(question, rows) {
    if (!rows || rows.length === 0) {
      return 'No records were found in the database matching your query.';
    }
    const rowSample = JSON.stringify(rows.slice(0, 50), null, 2);
    const prompt = `Question: ${question}\n\nDatabase results (${rows.length} rows, showing first 50):\n${rowSample}\n\nAnalysis:`;
    return _callOllama(prompt, EXPLAIN_SYSTEM, 0.2);
  }

  // ── Supabase query execution ──────────────────────────────────────────────

  async function _executeSQL(sql) {
    if (!_supabase) throw new Error('Supabase client not initialized');
    // Use Supabase rpc for raw SQL (requires pg_jsonb_query or similar)
    // Fallback: use the REST API with a constructed query
    // We use .rpc('execute_sql', { query: sql }) if you add a helper function,
    // or parse the SQL to use the query builder.
    // For maximum flexibility, use the raw REST API approach:
    const { data, error } = await _supabase.rpc('nexus_execute_sql', { query_text: sql });
    if (error) {
      // Fallback: try to parse simple SELECT queries manually
      console.warn('[Retriever] RPC failed, trying query builder fallback:', error.message);
      return await _fallbackQuery(sql);
    }
    return data || [];
  }

  /**
   * Fallback query builder — handles simple single-table queries
   * when the SQL RPC function is not available.
   */
  async function _fallbackQuery(sql) {
    // Extract table name from "FROM tableName"
    const tableMatch = sql.match(/FROM\s+([a-z_]+)/i);
    if (!tableMatch) return [];
    const table = tableMatch[1];

    // Extract WHERE conditions (simplified)
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/is);
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1]) : _maxRows;

    let query = _supabase.from(table).select('*').limit(limit);

    // Apply simple equality filters from WHERE clause
    if (whereMatch) {
      const where = whereMatch[1];
      // city = 'Mumbai' or city ILIKE '%mumbai%'
      const ilike = where.match(/(\w+)\s+ILIKE\s+'%([^%]+)%'/i);
      if (ilike) query = query.ilike(ilike[1], `%${ilike[2]}%`);
      const eq = where.match(/LOWER\((\w+)\)\s*=\s*LOWER\('([^']+)'\)/i);
      if (eq) query = query.ilike(eq[1], eq[2]);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // ── Intelligence rules engine ─────────────────────────────────────────────

  /**
   * Apply automatic risk flagging rules to result rows.
   * Rule: IF tenant has distress signal AND area > 20000 sqft → flag vacancy risk.
   * @param {Array} rows
   * @param {string} intent
   * @returns {Array} rows with appended riskFlags
   */
  async function _applyRiskRules(rows, intent) {
    if (!['leases', 'buildings', 'distress'].includes(intent)) return rows;
    if (!rows.length) return rows;

    // Load distressed companies from DB
    const { data: distressData } = await _supabase
      .from('distress_events')
      .select('company')
      .gte('confidence', 0.7);

    const distressedSet = new Set(
      (distressData || []).map(r => r.company.toLowerCase())
    );

    return rows.map(row => {
      const tenant = (row.tenant || row.company || '').toLowerCase();
      const isDistressed = distressedSet.has(tenant);
      const area = parseFloat(row.area || 0);
      let riskFlag = null;
      if (isDistressed && area >= 20000) {
        riskFlag = `⚠️ HIGH VACANCY RISK — distressed tenant occupying ${area.toLocaleString()} sq ft`;
      } else if (isDistressed) {
        riskFlag = `🔴 Distressed tenant`;
      }
      return { ...row, _risk_flag: riskFlag };
    });
  }

  // ── Public pipeline ───────────────────────────────────────────────────────

  /**
   * Main query pipeline.
   * @param {string} question - raw user question
   * @param {{ intent: string, confidence: number, city: string|null }} intentResult
   * @param {string} schemaContext
   * @returns {{ sql: string, rows: Array, explanation: string, rowCount: number, riskFlags: number }}
   */
  async function query(question, intentResult, schemaContext) {
    const start = Date.now();

    // 1. Generate SQL
    const sql = await _generateSQL(question, schemaContext);
    console.log('[Retriever] SQL:', sql);

    // 2. Execute against Supabase
    let rows = [];
    let dbError = null;
    try {
      rows = await _executeSQL(sql);
    } catch (err) {
      dbError = err.message;
      console.error('[Retriever] DB error:', err);
    }

    // 3. Apply risk rules
    rows = await _applyRiskRules(rows, intentResult.intent);

    // 4. Generate explanation
    const explanation = dbError
      ? `Database query failed: ${dbError}. Please check your Supabase configuration.`
      : await _explainResults(question, rows);

    const elapsed = Date.now() - start;
    const riskFlags = rows.filter(r => r._risk_flag).length;

    return {
      sql,
      rows,
      explanation,
      rowCount:   rows.length,
      riskFlags,
      elapsedMs:  elapsed,
      intent:     intentResult.intent,
      dbError,
    };
  }

  /**
   * Check if Ollama is reachable.
   * @returns {Promise<{ok: boolean, models: string[]}>}
   */
  async function checkOllamaHealth() {
    try {
      const resp = await fetch(`${_ollamaUrl}/api/tags`, { method: 'GET' });
      if (!resp.ok) return { ok: false, models: [] };
      const data = await resp.json();
      return {
        ok:     true,
        models: (data.models || []).map(m => m.name),
        url:    _ollamaUrl,
      };
    } catch {
      return { ok: false, models: [], url: _ollamaUrl };
    }
  }

  return { init, query, checkOllamaHealth };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Retriever;
}
