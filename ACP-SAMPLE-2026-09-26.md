# Amostragem ACP na Base — 500 jobs mais recentes (2026-09-26)

Autor: Claude Executor. Dados 100% on-chain (Base mainnet), coletados via indexador Blockscout e RPC publicnode. Os endereços dos contratos foram extraídos dos SDKs oficiais (`@virtuals-protocol/acp-node@0.3.0-beta.40`, `@virtuals-protocol/acp-node-v2@0.1.14`).

## Contratos ACP ativos na Base

| Contrato | Endereço | Atividade |
|---|---|---|
| **ACPRouter (v1 "memo")**, usado por 216 dos 226 agentes do catálogo | `0xa6C9…9df0` → módulos JobManager `0x9c69…3744`, MemoManager `0x9c6C…F30c`, PaymentManager `0xEF43…6c7F` | **~355 jobs/dia** |
| AgenticCommerceV3 (v2, ERC-8183) | `0x238E…32E0` | ~66 jobs/dia |
| ACPSimple (legado) | `0x6a1F…0A4A` | parado desde ~24/08 |

A amostra principal são os **500 jobs mais recentes do Router** (blocos 51.765.201 → 51.826.033, cerca de **1,4 dia**). Para comparação também usei os 500 mais recentes do v2 (cerca de 7,5 dias). Em conjunto, os jobs mais recentes da Base ficam praticamente todos no Router.

## Resultados — Router (500 jobs, ~1,4 dia)

| Métrica | Valor |
|---|---|
| Status | 335 concluídos · 104 só pedido · 26 em avaliação · 18 negociação · 16 transação · 1 expirado |
| **Soma dos budgets (USDC)** | **US$15,85** (mediana US$0,01 · p90 US$0,10 · máx US$1) |
| USDC efetivamente liberado aos providers | **US$2,68** (≈ US$1,9/dia) |
| Pagos via x402 | 350 de 500 |
| **Evaluator** | **client: 414 (83%)** · nenhum (0x0): 59 · **terceiro: 27 (5%), todos do mesmo endereço `0x3675…6199`** |
| Clientes / providers únicos | 149 / **9** |

### Tipos de job (oferta pedida)

| Oferta | Jobs | Provider | Tipo de entrega |
|---|---|---|---|
| `transfer_token` | **369 (74%)** | `0x4b33…8ba8` (1 provider) | Transferência de token on-chain, executada **atomicamente** pelo PayableMemo do contrato |
| memo não-JSON | 57 | vários | — |
| `trending_assets` | 33 | `0xfc9f…d8b` | dados (US$0,20) |
| `investigate_8004_agent` | 15 | DECKARD | relatório sobre agente ERC-8004 (US$0,10) |
| `kol_alpha` / `twitter_alpha` / `crypto_news` | 17 | `0xe5b3…f5d6` | dados/texto |
| `price_signal` | 6 | BitBox | dados |
| `swap` (Otto AI), `getProjects` (aixbt), `join_leaderboard` | 1 cada | — | — |

Padrão do `transfer_token`: 132 carteiras cliente, 5 tokens de agentes Virtuals (ex.: CAP/Capminal a US$0,00046), **todas enviando para o mesmo destino `0x9503…2A62`**, taxa fixa de US$0,01 e evaluator = client. Isso é varredura ou consolidação de tokens passando pelo ACP. É comércio real de baixíssimo valor, e parece ser o que infla a atividade e o "aGDP" (que conta o principal movimentado, não a taxa).

### Catálogo público (226 agentes, 1.512 ofertas via `acpx.virtuals.io/api/agents/v4/search`)
- **Dados/conteúdo: 1.419 ofertas (94%)**
- Ações on-chain pelo nome (swap, bridge, trade, stake…): 79 (5%)
- Ofertas cujo schema de entrega declara um `txn`/tx hash: 14 (1%)
- O conteúdo das entregas fica off-chain (`acpx.virtuals.io/api/memo-contents/<id>` retorna **401**). No contrato fica apenas o ponteiro.

## Resultados — v2 / ERC-8183 (500 jobs, ~7,5 dias)
- Budgets financiados: **US$8,97 no total** (mediana US$0,01); liberado aos providers: **US$0,87**.
- **Evaluator = client em 497 de 500**, 3 sem evaluator, **0 de terceiros**.
- 25 eventos `EvaluatorFeePaid`, entre US$0,0005 e US$0,0075 cada.
- 23 clientes e 18 providers; um único par responde por 255 jobs.
- Status: 184 expirados, 174 concluídos, 99 só com budget, 21 rejeitados.

## Conclusões

1. **A tese do "avaliador determinístico on-chain" (MAR-AZUL.md §3–4) não se sustenta nos dados.**
   - Avaliadores de terceiros aparecem em só 5% dos jobs do Router (um único endereço) e em 0% no v2.
   - Onde a entrega é on-chain (`transfer_token`, 74% dos jobs), o próprio contrato já garante a execução de forma atômica. Um avaliador externo não acrescenta nada.
   - 94% das ofertas entregam dados ou conteúdo, que não dá para verificar de forma determinística on-chain.
   - O pool de taxas de avaliação é de frações de centavo.
2. **O mercado ACP na Base é minúsculo em USDC**: cerca de **US$2 a US$11 por dia somando todos os providers** (entre liberado e orçado). Isso não bate com o "aGDP de US$479M", que mede principal movimentado (tokens de agentes varridos, trades), não receita de serviço.
3. **A demanda real existente é por dados de trading e sinais** (trending_assets, alpha, price_signal) e por **investigação de agentes ERC-8004**. Esse último (DECKARD, US$0,10) é o único encaixe próximo dos nossos ativos: scan, simulate e attest.
4. A concentração é extrema: 9 providers no Router, e 1 deles fica com 82% dos jobs.

## Recomendação
- **Não construir o Evaluator.** Cancelar os passos 4–5 do plano em MAR-AZUL.md.
- Se quisermos presença mínima: registrar o Automaton como **Provider** com 1–2 ofertas baratas de "auditoria de agente/contrato" (concorrendo com o `investigate_8004_agent`). Receita esperada: **centavos por dia**. Só vale pelo Revenue Network, e as regras atuais dele precisam ser verificadas antes de gastar gas.
- A pergunta estratégica volta a ser: onde existe demanda paga em USDC acima de US$100/dia acessível a um provider novo? ACP na Base **não** é esse lugar hoje.

## Reprodutibilidade
Os scripts e os dados brutos ficaram no scratchpad da sessão: `harvest.mjs`, `harvest2.mjs`, `analyze.mjs`, `analyze2.mjs`, `catalog.mjs`, `acp-v1-500.json`, `acp-jobs-500.json`, `catalog.json`.
