// Updated retriever.js to support Groq LLM alongside Ollama

const CONFIG = require('./config');

function getLLMProvider() {
    switch (CONFIG.LLM_PROVIDER) {
        case 'Ollama':
            return initOllama();
        case 'Groq':
            return initGroq();
        default:
            throw new Error("Invalid LLM provider specified.");
    }
}

function initOllama() {
    // Implementation for Ollama support
}

function initGroq() {
    // Implementation for Groq LLM support
}

module.exports = { getLLMProvider };