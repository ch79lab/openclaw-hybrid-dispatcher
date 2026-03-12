# openclaw-hybrid-dispatcher

> **[Português](#português)** · **[English](#english)**

---

## Português

Router inteligente para stacks híbridas local/cloud. Classifica cada request em <1ms e roteia para o modelo mais barato que aguenta a tarefa.

**Para quem é:** desenvolvedores e entusiastas rodando [OpenClaw](https://github.com/openclaw/openclaw) (ou qualquer agente compatível) com Ollama local + API cloud, num Mac Mini, notebook ou servidor doméstico.

### Por que usar

Se você roda OpenClaw com Ollama + Anthropic (ou outro provider cloud), por padrão **tudo vai pro mesmo modelo**. Heartbeat? Sonnet. Pergunta simples? Sonnet. Análise complexa? Sonnet.

O dispatcher resolve isso:

```
LOCAL   "converte esse JSON pra YAML"                        → Ollama     $0.000
LOCAL   "qual o comando pra listar portas abertas no mac?"   → Ollama     $0.000
LIGHT   "gera um .gitignore pra Node com TypeScript"         → Kimi       $0.000
MEDIUM  "refatora esse endpoint pra async/await com tratamento de erro"
                                                             → Sonnet    ~$0.003
HEAVY   "redesenha a arquitetura do billing pra suportar 10x mais volume.
         compara event sourcing vs CQRS, considera trade-offs de migração"
                                                             → Sonnet    ~$0.008
```

**Economia típica: 50-80%.** A maioria das interações do dia a dia (formatação, comandos, perguntas diretas) resolve local. O budget vai pro que realmente precisa de raciocínio.

### Como funciona

```
OpenClaw → localhost:8402 → scorer (<1ms)
                                ↓
           ┌────────────────────┼────────────────────┐
           ↓                    ↓                    ↓
        LOCAL               LIGHT/MEDIUM           HEAVY
      Ollama local          Cloud API             Cloud API
      custo zero            baixo custo           premium
```

O dispatcher é um proxy HTTP que:
1. Intercepta o request do OpenClaw
2. Classifica a complexidade via scorer heurístico de 14 dimensões (<1ms, sem LLM)
3. Troca o campo `model` no request
4. Faz proxy para o upstream correto (Ollama local ou cloud)
5. Traduz automaticamente entre protocolos (Anthropic ↔ Ollama)

#### Regras de prioridade

| # | Condição | Ação |
|---|----------|------|
| 1 | Credenciais/segredos detectados | → LOCAL (sempre) |
| 2 | Override manual do usuário | → Tier forçado |
| 3 | Budget esgotado | → LOCAL |
| 4 | Score heurístico com cost bias | → Tier por complexidade |

#### 14 dimensões de scoring

Token count · code presence · reasoning markers · technical terms · creative markers · simple indicators · multi-step patterns · question complexity · imperative verbs · constraints · output format · domain specificity · agentic tasks · relay indicators

Cada dimensão tem peso configurável. Keywords em **PT-BR** (primário) e EN (secundário).

### Início rápido

**Pré-requisitos:** Node.js 22+ · Ollama rodando localmente · API key de provider cloud

```bash
git clone https://github.com/ch79lab/openclaw-hybrid-dispatcher.git
cd openclaw-hybrid-dispatcher

cp config.example.json config.json
nano config.json                    # edite tiers, modelos e upstreams

node test.mjs                       # rodar testes
node server.mjs                     # iniciar
```

**Integrar com OpenClaw** — no `~/.openclaw/openclaw.json`, aponte o provider para o dispatcher:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:8402"
      }
    }
  }
}
```

Reinicie o OpenClaw. Todo request agora passa pelo dispatcher.

### Features

| Feature | Descrição |
|---------|-----------|
| **Session-aware** | Tier só sobe, nunca desce dentro da mesma conversa — elimina "Frankenstein context" |
| **Tool use detection** | Request com `tools` → bump automático para MEDIUM (modelos locais falham em function calling) |
| **Multimodal detection** | Mensagem com imagem → bump para LIGHT mínimo (Ollama pode não suportar vision) |
| **Fallback chain** | Se upstream retorna 429 ou 5xx, tenta o próximo tier automaticamente |
| **Dual upstream** | Proxy para Ollama (local) e múltiplos cloud providers com tradução de protocolo |
| **Scoring <1ms** | 14 dimensões heurísticas, sem chamar LLM para classificar |
| **System prompt exclusion** | Só pontua user messages — system prompt do OpenClaw não infla o score |
| **Credential enforcement** | Senhas, API keys, tokens, SSH keys → forçados para Ollama local |
| **Cost bias** | Nas fronteiras entre tiers, prefere o mais barato (configurável) |
| **Budget control** | Limite diário e mensal; quando esgota → tudo local |
| **Shadow mode** | Classifica e loga sem rotear — para calibrar antes de ir live |
| **Hot-reload** | Config recarrega ao salvar (ou via `SIGHUP`) |
| **Fail-safe** | Erro interno → passthrough sem alterar o request |
| **Feedback log** | Cada decisão em JSONL para análise posterior |
| **PT-BR first** | Keywords e patterns em português como idioma primário |
| **Zero deps** | Nenhuma dependência externa — só Node.js nativo |
| **Overrides** | Comandos `/local`, `/cloud`, `/pro`, `/max` no chat |

### Dados sensíveis

O dispatcher protege **credenciais e segredos**, não dados analíticos.

**Forçado para LOCAL (Ollama):** senhas, API keys, secret keys, bearer tokens, SSH keys, RSA private keys, GitHub tokens (`ghp_`, `gho_`, etc.)

**NÃO bloqueado (pode ir pra cloud):** CPF, CNPJ, emails em contexto, dados de negócio em análises

A lógica: se o usuário conscientemente compartilhou um CPF para análise, forçar pro modelo local prejudica a qualidade sem ganho real de segurança. Credenciais de acesso são diferentes — nunca devem sair da máquina.

### Session-aware routing

O dispatcher rastreia conversas. Quando o tier escala (ex: de LOCAL para HEAVY), ele **permanece** no tier mais alto até a sessão expirar. Isso evita o problema "Frankenstein context" — respostas incoerentes quando metade da conversa roda local e metade na cloud.

```
mensagem 1: "oi"                        → LOCAL  (Ollama)
mensagem 2: "analisa os trade-offs..."  → HEAVY  (Sonnet) — sessão escalou
mensagem 3: "ok, agora resume"          → HEAVY  (Sonnet) — session hold
mensagem 4: "valeu"                     → HEAVY  (Sonnet) — ainda na sessão
... 30min sem atividade → sessão expira → próxima conversa começa do zero
```

Configurável via `session.ttlMinutes` (default 30min). Endpoint `/sessions` mostra sessões ativas.

### Fallback chain

Se um upstream falha (429 rate limit, 500 server error), o dispatcher tenta automaticamente o próximo tier acima:

```
LIGHT (Kimi 429) → MEDIUM (Sonnet) → sucesso
```

Configurável via `fallback.maxRetries` (default 2). Stats rastreiam quantos fallbacks ocorreram.

### Configuração

Copie `config.example.json` → `config.json` e edite.

**Tiers e modelos:**
```json
{
  "tiers": {
    "LOCAL":  { "upstream": "ollama", "model": "qwen3:8b" },
    "LIGHT":  { "upstream": "cloud",  "model": "claude-haiku-4.5" },
    "MEDIUM": { "upstream": "cloud",  "model": "claude-sonnet-4-6" },
    "HEAVY":  { "upstream": "cloud",  "model": "claude-sonnet-4-6" }
  }
}
```

**Upstreams:**
```json
{
  "upstreams": {
    "ollama": { "baseUrl": "http://127.0.0.1:11434" },
    "cloud":  { "baseUrl": "https://api.anthropic.com" }
  }
}
```

O campo `cloud` aceita qualquer API compatível com Anthropic ou OpenAI.

**Budget:**
```json
{
  "budget": {
    "enabled": true,
    "dailyLimitUsd": 1.00,
    "monthlyLimitUsd": 30.00,
    "onExhausted": "force_local"
  }
}
```

Pesos de scoring, keywords e boundaries são todos editáveis. Hot-reload automático ao salvar.

### Endpoints

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/health` | GET | Status, shadow mode, uptime |
| `/stats` | GET | Estatísticas diárias e mensais |
| `/config` | GET | Configuração atual (sem secrets) |
| `/shadow/on` | POST | Ativar shadow mode |
| `/shadow/off` | POST | Desativar — roteamento ativo |
| `/v1/messages` | POST | Proxy com scoring e routing |

### Shadow mode

Inicia em shadow mode por padrão. Classifica e loga sem alterar routing.

```bash
# ver decisões
cat ~/.openclaw/feedback.jsonl | jq '{tier, score, reason}'

# distribuição por tier
cat ~/.openclaw/feedback.jsonl | jq -r .tier | sort | uniq -c | sort -rn

# ir live
curl -X POST http://127.0.0.1:8402/shadow/off
```

### Rodar como serviço (macOS)

Salvar como `~/Library/LaunchAgents/com.openclaw.hybrid-dispatcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.hybrid-dispatcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>/CAMINHO/PARA/openclaw-hybrid-dispatcher/server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.hybrid-dispatcher.plist
```

### Contribuindo

Issues e PRs são bem-vindos. Veja [CONTRIBUTING.md](CONTRIBUTING.md).

### Licença

[MIT](LICENSE)

---

## English

Smart router for hybrid local/cloud stacks. Scores each request in <1ms and routes to the cheapest model that can handle the task.

**Who it's for:** developers and enthusiasts running [OpenClaw](https://github.com/openclaw/openclaw) (or any compatible agent) with local Ollama + cloud API on a Mac Mini, laptop, or home server.

### Why use it

If you run OpenClaw with Ollama + Anthropic (or any cloud provider), by default **everything goes to the same model**. Heartbeat? Sonnet. Simple question? Sonnet. Complex analysis? Sonnet.

The dispatcher fixes this:

```
LOCAL   "convert this JSON to YAML"                          → Ollama     $0.000
LOCAL   "what's the command to list open ports on mac?"      → Ollama     $0.000
LIGHT   "generate a .gitignore for Node with TypeScript"     → Kimi       $0.000
MEDIUM  "refactor this endpoint to async/await with error handling"
                                                             → Sonnet    ~$0.003
HEAVY   "redesign the billing architecture to handle 10x more volume.
         compare event sourcing vs CQRS, consider migration trade-offs"
                                                             → Sonnet    ~$0.008
```

**Typical savings: 50-80%.** Most day-to-day interactions (formatting, commands, direct questions) run locally. Budget goes where reasoning actually matters.

### How it works

```
OpenClaw → localhost:8402 → scorer (<1ms)
                                ↓
           ┌────────────────────┼────────────────────┐
           ↓                    ↓                    ↓
        LOCAL               LIGHT/MEDIUM           HEAVY
      Ollama local          Cloud API             Cloud API
      zero cost             low cost              premium
```

The dispatcher is an HTTP proxy that:
1. Intercepts the OpenClaw request
2. Scores complexity using a 14-dimension heuristic scorer (<1ms, no LLM call)
3. Swaps the `model` field in the request body
4. Proxies to the correct upstream (local Ollama or cloud)
5. Automatically translates between protocols (Anthropic ↔ Ollama)

#### Priority rules

| # | Condition | Action |
|---|-----------|--------|
| 1 | Credentials/secrets detected | → LOCAL (always) |
| 2 | Manual user override | → Forced tier |
| 3 | Budget exhausted | → LOCAL |
| 4 | Heuristic score with cost bias | → Tier by complexity |

#### 14 scoring dimensions

Token count · code presence · reasoning markers · technical terms · creative markers · simple indicators · multi-step patterns · question complexity · imperative verbs · constraints · output format · domain specificity · agentic tasks · relay indicators

Each dimension has a configurable weight. Keywords in **PT-BR** (primary) and EN (secondary).

### Quick Start

**Prerequisites:** Node.js 22+ · Ollama running locally · Cloud provider API key

```bash
git clone https://github.com/ch79lab/openclaw-hybrid-dispatcher.git
cd openclaw-hybrid-dispatcher

cp config.example.json config.json
nano config.json                    # edit tiers, models, and upstreams

node test.mjs                       # run tests
node server.mjs                     # start
```

**Integrate with OpenClaw** — in `~/.openclaw/openclaw.json`, point your provider to the dispatcher:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:8402"
      }
    }
  }
}
```

Restart OpenClaw. All requests now go through the dispatcher.

### Features

| Feature | Description |
|---------|-------------|
| **Session-aware** | Tier only escalates, never downgrades within a conversation — eliminates "Frankenstein context" |
| **Tool use detection** | Request with `tools` → auto-bump to MEDIUM (small local models fail at function calling) |
| **Multimodal detection** | Message with image → bump to LIGHT minimum (Ollama may not support vision) |
| **Fallback chain** | If upstream returns 429 or 5xx, automatically tries next tier up |
| **Dual upstream** | Proxy to Ollama (local) and multiple cloud providers with protocol translation |
| **Scoring <1ms** | 14 heuristic dimensions, no LLM classification call |
| **System prompt exclusion** | Only scores user messages — OpenClaw's system prompt doesn't inflate scores |
| **Credential enforcement** | Passwords, API keys, tokens, SSH keys → forced to local Ollama |
| **Cost bias** | At tier boundaries, prefers cheaper tier (configurable) |
| **Budget control** | Daily and monthly limits; when exhausted → everything local |
| **Shadow mode** | Scores and logs without routing — calibrate before going live |
| **Hot-reload** | Config reloads on save (or via `SIGHUP`) |
| **Fail-safe** | Internal error → passthrough without modifying the request |
| **Feedback log** | Every decision logged as JSONL for later analysis |
| **PT-BR first** | Keywords and patterns in Portuguese as primary language |
| **Zero deps** | No external dependencies — Node.js native only |
| **Overrides** | Chat commands `/local`, `/cloud`, `/pro`, `/max` |

### Sensitive data

The dispatcher protects **credentials and secrets**, not analytical data.

**Forced to LOCAL (Ollama):** passwords, API keys, secret keys, bearer tokens, SSH keys, RSA private keys, GitHub tokens (`ghp_`, `gho_`, etc.)

**NOT blocked (can go to cloud):** CPF, CNPJ (Brazilian tax IDs — identifiers, not secrets), emails in context, business data in analyses

The logic: if a user consciously shared a tax ID for analysis, forcing it to the local model hurts quality with no real security gain. Access credentials are different — they should never leave the machine.

### Session-aware routing

The dispatcher tracks conversations. When a tier escalates (e.g., LOCAL to HEAVY), it **stays** at the highest tier until the session expires. This prevents the "Frankenstein context" problem — incoherent responses when half the conversation runs locally and half in the cloud.

```
message 1: "hi"                         → LOCAL  (Ollama)
message 2: "analyze the trade-offs..."  → HEAVY  (Sonnet) — session escalated
message 3: "ok, now summarize"          → HEAVY  (Sonnet) — session hold
message 4: "thanks"                     → HEAVY  (Sonnet) — still in session
... 30min idle → session expires → next conversation starts fresh
```

Configurable via `session.ttlMinutes` (default 30min). Endpoint `/sessions` shows active sessions.

### Fallback chain

If an upstream fails (429 rate limit, 500 server error), the dispatcher automatically tries the next tier up:

```
LIGHT (Kimi 429) → MEDIUM (Sonnet) → success
```

Configurable via `fallback.maxRetries` (default 2). Stats track fallback count.

### Configuration

Copy `config.example.json` → `config.json` and edit.

**Tiers and models:**
```json
{
  "tiers": {
    "LOCAL":  { "upstream": "ollama", "model": "qwen3:8b" },
    "LIGHT":  { "upstream": "cloud",  "model": "claude-haiku-4.5" },
    "MEDIUM": { "upstream": "cloud",  "model": "claude-sonnet-4-6" },
    "HEAVY":  { "upstream": "cloud",  "model": "claude-sonnet-4-6" }
  }
}
```

**Upstreams:**
```json
{
  "upstreams": {
    "ollama": { "baseUrl": "http://127.0.0.1:11434" },
    "cloud":  { "baseUrl": "https://api.anthropic.com" }
  }
}
```

The `cloud` field accepts any Anthropic or OpenAI-compatible API.

**Budget:**
```json
{
  "budget": {
    "enabled": true,
    "dailyLimitUsd": 1.00,
    "monthlyLimitUsd": 30.00,
    "onExhausted": "force_local"
  }
}
```

Scoring weights, keywords, and boundaries are all editable. Auto hot-reload on save.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Status, shadow mode, uptime |
| `/stats` | GET | Daily and monthly statistics |
| `/config` | GET | Current config (no secrets) |
| `/shadow/on` | POST | Enable shadow mode |
| `/shadow/off` | POST | Disable — live routing |
| `/v1/messages` | POST | Proxy with scoring and routing |

### Shadow mode

Starts in shadow mode by default. Scores and logs without altering routing.

```bash
# view decisions
cat ~/.openclaw/feedback.jsonl | jq '{tier, score, reason}'

# tier distribution
cat ~/.openclaw/feedback.jsonl | jq -r .tier | sort | uniq -c | sort -rn

# go live
curl -X POST http://127.0.0.1:8402/shadow/off
```

### Run as service (macOS)

Save as `~/Library/LaunchAgents/com.openclaw.hybrid-dispatcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.hybrid-dispatcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>/PATH/TO/openclaw-hybrid-dispatcher/server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.hybrid-dispatcher.plist
```

### Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

### License

[MIT](LICENSE)
