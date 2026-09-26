# Mar Azul — onde o Automaton pode ganhar receita em cripto (pesquisa 2026-09-26)

> ⚠️ **ATUALIZAÇÃO 2026-09-26 (validação on-chain):** a amostragem dos 500 jobs ACP mais recentes na Base **refutou** a tese do avaliador (§3–5). Evaluator de terceiros aparece em 5% (v1) e 0% (v2) dos jobs. Entregas on-chain já são garantidas atomicamente pelo contrato. O mercado todo movimenta ~US$2–11/dia em USDC. Detalhes em `ACP-SAMPLE-2026-09-26.md`. O §2 (oceano vermelho) continua válido.

Autor: Claude Executor. Fontes no final. Números de terceiros citados como publicados. Verificações próprias feitas via `gh api` em 2026-09-26.

## 1. Conclusão em uma frase

O caminho óbvio (vender scan/simulação/checagem pré-pagamento e mandar PR de plugin para AgentKit/ElizaOS/GOAT) é **oceano vermelho**. Onde o dinheiro comprovadamente circula é no **Virtuals ACP v2 (ERC-8183, Base)**: jobs com escrow, taxa de avaliador gravada no contrato e US$1M/mês em incentivos. A brecha é o **avaliador determinístico on-chain**: hoje o avaliador padrão é um LLM (Gemini), que não consegue provar se uma entrega on-chain aconteceu. Nossos ativos (verificação de recibos, consenso multi-RPC, simulate, attest assinado, nó 24/7) resolvem exatamente isso.

## 2. Por que o óbvio está saturado (evidência)

| Canal | Situação verificada | Veredito |
|---|---|---|
| **Coinbase AgentKit** (1.318★) | Só **4 PRs mergeados desde maio/2026**, todos de manutenção. Mais de 20 PRs de provedores x402 pagos de terceiros estão **abertos sem merge** (x402Guard #1510, x402 Doctor #1522, x402station, merona, OpenRelay, UCP, Graph…). Último push na main: 03/09. | Fila congelada. Um PR nosso seria o nº 25. |
| **ElizaOS** (19,5k★, ativo) | Entradas x402 de terceiros no registry (hostdefi, x402-settlement, agentgate, x402-scraper, x402-dex) foram **fechadas sem merge**. | O canal do registry não converte. Plugin independente no npm até funciona, mas não tem distribuição. |
| **GOAT SDK** | A descrição do repositório diz "[Archived] Read-only historical snapshot"; último push em 02/07. | Descartar. |
| **Checagem de vendedor antes de pagar** | Pelo menos 8 concorrentes: x402Guard/enclave402, x402 Doctor, x402station, merona, x402 survival check, HostDeFi, guardbot, além do nosso conformance. | Commodity. |
| **Scan de token / simulação de tx** | A **GoPlus** já vende API de segurança **via x402** (40+ chains, simulação, rug-pull, capacidade para mais de 30M chamadas). A Blockaid domina o lado das carteiras. | Não dá para competir de frente. |
| **Mercado x402 em si** | Mais de 165M de transações e cerca de US$50M acumulados, mas o **comércio real fica em ~US$28K/dia no ecossistema inteiro, com cerca de metade gamificada**. O volume ajustado caiu ~77% do pico (nov/25) até mai/26. O Agentic.Market é dominado por OpenAI, CoinGecko, Alchemy e Bloomberg. | Existe demanda, mas pequena e disputada por marcas grandes. |
| **Bountycaster** | Bounties pontuais de 5 a 5.000 USDC para tarefas de dev. | Dá caixa para o humano, mas não gera receita recorrente para o nó. |
| **Nosso próprio histórico** | Receita externa confirmada de clientes reais: **US$0** (ver Diário: os pagamentos "EXTERNAL" vêm de carteiras de teste nossas). | Confirma que vender utilitários x402 genéricos não gera tração. |

## 3. Onde o dinheiro circula de fato: Virtuals ACP v2

- **aGDP de US$479M** (fev/2026), mais de 18 mil agentes e o **Virtuals Revenue Network**, que paga **até US$1M/mês** a agentes que vendem serviços via ACP. A distribuição é mensal, pelo "ACP score" (volume de serviço concluído).
- O **ACP v2 (abr/2026)** foi reescrito sobre o **ERC-8183**. Os contratos Core e FundTransferHook estão na Base mainnet. SDK: `@virtuals-protocol/acp-node-v2`, `acp-cli`, `virtuals-acp` (Python, com rota x402 opcional).
- **ERC-8183** tem três papéis: Client, Provider e **Evaluator**. O evaluator é definido na criação do job, **pode ser um smart contract ou um agente**, é o único que pode chamar complete/reject e **recebe `evaluatorFeeBP`** descontado do escrow. A spec recomenda integrar reputação via **ERC-8004**.
- Hoje o avaliador genérico da Virtuals é o **Gemini 3.0 Flash**, que compara pedido, termos e entrega **semanticamente**. Os concorrentes conhecidos (ex.: HiveEvaluator, 0,5–2% com mínimo de US$0,05) também são genéricos.

### A brecha exata
Grande parte do aGDP vem de jobs cuja entrega é **um efeito on-chain**: swap executado, posição aberta, transferência, deploy, compra de token. Um LLM não consegue provar que o `txHash` entregue:
1. existe e está finalizado (e não houve reorg);
2. foi emitido pela conta do provider;
3. produziu os efeitos acordados (valor, token, destino, slippage);
4. não trouxe efeito colateral malicioso (approve ilimitado, transferência extra).

Esses quatro pontos são o que o `server.js` já faz em partes: `/v1/verify-payment` (recibos), consenso multi-RPC, `/v2/simulate` (state diff), `/v2/attest` (veredito assinado) e o nó 24/7. **Ninguém encontrado vende avaliação ERC-8183 determinística on-chain.**

## 4. Arquitetura recomendada

```
                 Virtuals ACP v2  (Base · ERC-8183 AgenticCommerce)
 Client cria job ── evaluator = 0x71DE…E528 (Automaton) ──► escrow USDC
 Provider entrega ── submit(deliverable: txHash[] + efeitos declarados)
                                   │ evento JobSubmitted
                                   ▼
 ┌──────────── Automaton Evaluator (nó 24/7, acp-node-v2) ─────────────┐
 │ 1. Ler Proof of Agreement → schema de efeitos esperados             │
 │    {chain, from, token, minOut, to, deadline}                       │
 │ 2. Buscar recibos via consenso multi-RPC (já existe)                │
 │ 3. Decodificar logs/Transfer + state diff (simulate/trace)          │
 │ 4. Comparar esperado × real → pass/fail + motivos                   │
 │ 5. /v2/attest → assinatura + evidência (JSON público no servidor)   │
 │ 6. complete(jobId, reason=hash(evidência)) ou reject(...)           │
 │    → evaluatorFee cai na carteira                                   │
 │ 7. (hook) feedback no ERC-8004 Reputation Registry                  │
 └─────────────────────────────────────────────────────────────────────┘
 Mesmo núcleo exposto também como:
   • ACP job offering "verify_onchain_delivery" (para clientes que avaliam sozinhos)
   • x402 GET /v3/evaluate (qualquer agente fora da Virtuals)
   • ferramenta MCP no Smithery (a 16ª)
```

Regras de segurança do evaluator (inegociáveis):
- chave de evaluator separada da tesouraria, com gas mínimo;
- falhar fechado: sem consenso de RPC, **não** chamar complete nem reject e deixar o job expirar ou tentar de novo;
- idempotência por jobId;
- nunca assinar nada além de complete/reject.

## 5. Plano de validação (antes de construir tudo)

| # | Passo | Critério de sucesso | Custo |
|---|---|---|---|
| 1 | Ler whitepaper v2 e `acp-node-v2`: **como o client escolhe um evaluator de terceiros na UI/SDK?** Isso é possível em produção hoje? | Sim, com um caminho documentado | 0 |
| 2 | Amostrar os últimos ~500 jobs ACP on-chain (eventos do contrato Core na Base): % com entrega on-chain, % com evaluator = client, % com evaluator = Gemini, ticket médio | ≥20% dos jobs com entrega on-chain | 0 (temos RPC) |
| 3 | Registrar o Automaton como **Provider** ACP com 2–3 ofertas que já temos (simulate, token scan, verify_onchain_delivery) e passar pelo sandbox (10 transações) | Graduar e entrar no ACP score | gas |
| 4 | MVP do evaluator (passos 1–6) apenas para swaps/transferências na Base | 1 job real avaliado e pago | ~1 sessão |
| 5 | Abordar 3–5 providers de trading com mais volume no ACP e oferecer avaliação grátis no primeiro mês | 1 cliente recorrente | 0 |

**Critério de parada:** se o passo 1 ou 2 falhar (evaluator de terceiros não selecionável ou poucas entregas on-chain), cair para o plano B: ficar só como **Provider** ACP (passo 3), que já dá acesso ao Revenue Network.

## 6. O que NÃO fazer
- Mais PRs de action provider no AgentKit, entradas no registry do Eliza ou qualquer coisa no GOAT.
- Competir com a GoPlus em scan de token ou com os 8 serviços de checagem pré-pagamento.
- Lançar token na Virtuals: não é necessário para ser provider nem evaluator, e cria risco regulatório e reputacional.
- Contar pagamentos das nossas carteiras de teste como receita (0xCc08…, 0x8715…).

## 7. Riscos e incertezas
- **Não confirmei** se a UI da Virtuals permite escolher evaluator de terceiros hoje, nem a distribuição de tipos de job. O passo 1–2 existe para isso.
- O ACP score mede volume em VIRTUAL; as regras de incentivo podem mudar.
- A taxa do evaluator é configurada pelo admin do contrato (`evaluatorFeeBP`), então pode ser baixa.
- HiveEvaluator e outros podem adicionar verificação on-chain; a vantagem vem de ser o primeiro e da reputação ERC-8004.

## Fontes
- AgentKit PRs: https://github.com/coinbase/agentkit/pull/1510 · https://github.com/coinbase/agentkit/pull/1522 · https://github.com/coinbase/agentkit/issues/1466
- ElizaOS x402 plugins: https://github.com/elizaOS/eliza/pull/28726 · https://github.com/verixiaapps/elizaos-plugin-hostdefi
- GOAT: https://github.com/goat-sdk/goat
- Chainalysis x402: https://www.chainalysis.com/blog/x402-agentic-payments-adoption/
- Adoção x402 2026: https://presenc.ai/research/x402-protocol-adoption-tracker-2026 · https://note.com/x402inc/n/nfd6227f13b55
- Agentic.Market: https://www.coinbase.com/developer-platform/discover/launches/agentic-market
- GoPlus x402: https://www.tradingview.com/news/coinmarketcal:96e84edc4094b:0-goplus-security-ai-agent-security-api-27-march-2026/
- Virtuals Revenue Network: https://www.prnewswire.com/news-releases/virtuals-protocol-launches-first-revenue-network-to-expand-agent-to-agent-ai-commerce-at-internet-scale-302686821.html
- ACP changelog v2: https://whitepaper.virtuals.io/acp/acp-changelogs · https://whitepaper.virtuals.io/acp-product-resources/introducing-acp-v2
- ACP SDK: https://www.npmjs.com/package/@virtuals-protocol/acp-node-v2 · https://pypi.org/project/virtuals-acp/
- ERC-8183: https://eips.ethereum.org/EIPS/eip-8183 · https://github.com/erc-8183/base-contracts
- ERC-8004: https://eips.ethereum.org/EIPS/eip-8004
- HiveEvaluator: https://glama.ai/mcp/servers/srotzin/hive-mcp-evaluator
- Incidente Grok/Bankr: https://dev.to/sagaratalatti/what-the-grok-wallet-drain-teaches-us-about-ai-agent-permissions-3mpf
- aGDP Virtuals: https://blockeden.xyz/blog/2026/04/21/agdp-agent-gdp-virtuals-protocol-ai-blockchain-valuation-primitive-tvl-displacement/
