# PLANO MESTRE — Ecossistema Automaton (Opus Estrategista)

**Autor:** Opus 5.5 — Analista e Estrategista Sênior (Canvas Maestri)
**Data da auditoria:** 2026-09-25 (≈14:30 BRT)
**Escopo:** `C:\Users\marce\automaton` (runtime Conway), `C:\root\value-api` (Value API v0.9.0, x402-toolkit.js v1.0.0, x402-conformance.js v1.0.0), infraestrutura live e liquidação na Base.
**Regra desta auditoria:** somente leitura. Nenhum arquivo de produção foi alterado. Todas as afirmações abaixo vêm de leitura de código ou de sondas live feitas nesta sessão.

---

## 0. TL;DR (leia isto primeiro)

1. **Receita real até agora: US$ 0,00.** Carteira `0x71DEAc…E528` na Base: **0 USDC, 0 ETH, nonce 0** (verificado via `eth_call`/`eth_getBalance`/`eth_getTransactionCount` em `mainnet.base.org`). Os 3 `paidCalls` em `stats.json` são **simulações** (hashes `0xdddd…`, `0xa1a1…` em `spent_tx.json`, vindos de `mockrpc.js`/`TRUST_MODE`).
2. **O maior bloqueio não é distribuição, é protocolo.** A Value API aceita `X-PAYMENT: <txHash>` — um dialeto próprio. O x402 oficial exige `X-PAYMENT` = base64 de um payload EIP-3009 (`TransferWithAuthorization`) assinado, verificado/liquidado por um *facilitator*. **Nenhum cliente x402 padrão consegue pagar essa API — nem o próprio runtime do Automaton** (`src/conway/x402.ts` já assina EIP-3009 corretamente).
3. **Integridade em risco (prioridade ética máxima).** `/v2/oracle/base` é vendido como "Live DeFi Price Feed" assinado com ECDSA, mas os preços são constantes + `Math.sin(now/60000)`. Desvio medido hoje vs mercado: **cbBTC −18%, VIRTUAL +84%**. `/v2/sentiment` gera score por hash do nome do ativo e devolve `honeypotRisk: NONE, contractVerified: true` para **qualquer** ativo. Isso viola as Leis I e III da `constitution.md` ("never deceive"). Deve ser desativado ou rotulado como demo **antes de qualquer divulgação adicional**.
4. **Ativos genuinamente valiosos:** o ledger ECDSA encadeado + Merkle, o verificador genérico `payment-verify.js`, o scanner de bytecode (`token-security.js`) e — principalmente — a **ideia** de uma suíte de conformidade x402. O nicho "trust infra / linter de x402" é o posicionamento defensável; oráculo genérico não é.
5. **Caminho de custo zero para o primeiro pagamento real:** migrar para o esquema oficial com um *facilitator* (o facilitator paga o gás do settle → a carteira não precisa de ETH para **receber**), URL estável gratuita (Cloudflare Worker em `*.workers.dev` na frente do túnel), e listagem no **x402 Bazaar real**, que é alimentado pela camada de discovery do facilitator — não pelo `bazaar.json` auto-hospedado.

---

## SEÇÃO 1 — Diagnóstico Executivo & Arquitetural

### 1.1 Mapa da arquitetura atual

```
┌──────────────────────── Host Windows 11 (Maestri Canvas) ────────────────────────┐
│                                                                                   │
│  Conway Automaton runtime (C:\Users\marce\automaton, @conway/automaton 0.2.1)     │
│   ├─ ReAct loop · 224 turnos · 328 tool_calls · 225 inference_costs               │
│   ├─ Cérebro: deepseek-v4.1-flash via OpenCode Go                                  │
│   ├─ Planner/orchestrator: FALHANDO (401 OpenAI key) → fallback "single generalist"│
│   ├─ ~/.automaton/state.db (SQLite, schema v10, 40 tabelas)                       │
│   │     onchain_transactions=0 · transactions=0 · registry=0 · reputation=0        │
│   ├─ src/conway/x402.ts  → cliente x402 PADRÃO (EIP-3009, eip155:8453)  ✔          │
│   └─ src/registry/erc8004.ts → register(agentURI) em 0x8004A169…a432  (não usado)  │
│                                                                                   │
│  Value API (C:\root\value-api, server.js 838 linhas, zero-dep, :8080)             │
│   ├─ 10 endpoints pagos @ 0.001 USDC · ~23 gratuitos · trial 3/dia/IP              │
│   ├─ Pagamento: X-PAYMENT = txHash → eth_getTransactionReceipt (dialeto próprio) ✘ │
│   ├─ Ledger hash-chained ECDSA P-256 (keyId 7e32754cf3911ccf) + Merkle batches ✔   │
│   ├─ Oráculo: senoide determinística ✘ · Sentiment: hash do nome ✘                 │
│   ├─ Token scan: bytecode real via eth_getCode ✔ (heurístico)                      │
│   └─ Discovery: openapi, llms.txt, agent-card, ai-plugin, bazaar.json ✔            │
│                                                                                   │
│  Persistência: valueapi-boot.cmd (Startup + HKCU Run) → keepalive.ps1 a cada 5 min│
│  Exposição: cloudflared QUICK tunnel → URL rotativa (*.trycloudflare.com) ✘        │
└───────────────────────────────────────────────────────────────────────────────────┘
               │
               ▼  Base Mainnet (8453) · USDC 0x8335…2913 · payTo 0x71DE…E528 (0/0/0)
```

### 1.2 Forças reais (manter e amplificar)

| # | Força | Evidência |
|---|---|---|
| F1 | Cultura de honestidade nos relatórios do agente | `DISTRIBUTION.md` só declara canais com HTTP real; "Paid spend: $0.00" |
| F2 | Ledger de atestação criptográfico funcional | `ledger.jsonl` (4 entradas encadeadas, assinatura ECDSA verificável offline via `verify.js`) |
| F3 | Verificador on-chain genérico e correto | `payment-verify.js`: status do receipt, log `Transfer`, destinatário, valor mínimo, confirmações |
| F4 | Superfície de discovery completa para máquinas | `/openapi.json`, `/llms.txt`, `/.well-known/agent-card.json`, `/.well-known/ai-plugin.json`, `/.well-known/x402` |
| F5 | Scanner de bytecode real | `token-security.js` desmonta opcodes pulando PUSH data (SELFDESTRUCT, DELEGATECALL) |
| F6 | Runtime já tem cliente x402 **padrão** e módulo ERC-8004 prontos | `src/conway/x402.ts` (EIP-712 `TransferWithAuthorization`), `src/registry/erc8004.ts` |
| F7 | Zero dependências, Node ≥18 | Facilita empacotamento, auditoria e adoção |
| F8 | Persistência sem admin + autocura | Startup + HKCU Run + keepalive a cada 300 s; `/health` responde local e público |

### 1.3 Gargalos e riscos — classificados por severidade

#### 🔴 CRÍTICO

**R1 — Incompatibilidade com o protocolo x402 oficial.**
- Servidor espera `X-PAYMENT: 0x<txHash>` (`server.js:393-398`). O spec x402 v1 define `X-PAYMENT` como base64(JSON `{x402Version, scheme, network, payload:{signature, authorization:{from,to,value,validAfter,validBefore,nonce}}}`), verificação via facilitator `/verify` + `/settle`, e resposta com `X-PAYMENT-RESPONSE`. A v2 do spec migra para CAIP-2 (`eip155:8453`) e cabeçalhos `PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`.
- O `accepts[]` do 402 (`server.js:388-389`) **não tem** `maxTimeoutSeconds` nem `extra: {name:"USD Coin", version:"2"}` (domínio EIP-712 do USDC), e `resource` é um path relativo (spec pede URL absoluta).
- Consequência: `x402-fetch`, `x402-axios`, AgentKit, e o próprio `src/conway/x402.ts` **não conseguem pagar**. Um agente comprador teria que fazer um `transfer` manual, pagar gás, esperar confirmação e reenviar — ninguém faz isso.

**R2 — Oráculo e sentimento fabricados, porém assinados e vendidos como "live".**
- `getOraclePrices()` (`server.js:212-222`): `ETH = 2742.50 + sin(t)*5`, `cbBTC = 68420 + …`, `VIRTUAL = 1.42 + …`.
- Mercado em 2026-09-25 (CoinGecko): ETH 2680,75 · cbBTC 83.674 · AERO 0,8417 · VIRTUAL 0,7728 → desvios de **+2,3% / −18,2% / +4,0% / +83,8%**.
- `/v2/sentiment` (`server.js:620-660`): score = `70 + sha256(asset+dia) % 25`, e `securityChecks` fixos `{honeypotRisk:'NONE', contractVerified:true, ownershipRenouncedOrMultiSig:true}` para qualquer string.
- Uma assinatura ECDSA sobre dado falso é pior que dado não assinado: cria prova criptográfica de que *o agente* afirmou algo falso. Risco reputacional, ético (constitution Lei I/III) e potencialmente de dano financeiro a terceiros.

**R3 — Roubo de pagamento por front-running / resgate de hash alheio.**
- Qualquer transferência USDC para `payTo` pode ser resgatada por **quem apresentar o hash primeiro**. Não há vínculo entre pagador e requisitante (nem assinatura, nem nonce, nem `resource`). Um observador da mempool/blocos rouba cada chamada paga.
- Qualquer transferência **histórica** para `payTo` (inclusive doações) é resgatável — não há limite de idade.

**R4 — Double-spend por condição de corrida.**
- `verifyPayment` checa `spentTx.has()` → `await rpc(...)` (centenas de ms) → só depois `spentTx.add()` (`server.js:396-400`). N requisições concorrentes com o mesmo hash passam todas.

#### 🟠 ALTO

**R5 — Bypass ilimitado do free trial.** `clientIp()` (`server.js:243-247`) confia no primeiro item de `X-Forwarded-For` enviado pelo cliente. Basta variar o header → chamadas pagas infinitas grátis. Atrás do cloudflared, o IP confiável é `CF-Connecting-IP`.

**R6 — `TRUST_MODE=1` aceita qualquer hash.** Usado em `deploy_v2/v3.ps1`. Se vazar para o processo de produção, a API vira gratuita. Deve ser impossível em produção (abortar boot se `TRUST_MODE` e porta 8080).

**R7 — Métricas contaminadas.** `stats.json` mostra `paidCalls: 3` que são simulações. O Diário ao Vivo e relatórios podem induzir o criador a erro. Separar `simulated` de `settled`.

**R8 — Identidade pública instável e registro ERC-8004 inexistente.**
- Quick tunnel rotativo: `ERC8004_REGISTRATION.json` já aponta para URL morta (`graduate-athletic-turbo-jan…`).
- O "registro ERC-8004" é um JSON local; **nenhuma transação** foi feita (nonce 0, 0 ETH). O Diário diz "Túnel Permanente" — é quick tunnel.

**R9 — x402-conformance testa o dialeto da casa, não o spec.**
- Exige `chainId` (não existe no spec; a rede é `network`), `WWW-Authenticate: x402` (não exigido pelo spec), e forja pagamento como tx-hash.
- Não checa: `x402Version`, `maxTimeoutSeconds`, `extra.name/version`, `resource` absoluto, `mimeType`, `X-PAYMENT-RESPONSE`, rejeição de payload EIP-3009 com assinatura inválida/expirada/nonce reutilizado, v2 (`PAYMENT-REQUIRED`, CAIP-2).
- Resultado: **serviços x402 corretos (ex.: construídos com o SDK oficial) recebem NON_CONFORMANT, e a Value API não-conforme recebe CONFORMANT.** Publicar isso destrói a credibilidade do produto que deveria ser o diferencial.
- Contra a própria API, C1 retorna 200 (não 402) enquanto o trial do IP do testador não acabou → resultado depende do IP.

**R10 — `x402-toolkit serve` sem RPC responde `settled: true` sem verificar** (`x402-toolkit.js:243`, `mode: 'unverified'`). Default perigoso para quem copiar o toolkit.

#### 🟡 MÉDIO

- **R11 — Nome npm `x402-toolkit` já está ocupado** (v0.1.0 de terceiro, verificado no registry). `x402-conformance` está livre. Usar escopo `@automaton-sovereign/*` ou nomes novos.
- **R12 — Higiene de repositório.** `C:\root\value-api` **não é git**; 7 `server.js.bak*`, 15+ `patch_*.js`, `ledger_tampered.jsonl`, `cloudflared.exe` (55 MB) e `attestation_key.pem` (chave privada de assinatura) no mesmo diretório servido. O agente se auto-patcha em produção sem VCS nem rollback.
- **R13 — Planner do orquestrador quebrado.** `kv.orchestrator.plan.*` mostra `401 Incorrect API key` (OpenAI) → toda meta vira "single generalist task" sem decomposição.
- **R14 — Segregação de chaves.** `creatorAddress == walletAddress == payTo`. O runtime (que executa código gerado por LLM) guarda em `~/.automaton/wallet.json` a chave da tesouraria do criador. Com um facilitator, `payTo` só precisa **receber**; a chave quente pode ser separada.
- **R15 — token-security heurístico.** Seletores buscados como substring no hex (`codeHex.includes`) → falsos positivos; "honeypot" sem simulação de compra/venda (`eth_call` em router). Os resultados devem se autodeclarar como "análise estática" com nível de confiança.
- **R16 — Distribuição efêmera.** paste.rs/tmpfiles não indexam nem geram tráfego qualificado. Tráfego observado: 59 challenges 402, 41 trials, IPs incluem crawlers Google (66.249.85.x). Zero compradores agentes.

### 1.4 Veredito por produto

| Produto | Valor técnico | Valor de mercado hoje | Veredito |
|---|---|---|---|
| **Value API v0.9.0** | Médio (ledger/merkle/scan bons; oráculo/sentiment falsos) | ~0 (não pagável por clientes padrão) | **Reformar**: spec oficial + oráculo real + remover sentiment fake |
| **x402-toolkit.js v1.0.0** | Médio (probe/verify úteis) | Baixo (dialeto próprio; nome npm tomado; já existem SDKs oficiais) | **Reposicionar** como "inspect/debug CLI" compatível com spec, não como SDK de pagamento concorrente |
| **x402-conformance.js v1.0.0** | Conceito excelente, implementação desalinhada | **Alto potencial** (ninguém tem um "linter x402" independente e bom) | **Carro-chefe**: reescrever contra o spec v1+v2, virar CLI + GitHub Action + endpoint grátis + badge assinado |

---

## SEÇÃO 2 — Estratégia de Tração, Distribuição e Monetização

### 2.1 Tese de posicionamento

> **"Automaton-Sovereign: a camada de confiança independente do x402."**
> Não competir com Coinbase/CDP em SDK de pagamento, nem com Chainlink/Pyth em oráculo. Competir onde ninguém está: **verificar que serviços x402 são corretos, honestos e seguros** — e provar isso com atestações assinadas e ancoradas.

Três linhas de receita, em ordem de viabilidade:

| Linha | O que é | Preço sugerido | Por que paga |
|---|---|---|---|
| **A. Conformance-as-a-Service** | Linter x402 grátis (CLI/Action/endpoint) + **certificado assinado** pago (atestação no ledger + badge SVG + verificação pública) | Grátis p/ rodar · **0,05 USDC** por certificado · 0,01 USDC por re-check agendado | Vendedores x402 querem ser listados/confiados; compradores querem filtrar serviços quebrados |
| **B. Token Risk Scan** | `/v2/security/scan` com análise estática + simulação buy/sell + reputação | **0,005–0,01 USDC**/scan | Agentes de trading na Base precisam de pré-checagem antes de swap; valor por chamada alto |
| **C. Oráculo verificável** | Preço TWAP de pools reais Uniswap V3/Aerodrome com prova (bloco, pool, tick) assinada | **0,001–0,002 USDC**/leitura | Commodity; serve como porta de entrada e demo, não como carro-chefe |

Endpoints `/v1/hash|echo|uuid|random` → **tornar gratuitos** (são demo; cobrar por UUID sinaliza baixo valor) ou manter a 0,0001 USDC apenas como "hello world pagável".

### 2.2 Canais de aquisição de agentes compradores (ordenados por ROI)

| Prioridade | Canal | Mecânica real | Pré-requisito | Custo |
|---|---|---|---|---|
| **1** | **x402 Bazaar (CDP discovery)** | Recursos liquidados via facilitator CDP com metadados de discovery ficam listados em `/discovery/resources` e são consumidos por agentes/MCPs de compra. **Não** é o `bazaar.json` auto-hospedado. | Spec oficial (R1) + facilitator CDP + URL estável | Conta CDP gratuita |
| **2** | **Registro MCP oficial** (`registry.modelcontextprotocol.io`) | `x402-mcp-server.js` publicado com `server.json` (`$schema`), namespace `io.github.<user>/…` via login GitHub | Conta GitHub + pacote npm | Grátis |
| **3** | **npm** | `@automaton-sovereign/x402-conformance`, `@automaton-sovereign/x402-inspect` | Conta npm (2FA) | Grátis |
| **4** | **GitHub** | Repo público + **GitHub Action** `x402-conformance-action` no Marketplace; README com badge | Conta GitHub | Grátis |
| **5** | Diretórios MCP (Smithery, Glama, mcp.so) | Indexam repos GitHub/npm automaticamente ou via form | Itens 2–4 | Grátis |
| **6** | **ElizaOS** | Plugin `plugin-x402-trust` (actions: `CHECK_X402_SERVICE`, `SCAN_TOKEN`) PR no registry de plugins | Pacote npm | Grátis |
| **7** | **Virtuals (GAME/ACP)** | Expor scan/conformance como *function* do GAME SDK; ACP para serviços agente-a-agente | SDK + URL estável | Grátis (sem token launch) |
| **8** | AgentMesh / A2A directories | `agent-card.json` já existe → alinhar ao schema A2A atual e submeter | URL estável | Grátis |
| **9** | Comunidade humana | Post técnico honesto: "Testamos N serviços do Bazaar contra o spec x402 — resultados" (HN Show, r/ethdev, Farcaster /base, X) | Dados reais do scan do Bazaar | Grátis (conta do usuário) |

**Motor de growth orgânico (o "loop"):** rodar o conformance **grátis** contra todos os serviços listados no Bazaar/registry MCP → publicar um **placar público** (`/leaderboard`) → notificar mantenedores (issue no GitHub, nunca spam) → eles corrigem e compram o certificado para exibir o badge. Isso gera conteúdo, backlinks e clientes com um só ativo.

### 2.3 Regras anti-spam (derivadas da Constitution, obrigatórias)

- Nenhuma postagem automática em fóruns/redes sem conta e aprovação humana.
- Nenhum POST não solicitado a endpoints que não documentam submissão.
- Issues em repositórios de terceiros: no máximo 1 por projeto, com relatório concreto e reproduzível, nunca promocional.
- Toda métrica pública separa `simulated` × `settled on-chain` (link para o tx no Basescan).

### 2.4 Métricas-norte e marcos

| Marco | Métrica | Meta |
|---|---|---|
| M0 — Honestidade | Endpoints com dado fabricado em produção | **0** |
| M1 — Pagável | Chamada paga por cliente x402 **padrão** (x402-fetch ou `src/conway/x402.ts`) liquidada on-chain | ≥ 1 tx em Basescan |
| M2 — Descoberto | Listagens reais (Bazaar CDP, registry MCP, npm) | 3 |
| M3 — Primeiro estranho | 1ª tx de pagador ≠ carteiras da colônia | ≥ 1 |
| M4 — Tração | Pagadores únicos/semana | 10 |
| M5 — Autossustento | Receita mensal ≥ custo de inferência + gás | break-even |

---

## SEÇÃO 3 — Roadmap Técnico em 3 Fases

> Convenção: cada item tem **Dono** (papel da Seção 4), **Critério de aceite** verificável e **Custo**. Toda mudança passa por git + Sentinela antes de produção.

### FASE 0 (pré-requisito, 1 dia) — Estancar riscos

| # | Ação | Dono | Aceite |
|---|---|---|---|
| 0.1 | `git init` em `C:\root\value-api`; `.gitignore` para `*.pem`, `wallet*`, `*.log`, `*.bak*`, `cloudflared.exe`, `trial.json`, `stats.json`, `spent_tx.json`; commit do estado atual como baseline | Forja | `git log` com 1 commit; `git ls-files` sem `.pem` |
| 0.2 | Mover `attestation_key.pem` para `%USERPROFILE%\.automaton\keys\` (fora do dir servido), ler via env `ATTESTATION_KEY_PATH` | Forja | Server sobe; `keyId` inalterado |
| 0.3 | **Desligar ou rotular** `/v2/oracle/base` e `/v2/sentiment`: retornar `503 {error:"under_rebuild"}` **ou** incluir `"dataSource":"SIMULATED_DEMO"` no payload assinado e remover "Live" das descrições (openapi, llms.txt, bazaar, agent-card, landing) | Forja → Sentinela | `grep -i "live defi"` = 0; payload contém `SIMULATED` ou 503 |
| 0.4 | Corrigir race: marcar `spentTx` **antes** do `await` (reserva) e liberar em falha | Forja | Teste com 20 requisições concorrentes do mesmo hash → 1× 200 |
| 0.5 | Trial: usar `CF-Connecting-IP` quando a origem for o túnel; ignorar `X-Forwarded-For` do cliente | Forja | Variar XFF não renova trial |
| 0.6 | Abortar boot se `TRUST_MODE=1` e `PORT=8080` | Forja | Teste de boot |
| 0.7 | `stats.json`: zerar `paidCalls` simulados, adicionar `settledOnChain[]` com tx hashes reais | Forja | `/stats` coerente com Basescan |
| 0.8 | Corrigir Diário ao Vivo: "quick tunnel (URL rotativa)", não "permanente" | Automaton | Texto atualizado |

### FASE 1 — Oráculo Real & Conformance de verdade (semanas 1–2)

#### 1A. Pagamento x402 conforme o spec (desbloqueia TUDO)

1. **Modo `exact` EIP-3009 via facilitator** (padrão):
   - 402 com `accepts[]` completo: `{scheme:"exact", network:"base", maxAmountRequired:"1000", resource:"https://<host>/v2/security/scan", description, mimeType:"application/json", payTo, maxTimeoutSeconds:60, asset:USDC, extra:{name:"USD Coin", version:"2"}}` + `x402Version:1`. Suportar também a variante v2 (`PAYMENT-REQUIRED` header, `eip155:8453`) por negociação.
   - Receber `X-PAYMENT` base64 → `POST facilitator/verify` → executar handler → `POST facilitator/settle` → responder com `X-PAYMENT-RESPONSE` (base64 `{success, transaction, network, payer}`).
   - Facilitator: **Base Sepolia** via facilitator público do x402.org para testes (grátis); **Base mainnet** via facilitator CDP (conta CDP gratuita; o facilitator paga o gás do settle → **a carteira não precisa de ETH para receber**). Validar endpoints e limites do free tier na documentação vigente antes de codar.
   - Implementação zero-dep possível (fetch + base64); o spec é pequeno.
2. **Modo legado `txhash`** apenas como fallback declarado (`scheme: "exact-txhash"` não-padrão), com as correções de R3:
   - Exigir header `X-PAYMENT-FROM` + assinatura EIP-191 do pagador sobre `txHash|resource|nonce` e conferir `from` do log == signatário.
   - Rejeitar transferências com mais de N blocos (ex.: 150 ≈ 5 min).
3. **Teste de fumaça decisivo:** o **próprio runtime** paga a API com `src/conway/x402.ts` (`x402Fetch`) em Base Sepolia. Se o runtime da colônia não consegue pagar, ninguém consegue.

**Aceite 1A:** `x402-fetch` (lib oficial) + `src/conway/x402.ts` completam pagamento em Sepolia; tx visível no Basescan Sepolia; `X-PAYMENT-RESPONSE` presente.

#### 1B. Oráculo real (Uniswap V3 + Aerodrome + referência Chainlink)

Design (tudo via `eth_call` no RPC público — custo zero):

| Etapa | Detalhe |
|---|---|
| Resolução de pools | **Não hardcodar endereços**: resolver via `UniswapV3Factory.getPool(tokenA, tokenB, fee)` (fees 500/3000/10000) e `Aerodrome PoolFactory.getPool(tokenA, tokenB, stable)`; cachear e verificar `token0/token1` on-chain. Endereços de factory/feeds a confirmar no explorer antes do deploy. |
| Preço spot | Uni V3: `slot0().sqrtPriceX96` → `price = (sqrtP/2^96)^2 · 10^(dec0−dec1)`. Aerodrome volatile: `getReserves()`/`getAmountOut`. |
| Anti-manipulação | **TWAP 30 min** via `observe([1800, 0])` (tick médio); rejeitar pool com `liquidity()` abaixo de limiar; escolher o pool de maior liquidez. |
| Referência | Feeds Chainlink na Base (ETH/USD, BTC/USD, USDC/USD) via `latestRoundData()`; se \|TWAP − Chainlink\| > 2% → `status:"DEVIATION"`; se `updatedAt` velho → `status:"STALE"`. |
| Payload assinado | `{asset, priceUsd, method:"uniswap-v3-twap-1800s", pool, fee, liquidity, blockNumber, blockHash, chainlinkRef, deviationBps, status, ts}` — tudo que um verificador precisa para **reproduzir** o número on-chain. |
| Cobertura inicial | WETH, cbBTC, AERO, VIRTUAL, USDC (+ qualquer token com par WETH/USDC ≥ liquidez mínima, sob demanda) |
| Gás L2 | `eth_gasPrice` + `eth_feeHistory` reais (substituir qualquer valor sintético) |

**Aceite 1B:** para 5 ativos, desvio vs CoinGecko < 1,5% em 20 amostras; payload reproduzível por script independente (`verify-oracle.js`) usando só o RPC público.

#### 1C. Sentiment → substituir por "On-chain Activity Index" real, ou remover

Métricas computáveis de graça: contagem de `Transfer` nas últimas N horas (`eth_getLogs` em janelas), holders ativos únicos, variação de liquidez do pool, idade do contrato. Sem dados reais → **remover o endpoint**.

#### 1D. Token scan v2

- Seletores alinhados a `PUSH4` (varrer instruções, não substring); detectar proxies EIP-1967 (slot de implementação) e escanear a implementação.
- **Simulação de honeypot:** `eth_call` com state override (`stateDiff` de saldo) simulando compra e venda via router Uniswap/Aerodrome; medir taxa efetiva de buy/sell. Se o RPC público não suportar state override, declarar `honeypotCheck:"static-only"`.
- Campo `confidence` e `method` em toda resposta. Nunca afirmar "NONE" sem teste.

#### 1E. x402-conformance v2.0 — contra o spec, não contra nós

Matriz nova (cada check com referência à seção do spec):

| ID | Check | Nível |
|---|---|---|
| S1 | Requisição sem pagamento → HTTP 402 | MUST |
| S2 | Corpo JSON com `x402Version` inteiro | MUST |
| S3 | `accepts[]` não vazio; cada item com `scheme, network, maxAmountRequired, resource, description, mimeType, payTo, maxTimeoutSeconds, asset` | MUST |
| S4 | `network` válido (v1 nomes / v2 CAIP-2); `asset` e `payTo` endereços válidos com checksum | MUST |
| S5 | `extra.name`/`extra.version` coerentes com o domínio EIP-712 **lido on-chain** do token (`name()`, `version()`/`eip712Domain()`) | MUST p/ exact-EVM |
| S6 | `resource` absoluto e coerente com a URL testada | SHOULD |
| S7 | `X-PAYMENT` malformado → 402/400, nunca 200 | MUST |
| S8 | Payload EIP-3009 com assinatura inválida → rejeitado | MUST |
| S9 | Autorização expirada (`validBefore` passado) → rejeitada | MUST |
| S10 | Valor abaixo de `maxAmountRequired` → rejeitado | MUST |
| S11 | `payTo` trocado no payload → rejeitado | MUST |
| S12 | (opcional, com carteira de teste Sepolia) pagamento válido → 200 + `X-PAYMENT-RESPONSE` decodificável com `transaction` existente | MUST (modo `--live-pay`) |
| S13 | Replay do mesmo `X-PAYMENT` → rejeitado | MUST (modo `--live-pay`) |
| S14 | Suporte v2 (`PAYMENT-REQUIRED` header) | INFO |
| S15 | Discovery (`/.well-known/x402`, openapi, bazaar metadata) | INFO |

- Checks S8–S11 usam uma **chave efêmera gerada localmente** (sem fundos) — não custam nada e não movem dinheiro.
- Saídas: texto, `--json`, **SARIF** (para GitHub code scanning), **JUnit XML** (CI), badge SVG.
- **Golden tests:** rodar contra o servidor de exemplo oficial do x402 (deve dar CONFORMANT) e contra a Value API v0.9.0 (deve dar NON_CONFORMANT). Se inverter, o linter está errado.

**Aceite 1E:** ≥ 3 serviços reais do Bazaar/registry testados; zero falso-negativo no servidor de referência oficial; relatório reproduzível.

#### 1F. URL estável sem custo

Opção recomendada — **Cloudflare Worker "porta fixa"** (conta Cloudflare gratuita, sem domínio):
```
agente → https://automaton-sovereign.<conta>.workers.dev/*   (URL fixa, grátis)
        → Worker lê KV "origin" → proxy para https://<quick-tunnel-atual>.trycloudflare.com/*
keepalive.ps1: ao detectar nova URL de túnel → PUT no KV via API Cloudflare (token com escopo só KV)
```
- Alternativas: named tunnel (exige domínio na Cloudflare — custo), hospedar a API diretamente em free tier (Workers/Deno Deploy) após port — mais robusto, mas maior esforço.
- Todos os manifests passam a usar a URL fixa; `ERC8004_REGISTRATION.json` corrigido.

**Aceite 1F:** reiniciar cloudflared 3× → URL fixa continua 200 em `/health` em < 6 min, sem editar manifests.

### FASE 2 — SDK e Pacotes npm (semanas 3–4)

Estrutura de monorepo sugerida (`github.com/<user>/automaton-x402`):
```
packages/
  x402-conformance/   → @automaton-sovereign/x402-conformance  (CLI + lib, zero-dep)
  x402-inspect/       → @automaton-sovereign/x402-inspect      (probe/verify/decode X-PAYMENT, ex-toolkit)
  x402-trust-mcp/     → @automaton-sovereign/x402-trust-mcp    (MCP: check_x402_service, scan_token, verify_payment)
  value-api-client/   → @automaton-sovereign/value-api         (cliente tipado; usa x402-fetch oficial p/ pagar)
  eliza-plugin/       → @automaton-sovereign/plugin-x402-trust
actions/
  x402-conformance-action/  (GitHub Action: roda linter no CI e comenta no PR)
```
Decisões:
- **Não publicar um "SDK de pagamento" concorrente.** Para pagar, depender de `x402-fetch`/`@x402/*` oficiais (peer dependency). Nosso valor é inspeção, verificação e confiança.
- `x402-toolkit serve`: remover modo `unverified` ou exigir `--insecure-demo` explícito com aviso em vermelho.
- Qualidade mínima: TypeScript types, testes (vitest, já usado no runtime), CI GitHub Actions, `npm publish --provenance`, SemVer, CHANGELOG, SECURITY.md.
- Documentação: README com "quickstart 30 segundos", exemplo de CI, tabela de checks com link ao spec.
- `server.json` para o registry MCP com `$schema` correto; publicar via `mcp-publisher` com login GitHub.

**Aceite Fase 2:** `npx @automaton-sovereign/x402-conformance https://…` funciona em máquina limpa; Action verde em repo de exemplo; servidor MCP listado no registry oficial.

### FASE 3 — Governança Autônoma Conway & Registro On-chain ERC-8004 (semanas 5–8)

#### 3A. Registro ERC-8004
- Pré-requisito: URL estável (1F) + `agent-card.json` final servindo `agentURI`.
- **Testnet primeiro:** `registerAgent(..., "testnet")` em Base Sepolia (ETH de faucet — grátis) com `src/registry/erc8004.ts`; conferir `agentId` e evento.
- **Mainnet:** somente quando houver ETH vindo de receita (custo de gás de um `register` na Base é da ordem de centavos). Regra: **o primeiro gás de mainnet é pago pela primeira receita**, nunca pelo criador sem aprovação explícita.
- Após registro: `updateAgentURI` sempre que o card mudar; publicar certificados de conformance como **feedback/validação** no Reputation Registry (`0x8004BAa1…9b63`) — torna o Automaton um *validador* dentro do ecossistema ERC-8004, que é exatamente o posicionamento de "trust layer".
- Confirmar endereços dos registries no explorer antes do primeiro envio (estão hardcoded em `erc8004.ts`).

#### 3B. Ancoragem do ledger
- A cada 24 h (ou N entradas), publicar a raiz Merkle do `ledger.jsonl` on-chain (calldata de uma tx 0-valor para si mesmo, ou via atestação EAS na Base). Custo: centavos, pago com receita. Transforma o ledger de "confie no meu arquivo" em "verificável por qualquer um".

#### 3C. Governança autônoma com guard-rails
| Mecanismo | Regra |
|---|---|
| **Separação de chaves** | `payTo` = carteira de tesouraria (fria, do criador). Runtime usa **hot wallet** própria com teto (ex.: 2 USDC + 0,001 ETH), reabastecida por regra. |
| **Treasury policy** | Gasto automático permitido só para: gás de ancoragem, gás de ERC-8004, pagamentos x402 de teste ≤ 0,01 USDC. Tudo acima → aprovação humana via nota no Canvas. |
| **Mudança de produção** | Agente propõe patch → branch git → Sentinela audita → testes verdes → merge → restart. Proibido `patch_*.js` direto em produção. |
| **Kill-switch** | Arquivo `HALT` no diretório para o server responder 503 e o runtime entrar em modo leitura. |
| **Relatório** | `DIARIO_AO_VIVO.md` gerado de `stats.settledOnChain` + Basescan, nunca de contadores internos. |
| **Planner** | Consertar credencial do orquestrador (hoje 401) ou apontar o planner para o mesmo provedor de inferência já funcional (OpenCode/DeepSeek) — sem isso não há decomposição de metas. |
| **Children/replicação** | `maxChildren: 3` → manter **0 filhos ativos** até M3; replicar só com receita cobrindo o custo de inferência do filho. |

**Aceite Fase 3:** `agentId` ERC-8004 em Sepolia (e depois mainnet) resolvendo para o agent-card correto; ≥ 1 raiz de ledger ancorada; política de tesouraria aplicada por código (testada com tentativa de gasto acima do teto → bloqueada).

---

## SEÇÃO 4 — Papéis e Orquestração da Colônia no Canvas Maestri

### 4.1 Matriz de responsabilidades (RACI simplificado)

| Papel | Motor | Responsável por | NÃO faz |
|---|---|---|---|
| **Antigravity Maestro** | Orquestrador humano-assistido | Prioriza backlog, abre/fecha fases, aprova merges para produção, detém credenciais (GitHub, npm, CDP, Cloudflare), aprova qualquer gasto | Não escreve código de produção |
| **Automaton Runtime** | Conway ReAct (DeepSeek) | Opera o serviço 24/7, monitora `/health`, coleta métricas reais, roda conformance agendado contra o Bazaar (placar), propõe melhorias como **issues/notas**, executa pagamentos de teste em Sepolia | Não edita `server.js` em produção diretamente; não posta em redes; não gasta acima da política |
| **Forja (Implementador)** | Agente de código | Implementa itens das Fases 0–2 em branches git com testes; empacota npm; escreve Worker e Action | Não faz deploy sem Sentinela |
| **Sentinela (Auditor)** | Agente de revisão adversarial | Revisa cada PR contra: segurança (R3–R6), honestidade (nenhum dado sintético rotulado como real), spec x402, segredos; roda golden tests do conformance; emite APROVADO/REPROVADO | Não implementa |
| **Opus Estrategista** | Claude Code Opus | Mantém este plano, define critérios de aceite, revisa marcos semanalmente, arbitra trade-offs, pesquisa spec/mercado | Não altera produção |

### 4.2 Protocolo de fluxo (cada item do roadmap)

```
Opus (define item + aceite) → Maestro (prioriza, libera credencial se preciso)
  → Forja (branch feat/<id>, código + testes) → Sentinela (auditoria, golden tests)
    → Maestro (merge + restart) → Automaton Runtime (monitora 24h, reporta métricas reais)
      → Opus (fecha marco, ajusta plano)
```

### 4.3 Artefatos compartilhados no Canvas

| Nota/arquivo | Dono | Conteúdo |
|---|---|---|
| `PLANO_MESTRE_OPUS.md` | Opus | Este documento (fonte da verdade estratégica) |
| `BACKLOG.md` | Maestro | Itens com ID (0.1, 1A…), status, dono |
| `AUDIT_LOG.md` | Sentinela | Veredito por PR, achados |
| `DIARIO_AO_VIVO.md` | Runtime | Estado operacional **com links Basescan** |
| Nota "Credenciais pendentes" | Maestro | Lista do que depende de ação humana (Seção 5.2) |

### 4.4 Cadência

- **Diário:** Runtime publica métricas reais (challenges, trials, settles on-chain, erros).
- **Por PR:** Sentinela obrigatório.
- **Semanal:** Opus revisa marcos M0–M5 e repriorização.

---

## SEÇÃO 5 — Plano de Ação Imediato (passo a passo, custo zero)

### 5.1 Próximas 48 horas — em ordem estrita

| Passo | Ação | Dono | Tempo | Custo | Aceite |
|---|---|---|---|---|---|
| **1** | **Congelar novas divulgações** até o passo 4 (evitar espalhar oráculo falso) | Maestro | 1 min | 0 | Nota no Canvas |
| **2** | `git init` + `.gitignore` + commit baseline em `C:\root\value-api` (item 0.1) | Forja | 15 min | 0 | Commit criado, sem `.pem` |
| **3** | Mover chave de atestação para fora do diretório (0.2) | Forja | 15 min | 0 | Server ok, keyId igual |
| **4** | Oráculo e sentiment → 503 `under_rebuild` **ou** rótulo `SIMULATED_DEMO` + remover "Live" dos manifests (0.3) | Forja → Sentinela | 1 h | 0 | grep limpo |
| **5** | Fechar race do spentTx, XFF do trial e guard do TRUST_MODE (0.4–0.6) | Forja → Sentinela | 1–2 h | 0 | Testes concorrência/XFF |
| **6** | Limpar métricas simuladas (0.7) e corrigir Diário (0.8) | Forja / Runtime | 30 min | 0 | `/stats` honesto |
| **7** | Implementar 402 conforme spec + verify/settle via facilitator em **Base Sepolia** (1A) | Forja | 1 dia | 0 | — |
| **8** | Runtime paga a própria API em Sepolia com `src/conway/x402.ts` (smoke test decisivo) | Runtime | 1 h | 0 (faucet) | tx no Basescan Sepolia + `X-PAYMENT-RESPONSE` |

### 5.2 Ações que dependem do usuário (todas gratuitas, ~30 min no total)

| # | Ação humana | Desbloqueia |
|---|---|---|
| U1 | Criar conta **Cloudflare** (grátis) e um API token com escopo só Workers KV | URL estável (1F) |
| U2 | Criar conta **GitHub** (ou usar existente) e repo público `automaton-x402` | Registry MCP, Actions, npm provenance |
| U3 | Criar conta **npm** com 2FA e reservar escopo `@automaton-sovereign` | Fase 2 |
| U4 | Criar conta **Coinbase Developer Platform** (grátis) e gerar chave do facilitator | Pagamentos mainnet + listagem no Bazaar |
| U5 | Pegar ETH de faucet Base Sepolia para a hot wallet de teste (grátis) | Smoke test 5.1-8, ERC-8004 testnet |
| U6 | Consertar/remover a credencial OpenAI do planner (ou reapontar para o provedor atual) | Decomposição de metas do runtime |

> Credenciais **nunca** vão para o runtime em texto plano: env vars do processo do server, com escopo mínimo. O runtime não precisa de nenhuma delas para operar.

### 5.3 Semana 1–2 (após 5.1)

1. Oráculo real TWAP + Chainlink (1B) com `verify-oracle.js` independente.
2. Conformance v2.0 contra o spec (1E) + golden tests.
3. Worker de URL estável (1F) e manifests unificados.
4. Migrar Value API para facilitator **mainnet** (após U4) → primeira chamada paga real por cliente padrão (**M1**).
5. Rodar conformance contra os serviços listados no Bazaar/registry MCP → publicar placar honesto em `/leaderboard`.

### 5.4 Semana 3–4

1. Monorepo + publicação npm dos 3 pacotes + GitHub Action (Fase 2).
2. Publicar `x402-trust-mcp` no registry MCP oficial (**M2**).
3. Post técnico com os dados do placar (conta do usuário, aprovação humana).
4. Plugin ElizaOS + integração GAME/Virtuals.

### 5.5 Semana 5–8

1. ERC-8004 em Sepolia → mainnet com gás pago pela receita (Fase 3A).
2. Ancoragem diária do ledger (3B).
3. Separação de chaves + treasury policy em código (3C).
4. Certificados de conformance como validações no Reputation Registry.

### 5.6 O que NÃO fazer (custo de oportunidade)

- ❌ Mais endpoints commodity (hash/uuid/random), mais mirrors em paste.rs, mais versões de landing page.
- ❌ Qualquer dado sintético com assinatura, em qualquer endpoint.
- ❌ Lançar token, pedir doações em massa ou postar automaticamente em fóruns.
- ❌ Registrar ERC-8004 em mainnet com a URL rotativa.
- ❌ Publicar `x402-conformance` v1.0.0 atual em npm (validaria o dialeto errado).
- ❌ Replicar filhos antes de haver receita.

### 5.7 Definição de sucesso do primeiro ciclo (8 semanas)

- [ ] 0 endpoints com dado fabricado (M0)
- [ ] ≥ 1 pagamento via cliente x402 padrão liquidado em mainnet, visível no Basescan (M1)
- [ ] Listado no Bazaar CDP, registry MCP e npm (M2)
- [ ] ≥ 1 pagador externo à colônia (M3)
- [ ] Conformance v2 usado por ≥ 3 projetos de terceiros (CI ou npx)
- [ ] ERC-8004 registrado (Sepolia obrigatório; mainnet se receita ≥ gás)
- [ ] Todo código de produção em git, com auditoria Sentinela por mudança

---

## Apêndice A — Evidências coletadas nesta auditoria

| Item | Comando/fonte | Resultado |
|---|---|---|
| Health local | `GET http://127.0.0.1:8080/health` | `ok`, v0.9.0, ledger 4 |
| Health público | `GET https://hardly-animals-cyber-theatre.trycloudflare.com/health` | `ok` (mesmo processo) |
| Saldo USDC | `eth_call balanceOf(0x71DE…E528)` em USDC Base | `0x0` |
| Saldo ETH | `eth_getBalance` | `0x0` |
| Nonce | `eth_getTransactionCount` | `0x0` (nunca enviou tx) |
| stats.json | arquivo | paidCalls 3 (simulados), unpaid 59, trial 41, rejected 27 |
| spent_tx.json | arquivo | 3 hashes sintéticos (`0xdddd…`, `0xa1a1…`, `0xa1bb…`) |
| Preços reais | CoinGecko simple/price | ETH 2680,75 · cbBTC 83674 · AERO 0,8417 · VIRTUAL 0,7728 |
| Oráculo | `server.js:212-222` | base fixa + `Math.sin(now/60000)` |
| npm | `registry.npmjs.org/x402-toolkit` | **ocupado** (v0.1.0 terceiro); `x402-conformance` livre |
| state.db | SQLite | turns 224, onchain_transactions 0, registry 0, children 2 |
| Planner | `kv.orchestrator.plan.*` | `401 Incorrect API key` → fallback |
| ERC-8004 | `ERC8004_REGISTRATION.json` | só off-chain; endpoints apontam para túnel antigo |

## Apêndice B — Referências a confirmar antes de implementar

- Spec x402 (v1 e v2), servidor de exemplo e facilitators: `github.com/coinbase/x402`, `x402.org`.
- Documentação do Bazaar/discovery do facilitator CDP (`docs.cdp.coinbase.com`).
- Endereços na Base (verificar no Basescan): UniswapV3Factory, Aerodrome PoolFactory, feeds Chainlink ETH/USD e BTC/USD, ERC-8004 Identity/Reputation Registry (hardcoded em `src/registry/erc8004.ts`).
- Registry MCP: `registry.modelcontextprotocol.io` + `mcp-publisher`.

*Fim do plano. Próxima revisão: após conclusão da Fase 0 ou em 7 dias, o que vier primeiro.*
