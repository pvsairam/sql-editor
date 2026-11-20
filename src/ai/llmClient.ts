import * as vscode from 'vscode';
import { settings } from '../config';
import { httpRequest } from '../fusion/http';
import { FusionError } from '../fusion/errors';

export const AI_API_KEY_SECRET = 'fusionSqlDev.ai.apiKey';

export interface LlmOptions {
  requestModel?: vscode.LanguageModelChat;
  signal?: AbortSignal;
  token?: vscode.CancellationToken;
  systemPrompt?: string;
}

export interface LlmResult {
  text: string;
  providerLabel: string;
}

function defaultEndpoint(provider: 'openai' | 'ollama'): string {
  return provider === 'ollama' ? 'http://localhost:11434/api/chat' : 'https://api.openai.com/v1/chat/completions';
}

function defaultModel(provider: 'openai' | 'ollama'): string {
  return provider === 'ollama' ? 'llama3.1' : 'gpt-4o-mini';
}

async function callByok(
  ctx: vscode.ExtensionContext,
  provider: 'openai' | 'ollama',
  userPrompt: string,
  opts: LlmOptions
): Promise<LlmResult> {
  const endpoint = settings.aiEndpoint || defaultEndpoint(provider);
  const model = settings.aiModel || defaultModel(provider);
  const apiKey = await ctx.secrets.get(AI_API_KEY_SECRET);

  if (provider === 'openai' && !apiKey && /api\.openai\.com|openai\.azure\.com/i.test(endpoint)) {
    throw new FusionError('config', 'AI API key is not configured.', {
      hint: 'Run "Fusion SQL: Set AI API Key…" or switch fusionSqlDev.ai.provider to "auto" or "ollama".'
    });
  }

  const messages: { role: string; content: string }[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }
  messages.push({ role: 'user', content: userPrompt });

  const isOllamaNative = provider === 'ollama' && /\/api\/chat\b/i.test(endpoint);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) {
    if (/openai\.azure\.com/i.test(endpoint)) {
      headers['api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }
  const body = isOllamaNative ? JSON.stringify({ model, messages, stream: false }) : JSON.stringify({ model, messages, temperature: 0.1 });

  const res = await httpRequest({
    url: endpoint,
    method: 'POST',
    headers,
    body,
    timeoutMs: 90000,
    signal: opts.signal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new FusionError('http', `AI provider answered HTTP ${res.status}: ${res.body.slice(0, 300)}`, { status: res.status });
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new FusionError('parse', 'AI provider returned non-JSON output.');
  }
  const text: string | undefined = parsed?.choices?.[0]?.message?.content ?? parsed?.message?.content ?? parsed?.response;
  if (typeof text !== 'string' || !text.trim()) {
    throw new FusionError('parse', 'AI provider returned an empty response.');
  }
  return { text, providerLabel: `${provider}:${model}` };
}

async function selectVsCodeModel(requestModel?: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat | undefined> {
  if (requestModel) {
    return requestModel;
  }
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    return undefined;
  }
  // Prefer Copilot if available, otherwise accept ANY registered VS Code Language Model provider.
  const copilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (copilot.length > 0) {
    return copilot[0];
  }
  const anyModels = await vscode.lm.selectChatModels();
  return anyModels[0];
}

/**
 * Send a prompt using the configured AI backend:
 *  - `auto`: VS Code Language Model API (Copilot or any other installed chat LM), falling back to BYOK if configured
 *  - `openai`: OpenAI / Azure OpenAI / OpenAI-compatible endpoint (API key in SecretStorage)
 *  - `ollama`: Local Ollama endpoint
 */
export async function streamPrompt(
  ctx: vscode.ExtensionContext,
  prompt: string,
  onChunk: (chunk: string) => void,
  opts: LlmOptions = {}
): Promise<LlmResult> {
  const mode = settings.aiProvider;
  if (mode === 'openai' || mode === 'ollama') {
    const res = await callByok(ctx, mode, prompt, opts);
    onChunk(res.text);
    return res;
  }

  const model = await selectVsCodeModel(opts.requestModel);
  if (model) {
    const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(fullPrompt)], {}, opts.token);
    let full = '';
    for await (const chunk of response.text) {
      full += chunk;
      onChunk(chunk);
    }
    return { text: full, providerLabel: model.name || model.id || 'vscode-lm' };
  }

  // Fallback in 'auto' mode if user configured a BYOK endpoint or API key
  if (settings.aiEndpoint || (await ctx.secrets.get(AI_API_KEY_SECRET))) {
    const fallbackProvider = /11434|ollama/i.test(settings.aiEndpoint) ? 'ollama' : 'openai';
    const res = await callByok(ctx, fallbackProvider, prompt, opts);
    onChunk(res.text);
    return res;
  }

  throw new FusionError('config', 'No AI chat model available.', {
    hint: 'Sign in to GitHub Copilot (or another VS Code chat LM), OR set "fusionSqlDev.ai.provider" to "openai" / "ollama" and run "Fusion SQL: Set AI API Key…".'
  });
}

export async function completePrompt(ctx: vscode.ExtensionContext, prompt: string, opts: LlmOptions = {}): Promise<LlmResult> {
  let out = '';
  const res = await streamPrompt(ctx, prompt, (c) => (out += c), opts);
  return { text: out || res.text, providerLabel: res.providerLabel };
}
