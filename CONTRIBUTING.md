# Contribuindo / Contributing

> **[Português](#português)** · **[English](#english)**

---

## Português

### Setup local

```bash
git clone https://github.com/ch79lab/openclaw-hybrid-dispatcher.git
cd openclaw-hybrid-dispatcher
cp config.example.json config.json
# editar config.json com seus upstreams locais
```

### Testes

```bash
node test.mjs
```

Os testes criam mock servers locais (portas 18998, 19001, 19002) — não precisam de Ollama ou API key.

### Enviando mudanças

1. Fork o repositório
2. Crie uma branch (`git checkout -b minha-feature`)
3. Rode os testes — todos devem passar
4. Commit com mensagem descritiva
5. Abra um Pull Request

### Convenções

- **Código:** ES modules, Node 22+, zero dependências externas
- **Config:** Toda mudança de comportamento deve ser configurável via `config.json`
- **Testes:** Toda feature nova precisa de teste
- **Keywords:** PT-BR primeiro, EN como secundário
- **Sensitive patterns:** Apenas credenciais e segredos. Dados analíticos (CPF, CNPJ, etc.) NÃO devem ser bloqueados.

### Reportando problemas

Abra uma issue com: o que aconteceu vs. o que esperava, versão do Node.js (`node -v`), SO, e log relevante (sanitize credenciais).

---

## English

### Local setup

```bash
git clone https://github.com/ch79lab/openclaw-hybrid-dispatcher.git
cd openclaw-hybrid-dispatcher
cp config.example.json config.json
# edit config.json with your local upstreams
```

### Tests

```bash
node test.mjs
```

Tests create local mock servers (ports 18998, 19001, 19002) — no Ollama or API key required.

### Submitting changes

1. Fork the repository
2. Create a branch (`git checkout -b my-feature`)
3. Run tests — all must pass
4. Commit with a descriptive message
5. Open a Pull Request

### Conventions

- **Code:** ES modules, Node 22+, zero external dependencies
- **Config:** All behavior changes must be configurable via `config.json`
- **Tests:** Every new feature needs a test
- **Keywords:** PT-BR first, EN as secondary
- **Sensitive patterns:** Credentials and secrets only. Analytical data (CPF, CNPJ, etc.) must NOT be blocked.

### Reporting issues

Open an issue with: what happened vs. what you expected, Node.js version (`node -v`), OS, and relevant logs (sanitize credentials).
