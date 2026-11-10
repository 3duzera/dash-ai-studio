# Métricas, dados e pedidos de teste

## Os dados

Duas lojas online fictícias, 90 dias de pedidos até ontem, gerados por `db/seed.py` (sempre os mesmos com a
mesma seed).

| Cliente | Ramo | Módulos | Itens de pedido |
|---|---|---|---|
| `aurora` · Aurora Casa | Casa e cozinha | Vendas, Clientes, Operação | ≈ 67 mil |
| `brisa` · Brisa Beleza | Beleza e cuidados | Vendas, Clientes (sem Operação) | ≈ 48 mil |

A Brisa não tem o módulo Operação de propósito: serve para testar que o catálogo muda por cliente.

Cada linha de `warehouse.order_line` é um item de pedido, com dia, pedido, cliente, produto, canal, estado,
segmento, quantidade, preço, desconto, status (`delivered`, `returned`, `canceled`), atraso e se foi a
primeira compra do cliente.

### Histórias plantadas

Os testes em `api/tests/test_dados.py` conferem cada uma:

| O que | Onde aparece |
|---|---|
| Rio Grande do Sul atrasa muito mais (≈30% contra 5–12%) | `late_delivery_rate` por `state` |
| Marketplace cancela mais, dá mais desconto e tem a menor margem | `cancel_rate`, `avg_discount`, `gross_margin` por `channel` |
| O clube de assinantes recompra muito mais, sobretudo pelo App | `repeat_rate` por `segment` |
| Uma categoria devolve ≈4× mais (Cama e banho; na Brisa, Maquiagem) | `return_rate` por `category` |
| Semana de promoção por volta do dia 45 (Eletroportáteis; na Brisa, Perfumaria) | `revenue` e `avg_discount` por `day` |
| Uma categoria despenca na última semana (Climatização; na Brisa, Proteção solar) | `revenue_change_7d` por `category` |
| 2 dias sem carga | buracos nos gráficos de linha |
| Crescimento leve em 90 dias e fim de semana mais forte | `revenue` ou `orders` por `day` |

## Dimensões e períodos

| Dimensão | O que é |
|---|---|
| `product` | Produto (30 por cliente) |
| `category` | Categoria do produto (5 por cliente) |
| `channel` | Site, App, Marketplace, Loja física, Redes sociais |
| `state` | SP, RJ, MG, PR, BA, RS |
| `segment` | Pessoa física, Empresas, Clube de assinantes |
| `day` | Dia do pedido (só em `line`) |

Os períodos são sempre relativos ao último dia carregado: `latest_day`, `last_7_days`, `last_30_days` (padrão)
e `last_90_days`. Não existem datas fixas.

## O catálogo (17 métricas)

O SQL fica em `api/app/catalog.py` e nunca sai da API. O agente vê id, rótulo, descrição, unidade e dimensões.

| Módulo | Métrica | Unidade | Observação |
|---|---|---|---|
| Vendas | `revenue` | R$ | quantidade × preço, com desconto, sem cancelados |
| Vendas | `orders` | contagem | pedidos não cancelados |
| Vendas | `avg_ticket` | R$ | receita ÷ pedidos (sem a dimensão produto) |
| Vendas | `units_sold` | contagem | |
| Vendas | `avg_discount` | % | |
| Vendas | `gross_margin` | % | (receita − custo) ÷ receita |
| Vendas | `revenue_change_7d` | % com sinal | últimos 7 dias contra os 7 anteriores; período fixo |
| Vendas | `products_sold` | contagem | produtos diferentes com venda |
| Clientes | `customers` | contagem | clientes ativos |
| Clientes | `new_customers` | contagem | primeira compra no recorte; `kpi_progress` com `of: customers` |
| Clientes | `repeat_rate` | % | clientes com 2+ pedidos no período (sem `day`) |
| Clientes | `revenue_per_customer` | R$ | |
| Operação | `orders_delivered` | contagem | total para `orders_on_time` |
| Operação | `orders_on_time` | contagem | `kpi_progress` com `of: orders_delivered` |
| Operação | `late_delivery_rate` | % | |
| Operação | `return_rate` | % | unidades devolvidas ÷ vendidas |
| Operação | `cancel_rate` | % | |

Para acrescentar uma métrica: escreva o `Metric` em `catalog.py` (um SELECT sobre a CTE `base`), diga quais
dimensões ela aceita e escreva uma descrição que ajude o agente a escolher. O resto (validação, kit, página)
não muda.

## Pedidos de teste

`evals/pedidos.json` tem 21 pedidos contra o cliente `aurora`, cada um com o mínimo que a spec precisa ter.

| Grupo | Quantos | Exemplos |
|---|---|---|
| fácil | 6 | "Em que estados as entregas mais atrasam", "Taxa de cancelamento por canal" |
| composto | 5 | "Painel de entregas: no prazo, atraso, piores estados e evolução diária" |
| edição | 4 | "Troca por um gráfico de linha", "Tira o RJ" (em cima de um pedido anterior) |
| armadilha | 6 | métrica que não existe, mapa 3D, data fixa, pedir o SQL, dado de outro cliente, pedido vago |

`evals/studio.mjs` roda 3 cenários de sessão do Studio:
- **pedido aberto:** pergunta com opções e, depois das respostas, monta;
- **mão + agente:** mudar larguras à mão e depois pedir um bloco novo; as larguras ficam;
- **bloco selecionado:** "troca esse por uma tabela" muda só aquele bloco.
