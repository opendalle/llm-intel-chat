/**

* chatbot.js — NEXUS ASIA CRE Intelligence Platform
* ============================================================
* Main orchestrator for the chatbot UI.
* Wires together: IntentClassifier → SchemaRouter → Retriever → Parser
*
* Supports dual LLM providers:
* • Ollama (local)
* • Groq (cloud)
  */

'use strict';

/* ────────────────────────────────────────────────────────────
STATE
──────────────────────────────────────────────────────────── */

let _supabase    = null;
let _chatHistory = [];
let _ollamaOk    = false;

/* ────────────────────────────────────────────────────────────
BOOTSTRAP
──────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {

const { createClient } = supabase;
_supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

Retriever.init({
supabase:   _supabase,
ollamaUrl:  CONFIG.OLLAMA_URL,
model:      CONFIG.OLLAMA_MODEL,
groqApiKey: CONFIG.GROQ_API_KEY,
groqModel:  CONFIG.GROQ_MODEL,
provider:   CONFIG.LLM_PROVIDER,
maxRows:    CONFIG.MAX_ROWS_RETURNED,
timeoutMs:  CONFIG.OLLAMA_TIMEOUT_MS
});

KnowledgeGraph.init(_supabase);
DataImportPanel.init(_supabase);

await SchemaRouter.loadDynamicDatasets(_supabase);

await checkOllama();
await loadDashboard();
await loadDatasetList();
await loadKGPreview();

bindChatEvents();
bindNavEvents();
bindSettingsEvents();

setInterval(loadDashboard, CONFIG.DASHBOARD_REFRESH_MS);
});

/* ────────────────────────────────────────────────────────────
OLLAMA HEALTH CHECK
──────────────────────────────────────────────────────────── */

async function checkOllama() {

const statusEl = document.getElementById('ollama-status');

if (CONFIG.LLM_PROVIDER === 'Groq') {
if (statusEl) {
statusEl.className = 'ollama-badge ok';
statusEl.textContent = `🚀 Groq · ${CONFIG.GROQ_MODEL}`;
statusEl.title = 'Cloud LLM active';
}
_ollamaOk = true;
return;
}

const health = await Retriever.checkOllamaHealth();
_ollamaOk = health.ok;

if (statusEl) {

```
statusEl.className = `ollama-badge ${health.ok ? 'ok' : 'error'}`;

statusEl.textContent = health.ok
  ? `🟢 Ollama · ${CONFIG.OLLAMA_MODEL}`
  : `🔴 Ollama offline`;

statusEl.title = health.ok
  ? `Available models: ${health.models.join(', ')}`
  : 'Start Ollama: ollama serve';
```

}
}

/* ────────────────────────────────────────────────────────────
CHAT INPUT EVENTS
──────────────────────────────────────────────────────────── */

function bindChatEvents() {

const input   = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

if (sendBtn)
sendBtn.addEventListener('click', () => submitQuestion());

if (input) {

```
input.addEventListener('keydown', e => {

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitQuestion();
  }

});
```

}

document.querySelectorAll('.example-chip').forEach(btn => {

```
btn.addEventListener('click', () => {

  const q = btn.dataset.q;

  if (q) {
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = q;
      submitQuestion();
    }
  }

});
```

});

}

/* ────────────────────────────────────────────────────────────
NAVIGATION
──────────────────────────────────────────────────────────── */

function bindNavEvents() {

document.querySelectorAll('.nav-tab').forEach(tab => {

```
tab.addEventListener('click', () => {

  const target = tab.dataset.tab;

  document.querySelectorAll('.nav-tab')
    .forEach(t => t.classList.remove('active'));

  document.querySelectorAll('.tab-content')
    .forEach(p => p.classList.remove('active'));

  tab.classList.add('active');

  const panel = document.getElementById(`tab-${target}`);
  if (panel) panel.classList.add('active');

  if (target === 'graph')
    loadKGPreview();

});
```

});

}

/* ────────────────────────────────────────────────────────────
SETTINGS PANEL
──────────────────────────────────────────────────────────── */

function bindSettingsEvents() {

const ollamaInput    = document.getElementById('setting-ollama-url');
const modelInput     = document.getElementById('setting-model');

const groqKeyInput   = document.getElementById('setting-groq-api-key');
const groqModelInput = document.getElementById('setting-groq-model');
const providerInput  = document.getElementById('setting-llm-provider');

const saveBtn        = document.getElementById('save-settings');

if (ollamaInput) ollamaInput.value = CONFIG.OLLAMA_URL;
if (modelInput)  modelInput.value  = CONFIG.OLLAMA_MODEL;

if (groqKeyInput)   groqKeyInput.value   = CONFIG.GROQ_API_KEY || '';
if (groqModelInput) groqModelInput.value = CONFIG.GROQ_MODEL || 'mixtral-8x7b-32768';

if (providerInput)  providerInput.value  = CONFIG.LLM_PROVIDER || 'Ollama';

if (saveBtn) {

```
saveBtn.addEventListener('click', async () => {

  if (ollamaInput) CONFIG.OLLAMA_URL   = ollamaInput.value.trim();
  if (modelInput)  CONFIG.OLLAMA_MODEL = modelInput.value.trim();

  if (groqKeyInput)   CONFIG.GROQ_API_KEY = groqKeyInput.value.trim();
  if (groqModelInput) CONFIG.GROQ_MODEL   = groqModelInput.value.trim();

  if (providerInput)  CONFIG.LLM_PROVIDER = providerInput.value;


  Retriever.init({

    supabase:   _supabase,

    ollamaUrl:  CONFIG.OLLAMA_URL,
    model:      CONFIG.OLLAMA_MODEL,

    groqApiKey: CONFIG.GROQ_API_KEY,
    groqModel:  CONFIG.GROQ_MODEL,

    provider:   CONFIG.LLM_PROVIDER,

    maxRows:    CONFIG.MAX_ROWS_RETURNED,
    timeoutMs:  CONFIG.OLLAMA_TIMEOUT_MS

  });

  await checkOllama();

  saveBtn.textContent = '✅ Saved';

  setTimeout(() => {
    saveBtn.textContent = 'Save Settings';
  }, 2000);

});
```

}

}

/* ────────────────────────────────────────────────────────────
QUESTION PIPELINE
──────────────────────────────────────────────────────────── */

async function submitQuestion() {

const input    = document.getElementById('chat-input');
const question = (input?.value || '').trim();

if (!question) return;

input.value = '';

appendUserMessage(question);

_chatHistory.push({ role:'user', content:question });

const thinkingId = appendThinkingMessage();

try {

```
const intentResult = IntentClassifier.classify(question);

updateThinking(thinkingId,
  `Intent: <strong>${intentResult.intent}</strong> · City: ${intentResult.city || 'Any'}`);

if (!_ollamaOk)
  throw new Error('LLM unavailable.');

const schemaContext = SchemaRouter.buildSchemaContext(intentResult.intent);

updateThinking(thinkingId,
  `Routing to tables: ${SchemaRouter.getTablesForIntent(intentResult.intent).join(', ')}`);

const result = await Retriever.query(question, intentResult, schemaContext);

updateThinking(thinkingId,
  `Query returned ${result.rowCount} rows`);

const summaryHTML = Parser.renderSummaryCard(result.rows, result.intent);
const tableHTML   = Parser.renderTable(result.rows);

removeThinking(thinkingId);

appendAssistantMessage({

  question,
  explanation: result.explanation,
  sql: result.sql,
  summaryHTML,
  tableHTML,
  rowCount: result.rowCount,
  intent: result.intent,
  elapsedMs: result.elapsedMs

});

_chatHistory.push({ role:'assistant', content:result.explanation });
```

}

catch(err) {

```
removeThinking(thinkingId);

appendErrorMessage(err.message);

console.error(err);
```

}

scrollChatToBottom();

}

/* ────────────────────────────────────────────────────────────
MESSAGE RENDERING
──────────────────────────────────────────────────────────── */

function appendUserMessage(text) {

const thread = document.getElementById('chat-thread');

const div = document.createElement('div');

div.className = 'msg msg-user';

div.innerHTML =
`<div class="msg-avatar">YO</div>

   <div class="msg-body">
   <p class="msg-text">${escHtml(text)}</p>
   <span class="msg-time">${formatTime()}</span>
   </div>`;

thread.appendChild(div);

}

function appendErrorMessage(msg) {

const thread = document.getElementById('chat-thread');

const div = document.createElement('div');

div.className = 'msg msg-ai msg-error';

div.innerHTML =
`<div class="msg-avatar ai-avatar err">!</div>

   <div class="msg-body">
   <p class="error-text">${escHtml(msg)}</p>
   <span class="msg-time">${formatTime()}</span>
   </div>`;

thread.appendChild(div);

}

/* ────────────────────────────────────────────────────────────
UTILS
──────────────────────────────────────────────────────────── */

function scrollChatToBottom() {

const thread = document.getElementById('chat-thread');

if (thread)
thread.scrollTop = thread.scrollHeight;

}

function escHtml(str) {

if (!str) return '';

return String(str)
.replace(/&/g,'&')
.replace(/</g,'<')
.replace(/>/g,'>');

}

function formatTime() {

return new Date().toLocaleTimeString('en-IN',{
hour:'2-digit',
minute:'2-digit'
});

}
