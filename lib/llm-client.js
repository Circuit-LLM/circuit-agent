// lib/llm-client.js — single source of truth for the OpenAI-compatible LLM client.
//
// Extracted verbatim from processor.js's inline resolution (model hot-switch, provider /
// key / baseURL, ollama-localhost handling) so reflect-time callers — plan-grade, chat-extract —
// build the identical client instead of re-deriving it (or, as the earlier memory spec did,
// stubbing it with empty strings). processor.js keeps its own error handling + instantiation;
// this only owns the pure resolution and a convenience builder.
'use strict';

const OpenAI = require('openai');

// Pure — returns exactly the values processor.js computed inline. No side effects, no throw.
function resolveLLM(settings = {}) {
  const model     = settings.llm?.model    ?? 'google/gemini-2.5-flash-lite';
  const provider  = settings.llm?.provider ?? 'openrouter';
  const apiKey    = settings.llm?.openrouterKey || process.env.OPENROUTER_API_KEY || '';
  const customUrl = settings.llm?.baseUrl ?? '';

  let baseURL;
  if (customUrl)                  baseURL = customUrl;
  else if (provider === 'ollama') baseURL = 'http://localhost:11434/v1';
  else                            baseURL = 'https://openrouter.ai/api/v1';

  const isLocal = provider === 'ollama' || baseURL.includes('localhost') || baseURL.includes('127.0.0.1');
  return { model, provider, apiKey, customUrl, baseURL, isLocal };
}

// Convenience for callers that just want a ready client (reflect-time batch work).
// Returns null when unconfigured so the caller can degrade gracefully rather than throw.
function buildClient(settings = {}) {
  const r = resolveLLM(settings);
  if (!r.apiKey && !r.isLocal) return null;
  const client = new OpenAI.default({ baseURL: r.baseURL, apiKey: r.apiKey || 'ollama' });
  return { client, model: r.model, isLocal: r.isLocal };
}

module.exports = { resolveLLM, buildClient };
