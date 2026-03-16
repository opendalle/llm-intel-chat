/**
 * chatbot.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Main orchestrator for the chatbot UI.
 * Wires together: IntentClassifier → SchemaRouter → Retriever → Parser
 *
 * All data comes from Supabase — the LLM only generates SQL + explanations.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _supabase   = null;
let _chatHistory = [];
let _ollamaOk   = false;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Init Supabase
  const { createClient } = supabase;
  _supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  // 2. Init modules
  Retriever.init({
    supabase:   _supabase,
    ollamaUrl:  CONFIG.OLLAMA_URL,
    model:      CONFIG.OLLAMA_MODEL,
    maxRows:    CONFIG.MAX_ROWS_RETURNED,
    timeoutMs:  CONFIG.OLLAMA_TIMEOUT_MS,
  });
  KnowledgeGraph.init(_supabase);
  DataImportPanel.init(_supabase);

  // 3. Load dynamic datasets into schema router
  await SchemaRouter.loadDynamicDatasets(_supabase);

  // 4. Check Ollama
  await checkOllama();

  // 5. Load dashboard
  await loadDashboard();

  // 6. Load dataset list
  await loadDatasetList();

  // 7. Load knowledge graph preview
  await loadKGPreview();

  // 8. Bind UI events
  bindChatEvents();
  bindNavEvents();
  bindSettingsEvents();

  // 9. Auto-refresh
  setInterval(loadDashboard, CONFIG.DASHBOARD_REFRESH_MS);
});

// ── Ollama health check ───────────────────────────────────────────────────────

async function checkOllama() {
  const statusEl = document.getElementById('ollama-status');
  const health   = await Retriever.checkOllamaHealth();
  _ollamaOk = health.ok;

  if (statusEl) {
    statusEl.className = `ollama-badge ${health.ok ? 'ok' : 'error'}`;
    statusEl.textContent = health.ok
      ? `🟢 Ollama · ${CONFIG.OLLAMA_MODEL}`
      : `🔴 Ollama offline`;
    statusEl.title = health.ok
      ? `Available models: ${health.models.join(', ')}`
      : 'Start Ollama: ollama serve';
  }
}

// ── Bind chat input events ────────────────────────────────────────────────────

function bindChatEvents() {
  const input   = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');

  if (sendBtn) sendBtn.addEventListener('click', () => submitQuestion());
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); }
    });
  }

  // Example chip buttons
  document.querySelectorAll('.example-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.q;
      if (q) {
        const input = document.getElementById('chat-input');
        if (input) { input.value = q; submitQuestion(); }
      }
    });
  });
}

// ── Navigation tabs ───────────────────────────────────────────────────────────

function bindNavEvents() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(`tab-${target}`);
      if (panel) panel.classList.add('active');

      // Lazy-load graph when tab opens
      if (target === 'graph') loadKGPreview();
    });
  });
}

// ── Settings panel ────────────────────────────────────────────────────────────

function bindSettingsEvents() {
  const ollamaInput = document.getElementById('setting-ollama-url');
  const modelInput  = document.getElementById('setting-model');
  const saveBtn     = document.getElementById('save-settings');

  if (ollamaInput) ollamaInput.value = CONFIG.OLLAMA_URL;
  if (modelInput)  modelInput.value  = CONFIG.OLLAMA_MODEL;

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (ollamaInput) CONFIG.OLLAMA_URL   = ollamaInput.value.trim();
      if (modelInput)  CONFIG.OLLAMA_MODEL = modelInput.value.trim();
      Retriever.init({ supabase: _supabase, ollamaUrl: CONFIG.OLLAMA_URL, model: CONFIG.OLLAMA_MODEL });
      await checkOllama();
      saveBtn.textContent = '✅ Saved';
      setTimeout(() => saveBtn.textContent = 'Save Settings', 2000);
    });
  }
}

// ── Main question pipeline ────────────────────────────────────────────────────

async function submitQuestion() {
  const input   = document.getElementById('chat-input');
  const question = (input?.value || '').trim();
  if (!question) return;

  input.value = '';
  appendUserMessage(question);

  // Store in history
  _chatHistory.push({ role: 'user', content: question });

  const thinkingId = appendThinkingMessage();

  try {
    // 1. Classify intent
    const intentResult = IntentClassifier.classify(question);
    updateThinking(thinkingId, `Intent: <strong>${intentResult.intent}</strong> · City: ${intentResult.city || 'Any'}`);

    if (!_ollamaOk) {
      throw new Error('Ollama is offline. Please start Ollama: run "ollama serve" in your terminal first.');
    }

    // 2. Build schema context
    const schemaContext = SchemaRouter.buildSchemaContext(intentResult.intent);
    updateThinking(thinkingId, `Routing to tables: ${SchemaRouter.getTablesForIntent(intentResult.intent).join(', ')}`);

    // 3. Execute retrieval pipeline
    const result = await Retriever.query(question, intentResult, schemaContext);
    updateThinking(thinkingId, `Query returned ${result.rowCount} rows ${result.riskFlags ? `· ⚠️ ${result.riskFlags} risk alerts` : ''}`);

    // 4. Render response
    const summaryHTML = Parser.renderSummaryCard(result.rows, result.intent);
    const tableHTML   = Parser.renderTable(result.rows);

    removeThinking(thinkingId);
    appendAssistantMessage({
      question,
      explanation: result.explanation,
      sql:         result.sql,
      summaryHTML,
      tableHTML,
      rowCount:    result.rowCount,
      riskFlags:   result.riskFlags,
      intent:      result.intent,
      elapsedMs:   result.elapsedMs,
    });

    // Store KG edges if expansaion/distress found
    if (result.rowCount > 0) {
      await autoUpdateKnowledgeGraph(result.rows, intentResult.intent);
    }

    _chatHistory.push({ role: 'assistant', content: result.explanation });

  } catch (err) {
    removeThinking(thinkingId);
    appendErrorMessage(err.message);
    console.error('[Chatbot]', err);
  }

  scrollChatToBottom();
}

// ── Message rendering ─────────────────────────────────────────────────────────

function appendUserMessage(text) {
  const thread = document.getElementById('chat-thread');
  if (!thread) return;
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `
    <div class="msg-avatar">YO</div>
    <div class="msg-body">
      <p class="msg-text">${escHtml(text)}</p>
      <span class="msg-time">${formatTime()}</span>
    </div>`;
  thread.appendChild(div);
}

function appendThinkingMessage() {
  const thread = document.getElementById('chat-thread');
  if (!thread) return 'thinking';
  const id = 'thinking-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg msg-ai thinking';
  div.id = id;
  div.innerHTML = `
    <div class="msg-avatar ai-avatar">NX</div>
    <div class="msg-body">
      <div class="thinking-dots"><span></span><span></span><span></span></div>
      <p class="thinking-status" id="${id}-status">Analyzing question...</p>
    </div>`;
  thread.appendChild(div);
  scrollChatToBottom();
  return id;
}

function updateThinking(id, statusText) {
  const el = document.getElementById(`${id}-status`);
  if (el) el.innerHTML = statusText;
}

function removeThinking(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function appendAssistantMessage({ question, explanation, sql, summaryHTML, tableHTML, rowCount, riskFlags, intent, elapsedMs }) {
  const thread = document.getElementById('chat-thread');
  if (!thread) return;
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.innerHTML = `
    <div class="msg-avatar ai-avatar">NX</div>
    <div class="msg-body full-width">
      ${summaryHTML || ''}
      <div class="explanation">${markdownToHtml(explanation)}</div>
      <div class="result-section">
        <div id="table-container">${tableHTML}</div>
      </div>
      <details class="sql-details">
        <summary>🔍 View SQL Query</summary>
        <pre class="sql-code">${escHtml(sql)}</pre>
      </details>
      <div class="msg-meta">
        <span class="badge-intent">${intent}</span>
        <span class="msg-time">${formatTime()} · ${elapsedMs}ms</span>
        ${riskFlags ? `<span class="risk-count">⚠️ ${riskFlags} risk alerts</span>` : ''}
      </div>
    </div>`;
  thread.appendChild(div);
}

function appendErrorMessage(msg) {
  const thread = document.getElementById('chat-thread');
  if (!thread) return;
  const div = document.createElement('div');
  div.className = 'msg msg-ai msg-error';
  div.innerHTML = `
    <div class="msg-avatar ai-avatar err">!</div>
    <div class="msg-body">
      <p class="error-text">⚠️ ${escHtml(msg)}</p>
      <span class="msg-time">${formatTime()}</span>
    </div>`;
  thread.appendChild(div);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function loadDashboard() {
  await Promise.allSettled([
    loadDistressAlerts(),
    loadLeaseExpiries(),
    loadExpansionLeads(),
    loadBuildingRisks(),
  ]);
}

async function loadDistressAlerts() {
  const el = document.getElementById('distress-list');
  if (!el) return;
  const { data, error } = await _supabase
    .from('distress_events')
    .select('company, signal, severity, detected_at, source')
    .order('detected_at', { ascending: false })
    .limit(10);

  if (error || !data?.length) {
    el.innerHTML = '<p class="empty-card">No distress signals detected yet.</p>'; return;
  }
  el.innerHTML = data.map(d => `
    <div class="alert-item sev-${d.severity}">
      <div class="alert-company">${escHtml(d.company)}</div>
      <div class="alert-meta">
        <span class="badge-signal">${d.signal}</span>
        <span class="badge-source">${d.source}</span>
        <span class="alert-date">${formatDate(d.detected_at)}</span>
      </div>
    </div>`).join('');

  // Update counter
  const counter = document.getElementById('distress-count');
  if (counter) counter.textContent = data.length;
}

async function loadLeaseExpiries() {
  const el = document.getElementById('expiry-list');
  if (!el) return;
  const { data, error } = await _supabase
    .from('lease_risk_dashboard')
    .select('tenant, building_name, city, area, lease_expiry, expiry_risk, distress_signal')
    .in('expiry_risk', ['CRITICAL', 'HIGH', 'MEDIUM'])
    .order('lease_expiry', { ascending: true })
    .limit(10);

  if (error || !data?.length) {
    el.innerHTML = '<p class="empty-card">No upcoming lease expiries.</p>'; return;
  }

  el.innerHTML = data.map(r => `
    <div class="expiry-item risk-${r.expiry_risk}">
      <div class="expiry-tenant">${escHtml(r.tenant)}</div>
      <div class="expiry-building">${escHtml(r.building_name)} · ${r.city}</div>
      <div class="expiry-meta">
        <span class="badge-risk">${r.expiry_risk}</span>
        <span>${formatDate(r.lease_expiry)}</span>
        <span>${(r.area || 0).toLocaleString()} sqft</span>
        ${r.distress_signal ? `<span class="badge-distress">⚠️ ${r.distress_signal}</span>` : ''}
      </div>
    </div>`).join('');
}

async function loadExpansionLeads() {
  const el = document.getElementById('expansion-list');
  if (!el) return;
  const { data, error } = await _supabase
    .from('demand_signals')
    .select('company, signal, city, headline, confidence, detected_at')
    .order('detected_at', { ascending: false })
    .limit(10);

  if (error || !data?.length) {
    el.innerHTML = '<p class="empty-card">No expansion signals detected yet.</p>'; return;
  }

  el.innerHTML = data.map(d => `
    <div class="expansion-item">
      <div class="exp-company">${escHtml(d.company)}</div>
      <div class="exp-headline">${escHtml(d.headline || '')}</div>
      <div class="exp-meta">
        <span class="badge-signal exp">${d.signal}</span>
        ${d.city ? `<span class="badge-city">${d.city}</span>` : ''}
        <span class="confidence">${Math.round((d.confidence || 0.8) * 100)}% conf.</span>
        <span class="alert-date">${formatDate(d.detected_at)}</span>
      </div>
    </div>`).join('');
}

async function loadBuildingRisks() {
  const el = document.getElementById('building-risk-list');
  if (!el) return;
  const { data, error } = await _supabase
    .from('building_distress_exposure')
    .select('*')
    .order('distressed_tenants', { ascending: false })
    .limit(8);

  if (error || !data?.length) {
    el.innerHTML = '<p class="empty-card">No building risks detected.</p>'; return;
  }

  el.innerHTML = data.map(b => `
    <div class="building-risk-item">
      <div class="bldg-name">${escHtml(b.building_name)}</div>
      <div class="bldg-city">${b.city}</div>
      <div class="bldg-meta">
        <span class="badge-red">${b.distressed_tenants} distressed</span>
        <span>${(b.exposed_sqft || 0).toLocaleString()} sqft at risk</span>
        <span>₹${(b.exposed_monthly_rent || 0).toLocaleString('en-IN', {maximumFractionDigits:0})} /mo</span>
      </div>
    </div>`).join('');
}

// ── Dataset list ──────────────────────────────────────────────────────────────

async function loadDatasetList() {
  const el = document.getElementById('dataset-list');
  if (!el) return;
  const { data, error } = await _supabase
    .from('datasets')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data?.length) {
    el.innerHTML = '<p class="empty-card">No datasets imported yet.</p>'; return;
  }

  el.innerHTML = data.map(d => `
    <div class="dataset-item">
      <div class="ds-name">${escHtml(d.dataset_name)}</div>
      <div class="ds-table"><code>${d.table_name}</code></div>
      <div class="ds-meta">
        <span>${d.row_count || 0} rows</span>
        <span>${formatDate(d.created_at)}</span>
        <button class="btn-query-ds" onclick="queryDataset('${escHtml(d.table_name)}', '${escHtml(d.dataset_name)}')">Query</button>
      </div>
    </div>`).join('');
}

function queryDataset(tableName, name) {
  const input = document.getElementById('chat-input');
  if (input) {
    input.value = `Show me the data from ${name}`;
    document.querySelector('.nav-tab[data-tab="chat"]')?.click();
    submitQuestion();
  }
}

// ── Knowledge graph visualization ─────────────────────────────────────────────

async function loadKGPreview() {
  const container = document.getElementById('kg-container');
  if (!container) return;

  try {
    const graphData = await KnowledgeGraph.getFullGraph(200);
    if (!graphData.nodes.length) {
      container.innerHTML = '<p class="empty-card" style="text-align:center;padding:40px">No knowledge graph data yet. Data is auto-populated as crawlers run and leases are imported.</p>';
      return;
    }
    renderD3Graph(container, graphData);
  } catch (err) {
    container.innerHTML = `<p class="empty-card">Graph unavailable: ${escHtml(err.message)}</p>`;
  }
}

function renderD3Graph(container, { nodes, links }) {
  // Simple D3 force simulation (D3 v7 loaded in HTML)
  container.innerHTML = '<svg id="kg-svg" width="100%" height="500"></svg>';
  const svg    = d3.select('#kg-svg');
  const width  = container.offsetWidth || 800;
  const height = 500;

  const sim = d3.forceSimulation(nodes)
    .force('link',   d3.forceLink(links).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.size + 5));

  const link = svg.append('g').selectAll('line').data(links).enter().append('line')
    .attr('stroke', '#334155').attr('stroke-width', d => Math.sqrt(d.weight));

  const node = svg.append('g').selectAll('circle').data(nodes).enter().append('circle')
    .attr('r', d => d.size).attr('fill', d => d.color || '#94a3b8')
    .attr('stroke', '#0a0f1e').attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end',   (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('click', (event, d) => {
      // Show entity info
      const info = document.getElementById('kg-info');
      if (info) info.innerHTML = `<strong>${escHtml(d.id)}</strong> <span class="badge-intent">${d.type}</span>`;
    });

  // Labels
  const label = svg.append('g').selectAll('text').data(nodes).enter().append('text')
    .attr('font-size', '10px').attr('fill', '#94a3b8').attr('text-anchor', 'middle')
    .attr('dy', d => d.size + 12)
    .text(d => d.id.length > 18 ? d.id.substring(0, 16) + '…' : d.id);

  sim.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
    label.attr('x', d => d.x).attr('y', d => d.y);
  });
}

// ── Auto KG update ────────────────────────────────────────────────────────────

async function autoUpdateKnowledgeGraph(rows, intent) {
  try {
    if (intent === 'leases' && rows.length) {
      const edges = rows
        .filter(r => r.tenant && r.building_name)
        .map(r => ({
          entityA: r.tenant, entityAType: 'company',
          entityB: r.building_name, entityBType: 'building',
          relationship: 'occupies', source: 'chatbot_query',
          metadata: { area: r.area, expiry: r.lease_expiry },
        }));
      if (edges.length) await KnowledgeGraph.addEdges(edges);
    }
  } catch (e) {
    console.warn('[KG auto-update]', e);
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function scrollChatToBottom() {
  const thread = document.getElementById('chat-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      year: 'numeric', month: 'short', day: '2-digit'
    });
  } catch { return dateStr; }
}

function markdownToHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>')
    .replace(/^- (.+)$/gm,     '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(.+)$/, '<p>$1</p>');
}
