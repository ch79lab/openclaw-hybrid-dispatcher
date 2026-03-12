#!/usr/bin/env node
/**
 * openclaw-hybrid-dispatcher — Test Suite v5
 * Covers: session-aware routing, tool use bump, multimodal bump,
 * fallback chain, credential enforcement, scoring, overrides, shadow.
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 18998;
let failingUpstream = false; // toggle to simulate 429

function mockServer(port, tag) {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());

      // Simulate 429 for fallback testing
      if (failingUpstream && tag !== 'ollama' && port === 19001) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'rate_limited' }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (tag === 'ollama') {
        res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: `[ollama] ${body.model}` }, done: true, prompt_eval_count: 10, eval_count: 5 }));
      } else {
        res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: `[cloud:${port}] ${body.model}` }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }));
      }
    });
  }).listen(port, '127.0.0.1');
}

async function fetchJ(url) { return (await fetch(url)).json(); }
async function postJ(url) { return (await fetch(url, { method: 'POST' })).json(); }

async function msg(messages, { model, tools, sessionId } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': 'test', 'anthropic-version': '2023-06-01' };
  if (sessionId) headers['x-session-id'] = sessionId;

  const body = {
    model: model || 'anthropic/claude-sonnet-4-6',
    max_tokens: 1024,
    messages: messages.map(m => typeof m === 'string' ? { role: 'user', content: m } : m),
  };
  if (tools) body.tools = tools;

  return (await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })).json();
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  DISPATCHER v5 — TEST SUITE');
  console.log('═══════════════════════════════════════════════════\n');

  const mockMoonshot = mockServer(19001, 'cloud');
  const mockAnthropic = mockServer(19003, 'cloud');
  const mockOllama = mockServer(19002, 'ollama');
  await new Promise(r => setTimeout(r, 300));

  const cfgPath = join(__dirname, 'config.json');
  const origCfg = readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(origCfg);
  cfg.upstreams.moonshot.baseUrl = 'http://127.0.0.1:19001';
  cfg.upstreams.anthropic.baseUrl = 'http://127.0.0.1:19003';
  cfg.upstreams.ollama.baseUrl = 'http://127.0.0.1:19002';
  cfg.proxy.port = PORT;
  cfg.shadowMode = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const proc = spawn('node', [join(__dirname, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise(r => setTimeout(r, 1500));

  let ok = 0, fail = 0;
  const assert = (c, d, detail = '') => { if (c) { ok++; console.log(`  ✅ ${d}`); } else { fail++; console.log(`  ❌ ${d} ${detail}`); } };
  const isOllama = (r) => r.model?.includes('ollama/') || r.model?.includes('qwen');
  const isCloud = (r) => r.content?.[0]?.text?.includes('[cloud');

  // ── 1. Credential enforcement ──
  console.log('── CREDENCIAIS → LOCAL ──\n');
  assert(isOllama(await msg(['a senha é abc123'])), 'Senha → Ollama');
  assert(isOllama(await msg(['API key: sk-1234567890abcdefghij'])), 'API key → Ollama');
  assert(isOllama(await msg(['bearer eyJhbGciOiJIUzI1NiJ9.xxx'])), 'Bearer → Ollama');
  assert(isOllama(await msg(['-----BEGIN RSA PRIVATE KEY-----'])), 'RSA → Ollama');
  assert(isOllama(await msg(['ghp_1234567890abcdefghijklmnopqrstuvwxyz'])), 'GitHub token → Ollama');

  // ── 2. CPF/CNPJ not blocked ──
  console.log('\n── CPF/CNPJ → CLOUD ──\n');
  let r = await msg(['Analise a distribuição de CNPJs por região. Compare Sul e Sudeste e avalie os trade-offs.']);
  assert(!isOllama(r), `CNPJ analítico → Cloud (${r.model})`);

  // ── 3. Tool use bump → MEDIUM mínimo ──
  console.log('\n── TOOL USE → BUMP MEDIUM ──\n');
  const sampleTools = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];

  r = await msg(['oi'], { tools: sampleTools });
  assert(!isOllama(r), `"oi" + tools → não vai pro Ollama (${r.model})`);
  // "oi" normalmente seria LOCAL, mas com tools deve ir pra MEDIUM+
  assert(r.model === 'claude-sonnet-4-6', `"oi" + tools → bumped to Sonnet (${r.model})`);

  // ── 4. Multimodal bump → LIGHT mínimo ──
  console.log('\n── MULTIMODAL → BUMP LIGHT ──\n');
  r = await msg([{
    role: 'user',
    content: [
      { type: 'text', text: 'o que é isso?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' } },
    ],
  }]);
  assert(!isOllama(r), `Imagem → não vai pro Ollama (${r.model})`);

  // ── 5. Session-aware: tier só sobe ──
  console.log('\n── SESSION-AWARE ──\n');
  const sid = 'test-session-001';

  // Primeira msg: simples → LOCAL
  r = await msg(['oi'], { sessionId: sid });
  const firstModel = r.model;

  // Segunda msg: complexa → HEAVY, session escala
  r = await msg(['Analise os trade-offs entre event sourcing e CQRS. Compare e avalie escalabilidade.'], { sessionId: sid });
  assert(isCloud(r), `Complexa → Cloud (${r.model})`);

  // Terceira msg: simples de novo → deve MANTER no tier alto (session hold)
  r = await msg(['ok entendi'], { sessionId: sid });
  assert(!isOllama(r), `Simples após escalada → NÃO volta pro Ollama (${r.model})`);

  // Outra session: não é afetada
  r = await msg(['oi'], { sessionId: 'other-session-002' });
  assert(isOllama(r) || r.model?.includes('kimi'), `Outra session → independente (${r.model})`);

  // ── 6. Fallback chain (429 → next tier) ──
  console.log('\n── FALLBACK CHAIN ──\n');
  failingUpstream = true; // Moonshot (19001) vai retornar 429

  r = await msg(['/cloud teste de fallback'], { sessionId: 'fallback-test' });
  // LIGHT → Moonshot (429) → fallback → MEDIUM → Anthropic (19003)
  assert(isCloud(r), `Moonshot 429 → fallback pro Anthropic (${r.model})`);
  assert(r.model === 'claude-sonnet-4-6', `Fallback usou Sonnet (${r.model})`);

  failingUpstream = false;

  // ── 7. System prompt exclusion ──
  console.log('\n── SYSTEM PROMPT EXCLUSION ──\n');
  r = await msg([
    { role: 'system', content: 'Especialista em arquitetura, algoritmos, microsserviços, kubernetes, escalabilidade, distribuído.' },
    { role: 'user', content: 'valeu' },
  ], { sessionId: 'sysprompt-test' });
  assert(!r.model?.includes('sonnet'), `System prompt ignorado (${r.model})`);

  // ── 8. Shadow mode ──
  console.log('\n── SHADOW MODE ──\n');
  await postJ(`http://127.0.0.1:${PORT}/shadow/on`);
  r = await msg(['Analise a arquitetura com trade-offs de escalabilidade']);
  assert(r.model === 'anthropic/claude-sonnet-4-6', `Shadow: passthrough (${r.model})`);
  await postJ(`http://127.0.0.1:${PORT}/shadow/off`);

  // ── 9. Sessions endpoint ──
  console.log('\n── /sessions ENDPOINT ──\n');
  const sessData = await fetchJ(`http://127.0.0.1:${PORT}/sessions`);
  assert(sessData.count >= 3, `Active sessions: ${sessData.count}`);

  // ── Stats ──
  console.log('\n── STATS ──\n');
  await new Promise(r => setTimeout(r, 300));
  const s = await fetchJ(`http://127.0.0.1:${PORT}/stats`);
  console.log(`  Requests: ${s.daily.requests}`);
  console.log(`  Custo: $${s.daily.costUsd.toFixed(4)}`);
  console.log(`  Tiers: ${JSON.stringify(s.daily.byTier)}`);
  console.log(`  Sensitive: ${s.daily.sensitive} | Tools: ${s.daily.toolUse} | Multimodal: ${s.daily.multimodal}`);
  console.log(`  Sessions: ${s.activeSessions} | Fallbacks: ${s.daily.fallbacks}`);
  assert(s.daily.toolUse >= 1, `Tool use tracked (${s.daily.toolUse})`);
  assert(s.daily.multimodal >= 1, `Multimodal tracked (${s.daily.multimodal})`);
  assert(s.daily.fallbacks >= 1, `Fallbacks tracked (${s.daily.fallbacks})`);

  // ── Result ──
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  RESULTADO: ${ok} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════════════════\n');

  writeFileSync(cfgPath, origCfg);
  proc.kill('SIGTERM'); mockMoonshot.close(); mockAnthropic.close(); mockOllama.close();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
