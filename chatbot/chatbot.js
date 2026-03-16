'use strict';

let _supabase = null;
let _ollamaOk = false;

document.addEventListener('DOMContentLoaded', async () => {

const { createClient } = supabase;

_supabase = createClient(
CONFIG.SUPABASE_URL,
CONFIG.SUPABASE_ANON_KEY
);

Retriever.init({

supabase:_supabase,

ollamaUrl:CONFIG.OLLAMA_URL,
model:CONFIG.OLLAMA_MODEL,

groqApiKey:CONFIG.GROQ_API_KEY,
groqModel:CONFIG.GROQ_MODEL,

provider:CONFIG.LLM_PROVIDER

});

bindSettingsEvents();

await checkOllama();

bindChat();

});

async function checkOllama(){

const statusEl = document.getElementById('ollama-status');
const llmEl = document.getElementById('llm-provider');

if(CONFIG.LLM_PROVIDER === 'Groq'){

if(statusEl){
statusEl.className='ollama-badge ok';
statusEl.textContent=`🚀 Groq · ${CONFIG.GROQ_MODEL}`;
}

if(llmEl)
llmEl.textContent=`Groq · ${CONFIG.GROQ_MODEL}`;

_ollamaOk=true;

return;
}

const health = await Retriever.checkOllamaHealth();

_ollamaOk=health.ok;

if(statusEl){

statusEl.className=`ollama-badge ${health.ok?'ok':'error'}`;

statusEl.textContent=health.ok
?`🟢 Ollama · ${CONFIG.OLLAMA_MODEL}`
:`🔴 Ollama offline`;

}

if(llmEl)
llmEl.textContent=`Ollama · ${CONFIG.OLLAMA_MODEL}`;

}

function bindSettingsEvents(){

const ollamaInput=document.getElementById('setting-ollama-url');
const modelInput=document.getElementById('setting-model');

const groqKey=document.getElementById('setting-groq-api-key');
const groqModel=document.getElementById('setting-groq-model');
const provider=document.getElementById('setting-llm-provider');

const saveBtn=document.getElementById('save-settings');

if(ollamaInput)ollamaInput.value=CONFIG.OLLAMA_URL;
if(modelInput)modelInput.value=CONFIG.OLLAMA_MODEL;

if(groqKey)groqKey.value=CONFIG.GROQ_API_KEY||'';
if(groqModel)groqModel.value=CONFIG.GROQ_MODEL||'mixtral-8x7b-32768';

if(provider)provider.value=CONFIG.LLM_PROVIDER||'Ollama';

if(saveBtn){

saveBtn.addEventListener('click',async()=>{

CONFIG.OLLAMA_URL=ollamaInput.value.trim();
CONFIG.OLLAMA_MODEL=modelInput.value.trim();

CONFIG.GROQ_API_KEY=groqKey.value.trim();
CONFIG.GROQ_MODEL=groqModel.value.trim();

CONFIG.LLM_PROVIDER=provider.value;

Retriever.init({

supabase:_supabase,

ollamaUrl:CONFIG.OLLAMA_URL,
model:CONFIG.OLLAMA_MODEL,

groqApiKey:CONFIG.GROQ_API_KEY,
groqModel:CONFIG.GROQ_MODEL,

provider:CONFIG.LLM_PROVIDER

});

await checkOllama();

saveBtn.textContent='Saved';

setTimeout(()=>{

saveBtn.textContent='Save Settings';

},2000);

});

}

}

function bindChat(){

const sendBtn=document.getElementById('send-btn');
const input=document.getElementById('chat-input');

sendBtn.addEventListener('click',submitQuestion);

input.addEventListener('keydown',e=>{

if(e.key==='Enter'){
e.preventDefault();
submitQuestion();
}

});

}

async function submitQuestion(){

const input=document.getElementById('chat-input');

const q=input.value.trim();

if(!q)return;

input.value='';

const res = await Retriever.query(
q,
{intent:'generic'},
''
);

console.log(res);

}
