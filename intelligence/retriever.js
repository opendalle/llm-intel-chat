/**

* retriever.js — NEXUS ASIA CRE Intelligence Platform
* ============================================================
* Retrieval pipeline orchestrator.
*
* Supports:
* • Ollama (local)
* • Groq (cloud)
*
* Flow:
* question → intent → schema → SQL (LLM) → Supabase → explanation (LLM)
  */

'use strict';

const Retriever = (() => {

let _supabase   = null;

let _ollamaUrl  = 'http://localhost:11434';
let _model      = 'mistral';

let _groqKey    = '';
let _groqModel  = 'mixtral-8x7b-32768';

let _provider   = 'Ollama';

let _maxRows    = 500;
let _timeoutMs  = 60000;

const FORBIDDEN_SQL_PATTERN =
/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i;

/* ─────────────────────────────────────────────────────────
INIT
───────────────────────────────────────────────────────── */

function init({
supabase,
ollamaUrl,
model,
groqApiKey,
groqModel,
provider,
maxRows,
timeoutMs
}) {

```
_supabase  = supabase;

_ollamaUrl = ollamaUrl  || _ollamaUrl;
_model     = model      || _model;

_groqKey   = groqApiKey || '';
_groqModel = groqModel  || _groqModel;

_provider  = provider   || 'Ollama';

_maxRows   = maxRows    || 500;
_timeoutMs = timeoutMs  || 60000;
```

}

/* ─────────────────────────────────────────────────────────
OLLAMA CALL
───────────────────────────────────────────────────────── */

async function _callOllama(prompt, systemPrompt, temperature=0.05) {

```
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), _timeoutMs);

try {

  const resp = await fetch(`${_ollamaUrl}/api/generate`, {

    method: 'POST',

    headers: { 'Content-Type': 'application/json' },

    body: JSON.stringify({
      model: _model,
      prompt,
      system: systemPrompt,
      stream: false,
      options:{
        temperature,
        num_predict:2048,
        top_p:0.9
      }
    }),

    signal: controller.signal
  });

  if (!resp.ok)
    throw new Error(`Ollama HTTP ${resp.status}`);

  const data = await resp.json();

  return (data.response || '').trim();

} finally {

  clearTimeout(timer);

}
```

}

/* ─────────────────────────────────────────────────────────
GROQ CALL
───────────────────────────────────────────────────────── */

async function _callGroq(prompt, systemPrompt, temperature=0.05) {

```
if (!_groqKey)
  throw new Error('Groq API key not configured');

const resp = await fetch(
  'https://api.groq.com/openai/v1/chat/completions',
  {
    method:'POST',

    headers:{
      'Authorization':`Bearer ${_groqKey}`,
      'Content-Type':'application/json'
    },

    body:JSON.stringify({

      model:_groqModel,

      temperature,

      messages:[
        { role:'system', content:systemPrompt },
        { role:'user',   content:prompt }
      ]

    })
  }
);

if (!resp.ok)
  throw new Error(`Groq HTTP ${resp.status}`);

const data = await resp.json();

return data.choices?.[0]?.message?.content?.trim() || '';
```

}

/* ─────────────────────────────────────────────────────────
PROVIDER ROUTER
───────────────────────────────────────────────────────── */

async function _callLLM(prompt, systemPrompt, temperature=0.05) {

```
if (_provider === 'Groq')
  return _callGroq(prompt, systemPrompt, temperature);

return _callOllama(prompt, systemPrompt, temperature);
```

}

/* ─────────────────────────────────────────────────────────
SQL GENERATION
───────────────────────────────────────────────────────── */

const SQL_SYSTEM = `
You are a PostgreSQL SQL expert for a Commercial Real Estate intelligence platform.

Output ONLY a raw SQL SELECT statement.

Rules:

* Never use INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE.
* Use ILIKE for case-insensitive matching.
* Always include LIMIT {maxRows}.
* Only reference schema provided.

Schema:
{schema}
`;

async function _generateSQL(question, schemaContext) {

````
const systemPrompt = SQL_SYSTEM
  .replace('{maxRows}',_maxRows)
  .replace('{schema}',schemaContext);

const prompt = `User question: ${question}\n\nSQL query:`;

let sql = await _callLLM(prompt,systemPrompt,0.05);

sql = sql
  .replace(/```sql\s*/gi,'')
  .replace(/```\s*/g,'')
  .replace(/;+$/,'')
  .trim();

if (FORBIDDEN_SQL_PATTERN.test(sql))
  return `SELECT 'Query blocked for safety' AS message`;

if (!/\bLIMIT\b/i.test(sql))
  sql += ` LIMIT ${_maxRows}`;

return sql;
````

}

/* ─────────────────────────────────────────────────────────
EXPLANATION GENERATION
───────────────────────────────────────────────────────── */

const EXPLAIN_SYSTEM = `
You are a Commercial Real Estate analyst.

Explain the results strictly from the data.

Rules:

* No invented data
* If empty say "No records found"
* 2-4 sentence summary
* bullet findings
  `;

  async function _explainResults(question,rows){

  if(!rows.length)
  return 'No records were found in the database matching your query.';

  const sample = JSON.stringify(rows.slice(0,50),null,2);

  const prompt = `
  Question: ${question}

Database rows:
${sample}

Analysis:
`;

```
return _callLLM(prompt,EXPLAIN_SYSTEM,0.2);
```

}

/* ─────────────────────────────────────────────────────────
SQL EXECUTION
───────────────────────────────────────────────────────── */

async function _executeSQL(sql){

```
const { data, error } =
  await _supabase.rpc('nexus_execute_sql',{ query_text: sql });

if(error)
  throw error;

return data || [];
```

}

/* ─────────────────────────────────────────────────────────
PIPELINE
───────────────────────────────────────────────────────── */

async function query(question,intentResult,schemaContext){

```
const start = Date.now();

const sql = await _generateSQL(question,schemaContext);

let rows=[];
let dbError=null;

try{

  rows = await _executeSQL(sql);

}catch(err){

  dbError = err.message;

}

const explanation = dbError
  ? `Database query failed: ${dbError}`
  : await _explainResults(question,rows);

return {

  sql,

  rows,

  explanation,

  rowCount: rows.length,

  elapsedMs: Date.now()-start,

  intent: intentResult.intent,

  riskFlags:0,

  dbError

};
```

}

/* ─────────────────────────────────────────────────────────
OLLAMA HEALTH CHECK
───────────────────────────────────────────────────────── */

async function checkOllamaHealth(){

```
if(_provider === 'Groq')
  return { ok:true, models:[_groqModel] };

try{

  const resp =
    await fetch(`${_ollamaUrl}/api/tags`);

  const data = await resp.json();

  return {
    ok:true,
    models:(data.models||[]).map(m=>m.name)
  };

}catch{

  return { ok:false, models:[] };

}
```

}

return {

```
init,
query,
checkOllamaHealth
```

};

})();

if(typeof module !== 'undefined' && module.exports){
module.exports = Retriever;
}
