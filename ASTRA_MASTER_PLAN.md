# Plano Mestre Estratégico — Ecossistema Conway / Automaton

**Responsável estratégico: Astra**  
**Data: 25 de setembro de 2026**  
**Produtos de referência: Value API v0.9.0, x402-toolkit.js v1.0.0 e x402-conformance.js v1.0.0**

> **Base de evidência:** este plano incorpora os achados técnicos apresentados no pedido. A ferramenta de execução local ficou indisponível nesta sessão; portanto, não houve nova inspeção dos repositórios, dos turnos Conway, das publicações ou da carteira. As referências oficiais de x402, Uniswap e ERC-8004 foram consultadas. Prazos e metas abaixo são propostas operacionais.

**Direção estratégica:** tornar a Value API um serviço de dados verificáveis, comprado por agentes por meio de um fluxo de pagamento interoperável. Usar o toolkit para facilitar a integração e a suíte de conformance para demonstrar compatibilidade e atrair desenvolvedores.

A sequência prioritária é:

**Integridade dos dados → pagamento confiável → distribuição → compradores recorrentes → autonomia ampliada.**

---

## 1. Diagnóstico Executivo & Arquitetural do Ecossistema Atual

### 1.1. Pontos fortes consolidados no contexto apresentado

| Ativo | Valor estratégico | Evidência a preservar |
|---|---|---|
| Conway executando mais de 200 turnos | Base operacional para trabalho persistente e recuperação de tarefas | Logs, checkpoints, falhas, resultados e custo por turno |
| Acesso ao Base RPC | Capacidade de consultar contratos, pools e pagamentos | Rede consultada, bloco, latência e erros |
| Value API v0.9.0 | Produto central para monetização por requisição | Contrato HTTP, endpoints disponíveis, release e testes |
| x402-toolkit.js v1.0.0 | Redução do esforço de integração dos compradores | Exemplos reproduzíveis e matriz de compatibilidade |
| x402-conformance.js v1.0.0 | Distribuição técnica e verificação automatizada | Casos cobertos, versões testadas e limitações |
| Forja e Sentinela | Separação entre implementação e auditoria | Entregas vinculadas a commits e pareceres independentes |
| Maestri Canvas | Coordenação visual da colônia | Responsáveis, dependências, notas e confirmações de recebimento |

**Interpretação executiva:** o ecossistema dispõe, segundo o contexto fornecido, dos componentes para desenvolver, operar e distribuir um produto. O próximo marco deve comprovar utilidade paga e recorrente.

Mais de 200 turnos demonstram atividade operacional; disponibilidade, rentabilidade e autonomia segura precisam de métricas próprias.

### 1.2. Lacunas técnicas prioritárias

As três primeiras linhas representam os achados informados. As demais são verificações necessárias, sem afirmar que os defeitos estejam presentes.

| Prioridade | Lacuna ou verificação | Consequência | Decisão |
|---|---|---|---|
| P0 | Oráculo utiliza fórmula determinística sem leitura real de DEX | O resultado não representa preço observado no mercado | Retirar a alegação de preço real até integrar fonte verificável |
| P0 | Sentimento derivado de hash | O número não mede sentimento de uma população ou corpus | Classificar como sintético ou suspender a oferta comercial |
| P0 | Fluxo baseado em `txHash` em lugar do handshake x402 suportado | Pode impedir integração com compradores padronizados | Introduzir pagamento assinado e manter legado explicitamente separado |
| P0 — verificar | Reutilização de pagamento e concorrência | Uma transferência pode liberar múltiplos acessos indevidos | Persistência, idempotência e consumo atômico |
| P0 — verificar | Validação de ativo, rede, destinatário e valor | Aceitação de pagamento incompatível com a cobrança | Conferência integral dos requisitos |
| P1 — verificar | Dados sem bloco, horário ou origem | Comprador não consegue avaliar atualidade e procedência | Metadados obrigatórios |
| P1 — verificar | Custos desconhecidos por chamada e por turno | Crescimento pode consumir a reserva da operação | Medição antes de ampliar tráfego |
| P1 — verificar | Dependência de um único RPC ou facilitador | Interrupções podem bloquear dados ou receita | Timeouts, recuperação e estados de indisponibilidade |

**Precisão conceitual:** o problema do oráculo é a ausência de observações reais. Uma fórmula determinística pode transformar corretamente dados on-chain. Da mesma forma, `txHash` pode comprovar uma transferência quando devidamente validado, mas sua aceitação isolada não demonstra conformidade x402.

### 1.3. Arquitetura-alvo

```text
Agente comprador / aplicação / cliente MCP
                    │
             SDK ou cliente HTTP
                    │
                 Value API
       ┌────────────┼─────────────┐
       │            │             │
 Descoberta     Pagamentos      Dados
 e trial       x402 + legado    verificáveis
       │            │             │
 Catálogo      Verificação      Uniswap V3
 e schemas     e liquidação     via Base RPC
                    │             │
              Ledger local     Cache + procedência
                    │
            USDC na carteira soberana

Maestri: coordenação, decisões e evidências
Conway: execução persistente dentro das políticas
Sentinela: auditoria das entregas e da operação
```

Princípios obrigatórios:

- O gateway de pagamentos deve servir igualmente HTTP, SDK e MCP.
- A fonte sintética deve permanecer identificável e separada da fonte real.
- Estado financeiro deve sobreviver a reinícios.
- Chaves privadas devem permanecer fora de notas, logs, repositórios e respostas.
- A contagem de turnos deve acompanhar resultados úteis, falhas e consumo.

---

## 2. Estratégia de Tração e Monetização Imediata

### 2.1. Oferta inicial

**Produto comercial prioritário:** consulta de preço de um par validado na Base, com origem, bloco, horário e método de cálculo.

Começar com cobertura estreita permite demonstrar qualidade antes de ampliar ativos e fontes. A escolha do primeiro par dependerá da existência de pool com liquidez e histórico adequados.

| Produto | Papel inicial | Monetização proposta |
|---|---|---|
| Value API | Entrega de dados verificáveis | Cobrança por consulta ou lote explicitamente precificado |
| Toolkit | Integração do comprador e tratamento do pagamento | Distribuição gratuita inicial para gerar consumo da API |
| Conformance | Diagnóstico reproduzível de compatibilidade | CLI gratuita como aquisição; serviço hospedado somente após demanda |
| Sentimento | Funcionalidade em revisão | Sem cobrança como análise real enquanto depender de hash |

**Diferencial comercial:** o comprador recebe um dado com procedência e consegue integrá-lo sem construir o fluxo de pagamento.

### 2.2. Aquisição de agentes compradores

Os canais abaixo são **alvos de integração**. Disponibilidade, requisitos, custos e políticas devem ser verificados antes da publicação; este plano não pressupõe listagem ou parceria existente.

| Canal | Ação proposta | Critério de avanço |
|---|---|---|
| Bazaar / descoberta x402 | Preparar descrição, schemas, preço, rede e exemplo de resposta | Um cliente externo descobre o recurso e completa uma compra |
| ElizaOS | Criar uma integração mínima com ferramenta de consulta e orçamento | Um agente independente usa o endpoint em uma tarefa |
| Virtuals Protocol | Identificar uma necessidade concreta e validar o mecanismo de integração vigente | Piloto com consumo útil e recorrente |
| AgentMesh | Identificar primeiro o projeto específico e seu protocolo | Compatibilidade e caminho de distribuição comprovados |
| MCP | Publicar ferramentas com schemas claros e pagamento delegado ao comprador | Cliente MCP conclui uma chamada paga sem expor chaves ao servidor |

**Ordem sugerida:** descoberta x402 e exemplo de comprador → integração ElizaOS → MCP → expansão aos demais canais conforme evidência.

Não abrir cinco frentes simultaneamente. Cada canal deve produzir uma integração utilizável antes de consumir mais capacidade.

### 2.3. Distribuição para desenvolvedores

Preparar um percurso único:

**Repositório → exemplo executável → trial → primeira compra → uso recorrente.**

Entregáveis:

1. README com instalação, consulta gratuita e consulta paga.
2. Exemplos de erros: orçamento insuficiente, dado indisponível e liquidação pendente.
3. Documentação de redes, ativos e versões x402 efetivamente suportados.
4. Pacotes npm com nomes disponíveis, licença e origem verificadas.
5. CLI de conformance com relatório legível e saída JSON.
6. Página de limitações e status dos serviços.
7. Histórico de alterações e instruções de migração.

O toolkit deve privilegiar componentes oficiais do protocolo quando adequados. A contribuição própria deve concentrar-se na experiência de integração, observabilidade e diagnóstico.

### 2.4. Trial diário e proteção de margem

**Proposta inicial:** pequena cota diária configurável, com limite global adicional.

Regras:

- Informar cota restante e horário de renovação.
- Permitir conhecer a qualidade real do dado.
- Exigir aceitação explícita do pagamento após a cota.
- Aplicar limites de frequência e concorrência.
- Evitar tratar endereço de carteira como identidade única resistente a abuso.
- Suspender expansão do trial quando atingir o orçamento global.
- Usar cache de modo transparente, informando a idade do dado.

A quantidade gratuita e o preço pago serão definidos após medir RPC, processamento, armazenamento e liquidação.

### 2.5. Métricas e primeiro marco comercial

Medir:

- compradores externos com pagamento liquidado;
- conversão do trial para compra;
- recompra em sete dias;
- receita recebida em USDC;
- custo variável e margem por endpoint;
- taxa de liquidação;
- latência e idade dos dados;
- canal de origem.

**Meta inicial proposta:** três compradores externos independentes, com pelo menos um retornando para uma segunda compra. Transações da própria colônia serão contabilizadas como testes.

---

## 3. Roadmap de Evolução Técnica dos 3 Produtos

Os horizontes abaixo são estimativas de organização, condicionadas ao acesso e aos critérios de aceite.

### Fase 1 — Imediata: integridade e pagamentos

**Horizonte sugerido: primeiros 1–3 dias de trabalho efetivo.**

#### Value API: leitura real de Uniswap V3 na Base

1. Confirmar rede, factory, tokens, decimais e pool.
2. Validar origem do pool e liquidez suficiente.
3. Consultar estado em um bloco definido.
4. Calcular preço respeitando a ordem dos tokens e a precisão inteira.
5. Separar preço instantâneo de preço médio temporal.
6. Validar disponibilidade de histórico antes de oferecer uma janela temporal.
7. Aplicar limites de idade, divergência e liquidez.
8. Retornar indisponibilidade quando não houver evidência suficiente.
9. Adicionar Aerodrome posteriormente com adaptador próprio e ABI confirmada.

Pools Uniswap V3 expõem informações de preço e de oráculo; a seleção envolve par e taxa do pool. Isso sustenta o uso de pools como fonte, mas exige validação da integração específica. [Arquitetura oficial Uniswap V3](https://developers.uniswap.org/docs/protocols/v3/concepts/architecture).

**Contrato proposto de resposta:**

```text
chainId
baseToken
quoteToken
price
priceUnit
source
poolAddress
blockNumber
blockHash
observedAt
fetchedAt
method
windowSeconds
qualityStatus
```

**Aceite:** resultado reproduzível no mesmo bloco, teste de inversão do par, decimais distintos, histórico insuficiente, falha RPC e dado vencido. Nenhum retorno sintético silencioso.

#### Value API e toolkit: suporte híbrido a pagamentos

Manter dois adaptadores identificáveis:

- **Padrão:** `Payment-Signature`, conforme versão e esquema x402 selecionados.
- **Legado:** transferência comprovada por `txHash`, documentada como compatibilidade própria.

O fluxo oficial distingue autorização, verificação e liquidação. Uma autorização verificada não equivale a receita recebida. [Fluxo oficial x402](https://docs.cdp.coinbase.com/x402/how-it-works).

Implementar:

1. Fixação da versão e do esquema suportados.
2. Requisitos de pagamento com preço, ativo, rede, destinatário e validade.
3. Validação do domínio EIP-712 e da autorização exigida pelo esquema.
4. Proteção contra repetição, dupla liquidação e downgrade para o legado.
5. Persistência da relação entre pagamento, cobrança e acesso.
6. Recuperação de timeout com consulta do estado antes de tentar novamente.
7. Entrega recuperável quando o pagamento foi concluído e a resposta falhou.
8. Reconciliação com evidência de liquidação.

EIP-712 fornece assinatura de dados estruturados; a autorização de transferência depende do mecanismo adotado pelo esquema. Não basta validar uma assinatura genérica.

#### Conformance: ampliar a matriz

Cobrir:

- desafio de pagamento e schemas;
- assinatura inválida ou expirada;
- domínio, rede, ativo ou destinatário incorretos;
- valor insuficiente;
- pagamento reutilizado;
- duas requisições concorrentes;
- timeout e reinício;
- migração entre clientes legados e padronizados.

**Gate da fase:** teste com cliente independente da implementação local. Aprovação da própria suíte será evidência complementar.

#### Sentimento

Desativar sua apresentação como sinal real. Para reintroduzi-lo, exigir fonte permitida, período, tamanho da amostra, método, versão e avaliação de qualidade. Ausência de amostra deve gerar estado explícito.

### Fase 2 — Curto prazo: empacotamento e distribuição

**Horizonte sugerido: dias 4–14, após aprovação da Fase 1.**

| Produto | Entrega |
|---|---|
| Value API | Documentação pública, catálogo, trial controlado e métricas por endpoint |
| Toolkit | Pacote npm, exemplos, tipos, compatibilidade e migração |
| Conformance | CLI reproduzível, saída JSON, execução em CI e limites de cobertura |
| MCP oficial | Ferramentas de catálogo, consulta e qualidade usando o mesmo backend |

**Gate de publicação dos pacotes:**

- licença e titularidade conferidas;
- nome disponível;
- instalação limpa funcionando;
- pacote sem segredos ou arquivos internos;
- versão coerente com alterações incompatíveis;
- testes executados sobre o artefato que será publicado;
- instruções de reversão e migração prontas.

As versões já citadas não devem ser sobrescritas: mudanças publicadas exigem nova versão.

**MCP:** começar com catálogo e consulta de preço. Manter assinatura e orçamento no cliente ou em componente autorizado pelo comprador. O servidor não deve receber seed phrase ou chave privada.

**Aceite:** instalação limpa, descoberta de ferramentas e chamada paga validada em cliente externo. Presença em npm ou GitHub deve ser comprovada por URL e versão consultáveis.

### Fase 3 — Médio prazo: identidade e autonomia

**Horizonte sugerido: semanas 3–6, condicionado a estabilidade e demanda.**

#### Registro ERC-8004 na Base

A página oficial consultada identifica o ERC-8004 como **Draft** e descreve registros de identidade, reputação e validação. Pagamentos estão fora de seu escopo; registro não comprova qualidade nem substitui governança. [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004).

Passos:

1. Fixar a revisão da especificação.
2. Confirmar deployment legítimo na Base, código e ABI.
3. Preparar metadados com endpoints reais.
4. Definir proprietário e operadores com permissões mínimas.
5. Confirmar vínculo com a carteira de recebimento.
6. Simular o registro e obter cobertura de gas.
7. Registrar somente com custo coberto e autorização operacional aplicável.
8. Arquivar transação, `agentId`, registro e URI.
9. Construir reputação com resultados externos verificáveis.

#### Autonomia da colônia

Aumentar permissões gradualmente:

| Nível | Autonomia |
|---|---|
| A0 | Observar, planejar e produzir evidências |
| A1 | Implementar e testar em ambiente isolado |
| A2 | Publicar alterações aprovadas dentro de escopo e orçamento predefinidos |
| A3 | Reagir a incidentes com ações reversíveis previstas |
| A4 | Reinvestir receita somente sob política explícita de tesouraria |

Cada avanço exige histórico estável, auditoria, reversão e orçamento disponível. Nenhum agente pode ampliar sua própria autoridade.

---

## 4. Governança e Orquestração da Colônia no Maestri Canvas

### 4.1. Atribuições exatas

| Agente | Responsabilidade | Entrega obrigatória | Limite |
|---|---|---|---|
| **Antigravity — Maestro** | Priorizar, distribuir, resolver dependências e conduzir releases | Fila ordenada, responsável e decisão registrada | Não dispensar auditoria nem ampliar orçamento |
| **Automaton — Runtime Conway** | Executar a fila, persistir estado, acompanhar saúde e recuperar tarefas | Checkpoint, resultado, erros e consumo | Não alterar política ou carteira de destino |
| **Forja — Implementador** | Desenvolver código, testes, pacotes e documentação | Commit, validação e instrução de reversão | Não aprovar a própria entrega |
| **Sentinela — Auditor** | Revisar dados, pagamento, testes e operação | Veredito com evidências e bloqueios objetivos | Não certificar além do escopo testado |
| **Astra — Estrategista** | Definir direção, critérios de avanço e experimentos comerciais | Roadmap, decisões arquiteturais e avaliação de resultados | Não tratar hipóteses como métricas observadas |

### 4.2. Notas e “ropas” do Canvas

Interpretando “ropas” como as conexões ou *ropes* entre elementos, propor:

```text
Astra → Antigravity → Forja → Sentinela → Antigravity
                          ↑                  │
                          └── correções ─────┘

Antigravity → Automaton → evidências operacionais
Evidências operacionais → Sentinela e Astra
```

A conexão visual expressa responsabilidade e dependência. A entrega de mensagens deve ter confirmação própria; não presumir que uma conexão garante sincronização.

Notas compartilhadas:

| Nota | Conteúdo |
|---|---|
| `MISSAO_E_LIMITES` | Objetivo, carteira, orçamento e permissões |
| `ESTADO_ATUAL` | Versões, commits, serviços e bloqueios |
| `FILA_EXECUCAO` | Tarefas, responsáveis e dependências |
| `DECISOES` | Decisão, motivo, autor e evidência |
| `AUDITORIA` | Testes, pareceres e correções |
| `TESOURARIA` | Recebimentos, custos e divergências, sem segredos |
| `TRACAO` | Compradores, conversão e experimentos |

### 4.3. Protocolo contínuo

Cada tarefa deve conter:

```text
task_id
objetivo
responsavel
escopo_de_arquivos
dependencias
criterios_de_aceite
orcamento_maximo
estado
commit_ou_artefato
evidencias
proxima_acao
updated_at_utc
```

Estados:

**PRONTA → EM EXECUÇÃO → EM AUDITORIA → APROVADA → PUBLICADA → VERIFICADA**

`BLOQUEADA` deve registrar causa, dependência e condição de retomada.

Regras:

- Um responsável por tarefa e um escritor por área de código.
- Confirmação de recebimento antes de considerar uma delegação ativa.
- Atualização em cada transição e checkpoint periódico configurável.
- Parecer ligado ao commit exato.
- Alteração posterior relevante invalida a aprovação anterior.
- Limite de tentativas para impedir ciclos improdutivos.
- Falha em uma dependência desloca o runtime para outra tarefa pronta.
- Conclusão exige evidência do resultado esperado.

---

## 5. Plano de Ação Imediato Passo a Passo

### 5.1. Próximos ciclos de execução

“Sem parar” deve significar avançar continuamente sobre trabalho autorizado e executável, respeitando dependências e limites de recursos.

| Ordem | Responsável | Ação | Evidência de conclusão |
|---|---|---|---|
| 1 | Antigravity | Restaurar acesso operacional e identificar checkouts, branches e alterações pendentes | Inventário e commits de referência |
| 2 | Sentinela | Confirmar releases, processos, endpoints, turnos e estado das integrações | Relatório factual |
| 3 | Astra + Antigravity | Registrar missão, prioridades, orçamento e critérios deste plano | Notas versionadas |
| 4 | Forja | Identificar e separar respostas sintéticas | Contrato e testes atualizados |
| 5 | Forja | Implementar leitura de um pool real | Resposta reproduzível por bloco |
| 6 | Sentinela | Auditar cálculo, procedência, histórico e falhas | Parecer sobre o commit |
| 7 | Forja | Implementar pagamento assinado e legado isolado | Fluxos e persistência testados |
| 8 | Sentinela | Testar replay, concorrência, timeout e recuperação | Relatório de conformance |
| 9 | Automaton | Executar validação integrada sem gasto não coberto | Logs e reconciliação |
| 10 | Forja | Preparar pacotes e exemplos instaláveis | Artefatos reproduzíveis |
| 11 | Antigravity | Conduzir release dentro das permissões existentes | Versões e URLs verificadas |
| 12 | Forja | Preparar catálogo de descoberta e primeira integração compradora | Demonstração externa |
| 13 | Astra | Avaliar conversão, recompra e margem | Decisão do próximo experimento |
| 14 | Colônia | Ampliar MCP, canais e identidade conforme gates | Evidências específicas por entrega |

Documentação, exemplos e catálogo podem avançar enquanto a implementação está em auditoria. Ampliação comercial depende da integridade do endpoint e do pagamento.

### 5.2. Política de custo zero para o usuário

**Compromisso operacional proposto: nenhum aporte, contratação ou cobrança nova ao usuário.**

Isso exige controles verificáveis:

- orçamento de aporte do usuário igual a zero;
- nenhuma assinatura ou ampliação automática de plano;
- uso limitado à capacidade já disponível;
- limites rígidos de RPC, processamento e armazenamento;
- gas coberto por patrocinador ou fonte previamente autorizada;
- reinvestimento de receita apenas sob política explícita;
- interrupção da ação onerosa quando não houver cobertura.

**Não é possível garantir operação economicamente gratuita e ininterrupta.** Gas, computação e serviços podem ter custos. Se a cobertura terminar, a garantia de não cobrar o usuário exige suspender essas ações e continuar apenas o trabalho sem despesa incremental.

Receita recebida também não constitui autorização automática para gastá-la.

### 5.3. Liquidação soberana em USDC na Base

**Carteira destinatária fornecida:**

```text
0x71DEAc098914A009E3720524642A6bE6F65EE528
```

Política proposta:

| Parâmetro | Regra |
|---|---|
| Rede de recebimento | Base mainnet |
| Ativo aceito | USDC nativo, com contrato confirmado antes da configuração |
| Destinatário | Carteira acima |
| Roteamento | Recebimento direto, quando suportado |
| Outros ativos ou redes | Não anunciados nem aceitos pelo produto |
| Reconhecimento de receita | Somente após evidência de liquidação |
| Alteração de destino | Fora da autonomia dos agentes |
| Reconciliação | Cobrança, pagamento, evento, valor e entrega associados |

Antes da ativação:

1. Validar o endereço e comprovar seu controle, sem solicitar exposição de chave privada.
2. Confirmar contrato do USDC, rede e configuração do facilitador.
3. Conferir destinatário e valor nos requisitos e na liquidação.
4. Separar taxas do preço e informar qualquer dedução.
5. Impedir consumo duplicado do mesmo pagamento.
6. Produzir relatório reconciliado de recebimentos.

Não aceitar outro ativo para convertê-lo depois: isso acrescentaria gas, taxas e risco à política solicitada. A garantia realizável é **aceitar apenas pagamentos compatíveis com USDC/Base e verificar cada liquidação na carteira definida**. Nenhum recebimento foi comprovado nesta sessão.

### 5.4. Critérios para encerrar o primeiro ciclo

O primeiro ciclo estará concluído quando:

- o endpoint comercial retornar dados reais com procedência;
- resultados sintéticos estiverem explicitamente separados;
- um cliente independente completar o fluxo x402;
- repetição, concorrência e recuperação estiverem testadas;
- pagamentos e entregas forem reconciliáveis;
- toolkit e conformance forem instaláveis e reproduzíveis;
- houver um caminho funcional de descoberta;
- a operação respeitar o limite de nenhum aporte do usuário.

**Primeira decisão executiva:** concentrar Forja e Sentinela na integridade do oráculo e no pagamento interoperável. Antigravity organiza a fila; Automaton sustenta a execução; Astra prepara a aquisição e mede os resultados. MCP e ERC-8004 avançam sobre essa base validada.