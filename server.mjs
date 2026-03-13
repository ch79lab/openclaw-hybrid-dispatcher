/**
 * openclaw-hybrid-dispatcher — Session-Aware Hybrid Model Router
 *
 * v5.2 — Actual cost tracking (SSE + JSON)
 *
 * Changelog:
 * - v5.0: initial — scoring, session, fallback, budget
 * - v5.1: actual cost tracking from response usage
 * - v5.2: fix SSE streaming (tee pattern), fix gzip (strip accept-encoding),
 *         actual cost in budget controller
 *
 * Zero dependências. Node 22+.
 */

import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════

const PATHS = {
  config:       join(__dirname, 'config.json'),
  log:          join(homedir(), 'ch79', 'logs', 'dispatcher.log'),
  dailyStats:   join(homedir(), 'ch79', 'state', 'dispatcher-stats.json'),
  monthlyStats: join(homedir(), 'ch79', 'state', 'dispatcher-monthly.json'),
  feedback:     join(homedir(), '.openclaw', 'feedback.jsonl'),
};

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════

let CONFIG = loadConfig();

function loadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(PATHS.config, 'utf8'));
    cfg._sensitiveRe = (cfg.sensitive?.patterns || [])
      .map(p => { try { return new RegExp(p, 'i'); } catch { return null; } })
      .filter(Boolean);
    return cfg;
  } catch (e) { console.error(`[FATAL] ${e.message}`); process.exit(1); }
}

let _rt = null;
watch(PATHS.config, () => {
  clearTimeout(_rt);
  _rt = setTimeout(() => {
    try { CONFIG = loadConfig(); log('INFO', 'Config reloaded'); }
    catch (e) { log('ERROR', `Reload: ${e.message}`); }
  }, 500);
});
process.on('SIGHUP', () => {
  try { CONFIG = loadConfig(); log('INFO', 'Config reloaded (SIGHUP)'); }
  catch (e) { log('ERROR', `SIGHUP: ${e.message}`); }
});

// ═══════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════

function ensureDir(fp) { const d = dirname(fp); if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else if (process.env.DISPATCHER_VERBOSE) console.log(line);
  try { ensureDir(PATHS.log); writeFileSync(PATHS.log, line + '\n', { flag: 'a' }); } catch {}
}

// ═══════════════════════════════════════════════════════════
// TIER ORDERING
// ═══════════════════════════════════════════════════════════

const TIER_ORDER = ['LOCAL', 'LIGHT', 'MEDIUM', 'HEAVY'];
function tierRank(tier) { const i = TIER_ORDER.indexOf(tier); return i >= 0 ? i : 0; }
function tierAbove(tier) { const i = tierRank(tier); return TIER_ORDER[Math.min(i + 1, TIER_ORDER.length - 1)]; }

// ═══════════════════════════════════════════════════════════
// SESSION TRACKER — tier só sobe, nunca desce
// ═══════════════════════════════════════════════════════════

const sessions = new Map();

function getSessionId(body, headers) {
  if (headers['x-session-id']) return headers['x-session-id'];
  if (headers['x-conversation-id']) return headers['x-conversation-id'];

  const parts = [];
  if (body.system) parts.push(body.system.slice(0, 100));
  const firstUser = body.messages?.find(m => m.role === 'user');
  if (firstUser) {
    const content = typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content);
    parts.push(content.slice(0, 100));
  }
  if (parts.length === 0) return null;

  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `auto_${Math.abs(hash).toString(36)}`;
}

function getSessionTier(sessionId) {
  if (!sessionId) return null;
  const cfg = CONFIG.session || {};
  if (!cfg.enabled) return null;

  const s = sessions.get(sessionId);
  if (!s) return null;

  const ttl = (cfg.ttlMinutes || 30) * 60 * 1000;
  if (Date.now() - s.lastSeen > ttl) {
    sessions.delete(sessionId);
    return null;
  }

  return s.tier;
}

function updateSession(sessionId, tier) {
  if (!sessionId) return;
  const cfg = CONFIG.session || {};
  if (!cfg.enabled) return;

  const existing = sessions.get(sessionId);
  const currentRank = existing ? tierRank(existing.tier) : -1;
  const newRank = tierRank(tier);

  if (newRank > currentRank) {
    sessions.set(sessionId, {
      tier,
      lastSeen: Date.now(),
      requestCount: (existing?.requestCount || 0) + 1,
    });
    if (existing) {
      log('INFO', `Session ${sessionId.slice(0, 12)}… escalated ${existing.tier}→${tier}`);
    }
  } else if (existing) {
    existing.lastSeen = Date.now();
    existing.requestCount++;
  } else {
    sessions.set(sessionId, { tier, lastSeen: Date.now(), requestCount: 1 });
  }

  if (sessions.size > 100) {
    const ttl = (cfg.ttlMinutes || 30) * 60 * 1000;
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > ttl) sessions.delete(id);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// SENSITIVE DETECTION
// ═══════════════════════════════════════════════════════════

function isSensitive(text) {
  return (CONFIG._sensitiveRe || []).some(re => re.test(text));
}

// ═══════════════════════════════════════════════════════════
// TOOL USE & MULTIMODAL DETECTION
// ═══════════════════════════════════════════════════════════

function hasToolUse(body) {
  if (body.tool_choice && body.tool_choice !== 'none' && body.tool_choice !== 'auto') return true;
  if (body.messages?.some(m => m.role === 'tool' || m.role === 'tool_result')) return true;
  return false;
}

function hasMultimodal(body) {
  if (!body.messages || !Array.isArray(body.messages)) return false;
  return body.messages.some(m => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(block =>
      block.type === 'image' || block.type === 'image_url' ||
      block.type === 'document' || block.type === 'file'
    );
  });
}

// ═══════════════════════════════════════════════════════════
// SCORER — 14 dimensões + cost bias
// ═══════════════════════════════════════════════════════════

function extractUserText(body) {
  if (!body.messages || !Array.isArray(body.messages)) return '';
  return body.messages
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => typeof m.content === 'string' ? m.content :
      Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ') :
      JSON.stringify(m.content))
    .join(' ');
}

function estimateTokens(text) {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

function countHits(text, keywords) {
  if (!keywords?.length) return 0;
  const l = text.toLowerCase();
  return keywords.reduce((n, kw) => n + (l.includes(kw.toLowerCase()) ? 1 : 0), 0);
}

function scoreRequest(userText, body) {
  const kw = CONFIG.scoring?.keywords || {};
  const w = CONFIG.scoring?.weights || {};
  const bounds = CONFIG.scoring?.boundaries || {};
  const ov = CONFIG.scoring?.overrides || {};
  const cb = CONFIG.scoring?.costBias || {};

  const allText = (body.messages || []).map(m =>
    typeof m.content === 'string' ? m.content :
    Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ') :
    ''
  ).join(' ');
  const totalTokens = estimateTokens(allText);
  const wordCount = userText.split(/\s+/).filter(Boolean).length;
  const reasoningHits = countHits(userText, kw.reasoning);

  const dim = {
    tokenCount:       Math.min(1, Math.log10(Math.max(totalTokens, 1)) / 5),
    codePresence:     Math.min(1, (countHits(userText, kw.code) / 4) + (/```/.test(userText) ? 0.4 : 0)),
    reasoningMarkers: Math.min(1, reasoningHits / 3),
    technicalTerms:   Math.min(1, countHits(userText, kw.technical) / 4),
    creativeMarkers:  Math.min(1, countHits(userText, kw.creative) / 2),
    simpleIndicators: Math.min(1, (countHits(userText, kw.simple) / 3) + (wordCount <= 10 ? 0.3 : 0)),
    multiStepPatterns: Math.min(1, [
      /\b(primeiro|depois|então|próximo|em seguida|por fim|first|then|next|finally)\b/i,
      /\b(passo|etapa|step)\s*\d/i, /\d\.\s/,
    ].reduce((c, p) => c + (p.test(userText) ? 1 : 0), 0) / 3),
    questionComplexity: Math.min(1,
      ((userText.match(/\?/g) || []).length > 1 ? 0.3 : 0)
      + (/\b(por\s*qu[eê]|why)\b/i.test(userText) ? 0.4 : 0)
      + (/\b(como|how)\b/i.test(userText) ? 0.2 : 0)),
    imperativeVerbs:   Math.min(1, countHits(userText, kw.imperative) / 3),
    constraints:       Math.min(1, countHits(userText, kw.constraints) / 3),
    outputFormat:      Math.min(1, countHits(userText, kw.outputFormat) / 2),
    domainSpecificity: Math.min(1, countHits(userText, kw.domain) / 3),
    agenticTasks:      Math.min(1, countHits(userText, kw.agentic) / 2),
    relayIndicators:   Math.min(1, countHits(userText, kw.relay) / 2),
  };

  let score = 0;
  for (const [k, v] of Object.entries(dim)) score += v * (w[k] || 0);
  if (cb.enabled && cb.weight > 0) score -= cb.weight * 0.05;

  let tier, confidence, overrideReason = null;

  if (reasoningHits >= (ov.reasoningKeywordThreshold || 2)) {
    tier = 'HEAVY'; confidence = 0.95; overrideReason = 'reasoning_keywords';
  } else if (totalTokens > (ov.largeContextTokens || 50000)) {
    tier = 'HEAVY'; confidence = 0.90; overrideReason = 'large_context';
  } else if (score < (bounds.localLight ?? -0.05)) {
    tier = 'LOCAL'; confidence = 0.85;
  } else if (score < (bounds.lightMedium ?? 0.10)) {
    tier = 'LIGHT'; confidence = 0.70;
  } else if (score > (bounds.mediumHeavy ?? 0.35)) {
    tier = 'HEAVY'; confidence = Math.min(0.95, 0.5 + (score - (bounds.mediumHeavy ?? 0.35)));
  } else {
    tier = 'MEDIUM'; confidence = 0.60;
  }

  return { score, tier, confidence, overrideReason, dimensions: dim, totalTokens };
}

// ═══════════════════════════════════════════════════════════
// OVERRIDES
// ═══════════════════════════════════════════════════════════

function detectOverride(text) {
  const cmds = CONFIG.telegramOverrides;
  if (!cmds?.enabled) return null;
  const t = text.trim().toLowerCase();
  for (const [cmd, tier] of Object.entries(cmds.commands || {})) {
    if (t.startsWith(cmd)) return tier;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// BUDGET & COST — ACTUAL TRACKING (v5.1+)
// ═══════════════════════════════════════════════════════════

function loadJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function saveJSON(p, d) { try { ensureDir(p); writeFileSync(p, JSON.stringify(d, null, 2)); } catch {} }

function loadDailyStats() {
  const today = new Date().toISOString().split('T')[0];
  const s = loadJSON(PATHS.dailyStats);
  return (s?.date === today) ? s : {
    date: today, requests: 0,
    estimatedCostUsd: 0, actualCostUsd: 0,
    inputTokens: 0, outputTokens: 0,
    byTier: {}, sensitive: 0, toolUse: 0, multimodal: 0,
    sessionEscalations: 0, fallbacks: 0,
  };
}
function loadMonthlyStats() {
  const m = new Date().toISOString().slice(0, 7);
  const s = loadJSON(PATHS.monthlyStats);
  return (s?.month === m) ? s : {
    month: m, requests: 0,
    estimatedCostUsd: 0, actualCostUsd: 0,
    inputTokens: 0, outputTokens: 0,
  };
}

function isBudgetExhausted() {
  if (!CONFIG.budget?.enabled) return false;
  const d = loadDailyStats(), m = loadMonthlyStats();
  const dailyCost = d.actualCostUsd || d.estimatedCostUsd;
  const monthlyCost = m.actualCostUsd || m.estimatedCostUsd;
  if (dailyCost >= (CONFIG.budget.dailyLimitUsd || Infinity)) return 'daily';
  if (monthlyCost >= (CONFIG.budget.monthlyLimitUsd || Infinity)) return 'monthly';
  return false;
}

function estimateCost(tier, tokens) {
  const r = CONFIG.tiers?.[tier]?.costPer1MTokens;
  if (!r) return 0;
  return ((tokens * 0.7 * (r.input || 0)) + (tokens * 0.3 * (r.output || 0))) / 1_000_000;
}

function computeActualCost(tier, usage) {
  if (!usage || (!usage.input_tokens && !usage.output_tokens)) return null;
  const r = CONFIG.tiers?.[tier]?.costPer1MTokens;
  if (!r) return null;
  return ((usage.input_tokens || 0) * (r.input || 0) + (usage.output_tokens || 0) * (r.output || 0)) / 1_000_000;
}

/**
 * Extract usage from API response.
 * Handles JSON (non-streaming) and SSE (streaming) formats.
 *
 * Anthropic SSE:
 *   event: message_start → message.usage.input_tokens
 *   event: message_delta → usage.output_tokens
 */
function extractUsage(responseText) {
  // 1. JSON (non-streaming)
  try {
    const data = JSON.parse(responseText);
    if (data?.usage?.input_tokens !== undefined) {
      return {
        input_tokens: data.usage.input_tokens || 0,
        output_tokens: data.usage.output_tokens || 0,
      };
    }
  } catch {}

  // 2. SSE (streaming)
  try {
    let inputTokens = 0;
    let outputTokens = 0;

    const lines = responseText.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const event = JSON.parse(jsonStr);
        if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        }
        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
      } catch {}
    }

    if (inputTokens > 0 || outputTokens > 0) {
      return { input_tokens: inputTokens, output_tokens: outputTokens };
    }
  } catch {}

  return null;
}

function recordRequest(tier, estimatedTokens, flags, shadow, usage) {
  const estimated = estimateCost(tier, estimatedTokens);
  const actual = computeActualCost(tier, usage);
  const cost = actual ?? estimated;

  const d = loadDailyStats(), m = loadMonthlyStats();

  d.requests++;
  d.estimatedCostUsd += estimated;
  if (actual !== null) d.actualCostUsd += actual;
  if (usage) {
    d.inputTokens += usage.input_tokens || 0;
    d.outputTokens += usage.output_tokens || 0;
  }
  d.byTier[tier] = (d.byTier[tier] || 0) + 1;
  if (flags.sensitive) d.sensitive = (d.sensitive || 0) + 1;
  if (flags.toolUse) d.toolUse = (d.toolUse || 0) + 1;
  if (flags.multimodal) d.multimodal = (d.multimodal || 0) + 1;
  if (flags.sessionEscalated) d.sessionEscalations = (d.sessionEscalations || 0) + 1;
  if (flags.fallback) d.fallbacks = (d.fallbacks || 0) + 1;

  m.requests++;
  m.estimatedCostUsd += estimated;
  if (actual !== null) m.actualCostUsd += actual;
  if (usage) {
    m.inputTokens += usage.input_tokens || 0;
    m.outputTokens += usage.output_tokens || 0;
  }

  saveJSON(PATHS.dailyStats, d);
  saveJSON(PATHS.monthlyStats, m);

  return { estimated, actual, cost };
}

function writeFeedback(entry) {
  try { ensureDir(PATHS.feedback); writeFileSync(PATHS.feedback, JSON.stringify(entry) + '\n', { flag: 'a' }); } catch {}
}

// ═══════════════════════════════════════════════════════════
// UPSTREAM PROXY
// ═══════════════════════════════════════════════════════════

function defaultUpstream() {
  const heavy = CONFIG.tiers?.HEAVY?.upstream;
  if (heavy && heavy !== 'ollama') return heavy;
  const names = Object.keys(CONFIG.upstreams || {});
  return names.find(n => n !== 'ollama') || names[0] || 'anthropic';
}

function toOllamaBody(body, model, tierCfg) {
  const messages = (body.messages || []).map(m => {
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      const texts = m.content.filter(b => b.type === 'text').map(b => b.text || '');
      content = texts.length > 0 ? texts.join('\n') : JSON.stringify(m.content);
    } else {
      content = m.content ? JSON.stringify(m.content) : '';
    }
    return { role, content: String(content) };
  });
  if (body.system) {
    const sysContent = typeof body.system === 'string' ? body.system :
      Array.isArray(body.system) ? body.system.filter(b => b.type === 'text').map(b => b.text || '').join('\n') || JSON.stringify(body.system) :
      String(body.system);
    messages.unshift({ role: 'system', content: sysContent });
  }
  // Safety: ensure ALL content fields are strings for Ollama
  for (const msg of messages) {
    if (typeof msg.content !== 'string') msg.content = JSON.stringify(msg.content);
  }
  const opts = tierCfg?.ollamaOptions || {};
  const think = opts.think;
  const filteredOpts = Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'think'));
  return { model, messages, stream: false, options: filteredOpts, ...(think !== undefined ? { think } : {}) };
}

function fromOllamaResponse(data, model) {
  return {
    id: `msg_local_${Date.now()}`, type: 'message', role: 'assistant',
    model: `ollama/${model}`,
    content: [{ type: 'text', text: data.message?.content || data.response || '' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 },
  };
}

function proxyToOllama(clientRes, body, tierCfg) {
  return new Promise((resolve, reject) => {
    const up = CONFIG.upstreams?.ollama || {};
    const url = new URL(up.baseUrl || 'http://127.0.0.1:11434');
    const payload = JSON.stringify(toOllamaBody(body, tierCfg.model, tierCfg));

    const req = httpRequest({
      hostname: url.hostname, port: url.port || 11434,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: up.timeout || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString());
          const resp = fromOllamaResponse(raw, tierCfg.model);
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(resp));
          const usage = {
            input_tokens: raw.prompt_eval_count || 0,
            output_tokens: raw.eval_count || 0,
          };
          resolve({ ok: true, usage });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ollama timeout')); });
    req.write(payload); req.end();
  });
}

/**
 * Proxy para upstream cloud.
 * v5.2: strips accept-encoding (prevents gzip), handles SSE + JSON.
 * SSE: tee pattern — pipe chunks to client in real-time, collect for usage.
 * JSON: buffer, extract usage, send.
 */
function proxyToUpstream(clientReq, clientRes, body, upstreamName) {
  return new Promise((resolve, reject) => {
    const up = CONFIG.upstreams?.[upstreamName] || CONFIG.upstreams?.[defaultUpstream()] || {};
    const url = new URL(up.baseUrl || 'https://api.anthropic.com');
    const isHttps = url.protocol === 'https:';
    const requester = isHttps ? httpsRequest : httpRequest;
    const headers = { ...clientReq.headers, host: url.hostname };
    const payload = JSON.stringify(body);
    headers['content-length'] = Buffer.byteLength(payload);

    // Strip accept-encoding to prevent gzip — we need to read the response body
    delete headers['accept-encoding'];

    const req = requester({
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: clientReq.url, method: clientReq.method, headers,
      timeout: up.timeout || 60000,
    }, (res) => {

      // Fallback-eligible: 429/5xx
      if (res.statusCode === 429 || res.statusCode >= 500) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({ ok: false, status: res.statusCode, body: Buffer.concat(chunks).toString(), usage: null });
        });
        return;
      }

      const contentType = res.headers['content-type'] || '';
      const isStreaming = contentType.includes('text/event-stream');

      if (isStreaming) {
        // SSE: tee — pipe to client + collect for usage extraction
        clientRes.writeHead(res.statusCode, res.headers);
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
          clientRes.write(chunk);
        });
        res.on('end', () => {
          clientRes.end();
          const fullBody = Buffer.concat(chunks).toString();
          const usage = extractUsage(fullBody);
          resolve({ ok: true, status: res.statusCode, usage });
        });
      } else {
        // JSON: buffer, extract, send
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          const usage = extractUsage(responseBody.toString());
          clientRes.writeHead(res.statusCode, res.headers);
          clientRes.end(responseBody);
          resolve({ ok: true, status: res.statusCode, usage });
        });
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.write(payload); req.end();
  });
}

// ═══════════════════════════════════════════════════════════
// FALLBACK CHAIN
// ═══════════════════════════════════════════════════════════

async function proxyWithFallback(clientReq, clientRes, body, startTier) {
  const maxRetries = CONFIG.fallback?.maxRetries ?? 2;
  let currentTier = startTier;
  let attempts = 0;

  while (attempts <= maxRetries) {
    const tc = CONFIG.tiers?.[currentTier];
    if (!tc) break;

    try {
      if (tc.upstream === 'ollama') {
        const result = await proxyToOllama(clientRes, body, tc);
        return { finalTier: currentTier, fallback: attempts > 0, usage: result.usage };
      }

      body.model = tc.model || body.model;
      const result = await proxyToUpstream(clientReq, clientRes, body, tc.upstream || defaultUpstream());

      if (result.ok) {
        return { finalTier: currentTier, fallback: attempts > 0, usage: result.usage };
      }

      log('WARN', `Upstream ${tc.upstream} returned ${result.status} for tier ${currentTier} — trying fallback`);
      const nextTier = tierAbove(currentTier);
      if (nextTier === currentTier) break;
      currentTier = nextTier;
      attempts++;

    } catch (err) {
      log('ERROR', `Proxy error tier ${currentTier}: ${err.message}`);
      const nextTier = tierAbove(currentTier);
      if (nextTier === currentTier) break;
      currentTier = nextTier;
      attempts++;
    }
  }

  if (!clientRes.headersSent) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'all_upstreams_failed', lastTier: currentTier }));
  }
  return { finalTier: currentTier, fallback: true, failed: true, usage: null };
}

// ═══════════════════════════════════════════════════════════
// ROUTING DECISION
// ═══════════════════════════════════════════════════════════

function routeRequest(body, headers) {
  const userText = extractUserText(body);
  const sensitive = isSensitive(userText);
  const tokens = estimateTokens(userText);
  const tools = hasToolUse(body);
  const multimodal = hasMultimodal(body);
  const sessionId = getSessionId(body, headers);

  if (sensitive && CONFIG.sensitive?.action === 'force_local') {
    return { tier: 'LOCAL', reason: 'sensitive_enforcement', score: null, confidence: 1.0, totalTokens: tokens, sensitive: true, tools, multimodal, sessionId };
  }

  const override = detectOverride(userText);
  if (override) {
    return { tier: override, reason: 'manual_override', score: null, confidence: 1.0, totalTokens: tokens, sensitive: false, tools, multimodal, sessionId };
  }

  const budget = isBudgetExhausted();
  if (budget) {
    const tier = (CONFIG.budget?.onExhausted || 'force_local') === 'force_local' ? 'LOCAL' : 'LIGHT';
    return { tier, reason: `budget_${budget}`, score: null, confidence: 1.0, totalTokens: tokens, sensitive: false, tools, multimodal, sessionId };
  }

  const result = scoreRequest(userText, body);
  let tier = result.tier;
  let reason = result.overrideReason || `score_${tier.toLowerCase()}`;

  if (tools && tierRank(tier) < tierRank('MEDIUM')) {
    tier = 'MEDIUM';
    reason = `tool_use_bump(was:${result.tier})`;
  }

  if (multimodal && tierRank(tier) < tierRank('LIGHT')) {
    tier = 'LIGHT';
    reason = `multimodal_bump(was:${result.tier})`;
  }

  const sessionTier = getSessionTier(sessionId);
  if (sessionTier && tierRank(sessionTier) > tierRank(tier)) {
    reason = `session_hold(${sessionTier},was:${tier})`;
    tier = sessionTier;
  }

  return { ...result, tier, reason, sensitive: false, tools, multimodal, sessionId };
}

// ═══════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════

function collectBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks).toString()));
}

function handleRequest(clientReq, clientRes) {
  if (clientReq.url === '/health') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({ status: 'ok', shadow: CONFIG.shadowMode, uptime: process.uptime(), locale: CONFIG.locale, activeSessions: sessions.size }));
  }
  if (clientReq.url === '/stats') {
    const daily = loadDailyStats();
    const monthly = loadMonthlyStats();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({
      daily, monthly,
      budget: {
        limit: CONFIG.budget?.monthlyLimitUsd || null,
        spent: monthly.actualCostUsd || monthly.estimatedCostUsd,
        remaining: CONFIG.budget?.monthlyLimitUsd
          ? (CONFIG.budget.monthlyLimitUsd - (monthly.actualCostUsd || monthly.estimatedCostUsd))
          : null,
        source: monthly.actualCostUsd > 0 ? 'actual' : 'estimated',
        dailyTarget: CONFIG.budget?.monthlyLimitUsd ? (CONFIG.budget.monthlyLimitUsd / 30) : null,
      },
      shadow: CONFIG.shadowMode,
      activeSessions: sessions.size,
    }));
  }
  if (clientReq.url === '/config') {
    const { tiers, budget, shadowMode, locale, session, fallback } = CONFIG;
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({ tiers, budget, shadowMode, locale, session, fallback,
      upstreams: Object.fromEntries(Object.entries(CONFIG.upstreams || {}).map(([k,v]) => [k, { baseUrl: v.baseUrl }])),
    }));
  }
  if (clientReq.url === '/shadow/on' && clientReq.method === 'POST') {
    CONFIG.shadowMode = true; log('INFO', 'Shadow ON');
    clientRes.writeHead(200); return clientRes.end('{"shadowMode":true}');
  }
  if (clientReq.url === '/shadow/off' && clientReq.method === 'POST') {
    CONFIG.shadowMode = false; log('INFO', 'Shadow OFF — LIVE');
    clientRes.writeHead(200); return clientRes.end('{"shadowMode":false}');
  }
  if (clientReq.url === '/sessions' && clientReq.method === 'GET') {
    const data = [];
    for (const [id, s] of sessions) data.push({ id: id.slice(0, 16), ...s, ageMs: Date.now() - s.lastSeen });
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({ count: sessions.size, sessions: data }));
  }

  if (clientReq.method !== 'POST' || !clientReq.url?.startsWith('/v1/messages')) {
    collectBody(clientReq, (raw) => {
      let b; try { b = JSON.parse(raw); } catch { b = undefined; }
      proxyToUpstream(clientReq, clientRes, b, defaultUpstream()).catch(e => {
        log('ERROR', `Passthrough: ${e.message}`);
        if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end(); }
      });
    });
    return;
  }

  collectBody(clientReq, (raw) => {
    let body;
    try { body = JSON.parse(raw); } catch {
      log('WARN', 'Parse failed — passthrough');
      proxyToUpstream(clientReq, clientRes, raw, defaultUpstream()).catch(() => {});
      return;
    }

    const t0 = Date.now();
    try {
      const r = routeRequest(body, clientReq.headers);
      const ms = Date.now() - t0;
      const tc = CONFIG.tiers?.[r.tier] || CONFIG.tiers?.LIGHT;
      const orig = body.model;
      const flags = { sensitive: r.sensitive, toolUse: r.tools, multimodal: r.multimodal };

      if (CONFIG.shadowMode) {
        log('INFO', `[SHADOW→${r.tier}] score=${r.score?.toFixed(3)} reason=${r.reason} tools=${r.tools} mm=${r.multimodal} session=${r.sessionId?.slice(0,8)} ${ms}ms`);
        recordRequest(r.tier, r.totalTokens || 0, flags, true, null);
        writeFeedback({ ts: new Date().toISOString(), tier: r.tier, score: r.score, reason: r.reason, ...flags, shadow: true, ms });
        proxyToUpstream(clientReq, clientRes, body, defaultUpstream()).catch(() => {});
        return;
      }

      log('INFO', `[${r.tier}] score=${r.score?.toFixed(3)} ${orig}→${tc?.model} reason=${r.reason} tools=${r.tools} mm=${r.multimodal} session=${r.sessionId?.slice(0,8)} ${ms}ms`);

      proxyWithFallback(clientReq, clientRes, body, r.tier).then(result => {
        updateSession(r.sessionId, result.finalTier);

        flags.sessionEscalated = result.finalTier !== r.tier;
        flags.fallback = result.fallback || false;

        const costs = recordRequest(result.finalTier, r.totalTokens || 0, flags, false, result.usage);

        const usageLog = result.usage
          ? `in=${result.usage.input_tokens} out=${result.usage.output_tokens} actual=$${costs.actual?.toFixed(4)}`
          : `estimated=$${costs.estimated.toFixed(4)}`;
        log('INFO', `[COST] ${result.finalTier} ${usageLog}`);

        writeFeedback({
          ts: new Date().toISOString(), orig, target: CONFIG.tiers?.[result.finalTier]?.model,
          tier: result.finalTier, scoredTier: r.tier, score: r.score, reason: r.reason,
          ...flags,
          tokens: r.totalTokens,
          usage: result.usage || null,
          estimatedCostUsd: costs.estimated,
          actualCostUsd: costs.actual,
          costUsd: costs.cost,
          shadow: false, ms,
          sessionId: r.sessionId?.slice(0, 16),
        });
      }).catch(err => {
        log('ERROR', `proxyWithFallback: ${err.message}`);
        if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end(); }
      });

    } catch (err) {
      log('ERROR', `Router: ${err.message} — passthrough`);
      proxyToUpstream(clientReq, clientRes, body, defaultUpstream()).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

const port = CONFIG.proxy?.port || 8402;
const bind = CONFIG.proxy?.bind || '127.0.0.1';
const server = createServer(handleRequest);

server.listen(port, bind, () => {
  const t = CONFIG.tiers || {};
  log('INFO', `Dispatcher v5.2 — ${bind}:${port} — SSE streaming + actual cost`);
  console.log(`
  openclaw-hybrid-dispatcher v5.2 — Session-Aware Hybrid Router
  ${bind}:${port}

  LOCAL  = ${t.LOCAL?.model} (${CONFIG.upstreams?.ollama?.baseUrl})
  LIGHT  = ${t.LIGHT?.model} (${CONFIG.upstreams?.[t.LIGHT?.upstream]?.baseUrl})
  MEDIUM = ${t.MEDIUM?.model} (${CONFIG.upstreams?.[t.MEDIUM?.upstream]?.baseUrl})
  HEAVY  = ${t.HEAVY?.model} (${CONFIG.upstreams?.[t.HEAVY?.upstream]?.baseUrl})

  Shadow:   ${CONFIG.shadowMode ? 'ON (classificando sem rotear)' : 'OFF (roteamento ativo)'}
  Session:  ${CONFIG.session?.enabled ? `ON (TTL ${CONFIG.session.ttlMinutes || 30}min)` : 'OFF'}
  Fallback: ${CONFIG.fallback?.maxRetries ?? 2} retries
  Budget:   ${CONFIG.budget?.enabled ? `$${CONFIG.budget.dailyLimitUsd}/dia | $${CONFIG.budget.monthlyLimitUsd}/mês` : 'OFF'}
  Cost:     actual (SSE + JSON, input + output tokens)
  Locale:   ${CONFIG.locale}
`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`[FATAL] Porta ${port} em uso`); process.exit(1); }
  log('ERROR', `Server: ${e.message}`);
});

process.on('SIGTERM', () => { log('INFO', 'SIGTERM'); server.close(); process.exit(0); });
process.on('SIGINT', () => { log('INFO', 'SIGINT'); server.close(); process.exit(0); });
