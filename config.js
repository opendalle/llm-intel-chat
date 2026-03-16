const config = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  OLLAMA_API: process.env.OLLAMA_API,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: process.env.GROQ_MODEL,
  LLM_PROVIDER: process.env.LLM_PROVIDER || 'Ollama',
  // Additional configurations if needed
};

export default config;