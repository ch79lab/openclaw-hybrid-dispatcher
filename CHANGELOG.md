# Changelog

> **[Português](#português)** · **[English](#english)**

Formato / Format: [Keep a Changelog](https://keepachangelog.com/)

---

## Português

### [1.0.0] - 2026-03-12

#### Adicionado
- **Session-aware routing:** tier só sobe dentro da conversa, nunca desce — elimina "Frankenstein context"
- **Tool use detection:** requests com `tools` recebem bump automático para MEDIUM
- **Multimodal detection:** mensagens com imagem bump para LIGHT mínimo
- **Fallback chain:** upstream 429/5xx → tenta próximo tier automaticamente
- Multi-provider: cada tier aponta para upstream independente (Ollama, Moonshot, Anthropic, etc.)
- Proxy HTTP com scorer heurístico de 14 dimensões (<1ms)
- Tradução automática de protocolo Anthropic ↔ Ollama
- Credential enforcement: senhas, API keys, tokens → forçados para Ollama local
- CPF/CNPJ deliberadamente NÃO bloqueados (dados analíticos, não segredos)
- Cost bias: nas fronteiras entre tiers, prefere o mais barato
- Budget control: limites diário e mensal, com fallback para local
- Shadow mode: classifica sem rotear, para calibração
- Hot-reload de config (watch + SIGHUP)
- Fail-safe: erro interno → passthrough inalterado
- Feedback log em JSONL para análise posterior
- Overrides via chat: `/local`, `/cloud`, `/pro`, `/max`
- Keywords bilíngues PT-BR (primário) + EN
- System prompt excluído do scoring
- Endpoints: /health, /stats, /config, /shadow/*, /sessions
- Suite de 20 testes automatizados
- Zero dependências externas

---

## English

### [1.0.0] - 2026-03-12

#### Added
- **Session-aware routing:** tier only escalates within a conversation, never downgrades — eliminates "Frankenstein context"
- **Tool use detection:** requests with `tools` auto-bump to MEDIUM
- **Multimodal detection:** messages with images bump to LIGHT minimum
- **Fallback chain:** upstream 429/5xx → automatically tries next tier up
- Multi-provider: each tier points to independent upstream (Ollama, Moonshot, Anthropic, etc.)
- HTTP proxy with 14-dimension heuristic scorer (<1ms)
- Automatic Anthropic ↔ Ollama protocol translation
- Credential enforcement: passwords, API keys, tokens → forced to local Ollama
- CPF/CNPJ deliberately NOT blocked (analytical data, not secrets)
- Cost bias: at tier boundaries, prefers cheaper option
- Budget control: daily and monthly limits with local fallback
- Shadow mode: scores without routing, for calibration
- Config hot-reload (watch + SIGHUP)
- Fail-safe: internal error → unchanged passthrough
- JSONL feedback log for later analysis
- Chat overrides: `/local`, `/cloud`, `/pro`, `/max`
- Bilingual keywords PT-BR (primary) + EN
- System prompt excluded from scoring
- Management endpoints: /health, /stats, /config, /shadow/*, /sessions
- 20 automated tests
- Zero external dependencies
