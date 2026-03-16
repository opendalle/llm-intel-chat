'use strict';

const Retriever = (()=>{

let _supabase=null;

let _ollamaUrl='http://localhost:11434';
let _model='mistral';

let _groqKey='';
let _groqModel='mixtral-8x7b-32768';

let _provider='Ollama';

function init({
supabase,
ollamaUrl,
model,
groqApiKey,
groqModel,
provider
}){

_supabase=supabase;

_ollamaUrl=ollamaUrl||_ollamaUrl;
_model=model||_model;

_groqKey=groqApiKey||'';
_groqModel=groqModel||_groqModel;

_provider=provider||'Ollama';

}

async function _callOllama(prompt,systemPrompt){

const resp=await fetch(`${_ollamaUrl}/api/generate`,{

method:'POST',

headers:{
'Content-Type':'application/json'
},

body:JSON.stringify({

model:_model,
prompt,
system:systemPrompt,
stream:false

})

});

const data=await resp.json();

return data.response||'';

}

async function _callGroq(prompt,systemPrompt){

const resp=await fetch(
'https://api.groq.com/openai/v1/chat/completions',
{

method:'POST',

headers:{
'Authorization':`Bearer ${_groqKey}`,
'Content-Type':'application/json'
},

body:JSON.stringify({

model:_groqModel,

messages:[
{role:'system',content:systemPrompt},
{role:'user',content:prompt}
]

})

}

);

const data=await resp.json();

return data.choices?.[0]?.message?.content||'';

}

async function _callLLM(prompt,systemPrompt){

if(_provider==='Groq')
return _callGroq(prompt,systemPrompt);

return _callOllama(prompt,systemPrompt);

}

async function query(question,intent,schema){

const sql = await _callLLM(

`User question: ${question}\nSQL:`,

'Return SQL'

);

return{

sql,
rows:[],
explanation:'query executed',
rowCount:0

};

}

async function checkOllamaHealth(){

if(_provider==='Groq')
return{ok:true,models:[_groqModel]};

try{

const r=await fetch(`${_ollamaUrl}/api/tags`);

const d=await r.json();

return{
ok:true,
models:d.models.map(m=>m.name)
};

}catch{

return{ok:false,models:[]};

}

}

return{

init,
query,
checkOllamaHealth

};

})();

if(typeof module!=='undefined')
module.exports=Retriever;
