# Arquitetura

A ideia central: **a IA escreve uma especificação, não código nem consulta.** Ela escolhe peças de um kit
fechado e métricas de um catálogo. Quem transforma isso em SQL, valida e desenha é código determinístico.

## As três camadas

```
┌──────────┐   pedido / turno    ┌───────────────────┐   claude -p + MCP   ┌────────┐
│ navegador│ ──────────────────► │ dash-ai (agent/)  │ ──────────────────► │ Claude │
│  (web/)  │ ◄── SSE: progresso  │ monta o contexto, │ ◄── chamadas de     └────────┘
└────┬─────┘                     │ roda e grava      │     ferramenta
     │                           └─────────┬─────────┘          │
     │ blockId + params                    │ sessão (HTTP)      │ ferramentas MCP (HTTP)
     ▼                                     ▼                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ api (FastAPI): catálogo com SQL, kit, validação, rascunhos, sessão,  │
│ dado de cada bloco                                                   │──► postgres
└──────────────────────────────────────────────────────────────────────┘
```

| Camada | Sabe | Não sabe |
|---|---|---|
| **api** | o SQL de cada métrica, o banco, as regras do kit, quem é o cliente | nada de modelo de linguagem |
| **dash-ai** (`agent/server.mjs`) | como montar o contexto de cada turno, como chamar o modelo, a conversa (lida da api) | SQL, banco, senha |
| **modelo** | o catálogo público (ids, descrições, dimensões), o kit, o rascunho atual | SQL, tabelas, outros clientes, qual tenant é |

A **dash-ai** é a camada do meio: fica entre a API do modelo e a API do sistema que tem o catálogo. É ela
que decide o que o modelo vê a cada turno, quais ferramentas ele tem e o que fica gravado.

## A spec

```json
{
  "schemaVersion": 1, "kitVersion": "mvp-1",
  "title": "Vendas por canal",
  "params": { "state": { "type": "state", "default": ["sp", "rj", "mg"], "label": "Estados" } },
  "rows": [
    { "blocks": [
      { "id": "receita-canal", "kind": "ranking_bar", "span": 6, "title": "Receita por canal",
        "query": { "metric": "revenue", "dimensions": ["channel"], "filters": { "state": "$state" }, "sort": "desc" } },
      { "id": "evolucao", "kind": "line", "span": 6, "title": "Receita por dia",
        "query": { "metric": "revenue", "dimensions": ["day"], "filters": { "state": "$state" } } }
    ] }
  ]
}
```

- **Kit:** 7 peças (`kpi`, `kpi_progress`, `ranking_bar`, `bar`, `line`, `table`, `heatmap`) numa grade de 12
  colunas.
- **Query:** só escolhe métrica, dimensões, filtros, período, ordem e limite. Não existe campo de SQL, cor
  livre, HTML ou URL. O schema recusa qualquer chave desconhecida.
- **Params:** são os filtros que quem abre o dashboard pode trocar.

## As portas da validação

Toda spec, do agente ou de uma edição manual, passa pelas mesmas portas (`api/app/validate.py`):

1. **Formato:** o schema Pydantic com `extra="forbid"`.
2. **Sentido:** a métrica existe e é do módulo do cliente; a dimensão é aceita pela métrica e pela peça; cada
   linha soma 12; os ids de filtro existem; o período é relativo.
3. **Edição** (só quando já há rascunho):
   - com um bloco selecionado, os outros blocos ficam idênticos e na mesma ordem (só o `span` pode mudar, para
     a linha fechar 12);
   - sem bloco selecionado, um bloco que sumiu vira aviso.
4. **Dry-run:** roda cada bloco com dado real; bloco vazio ou com erro volta como erro.

Cada erro sai como `{blockId, path, message, hint}`, em português, para o agente corrigir sozinho. Nos evals,
a maioria das specs passa de primeira, e o resto em uma ou duas correções.

## Studio: a memória é nossa, não do modelo

Cada turno é um `claude -p` novo. Quem lembra é o banco (`dashboards.studio_session` e `studio_message`),
lido e gravado pela dash-ai via API. A função `buildTurn()` em `agent/server.mjs` monta a mensagem de cada
turno com:

1. o rascunho atual (a spec JSON salva), que é a fonte da verdade;
2. as edições feitas à mão desde a última resposta do agente ("mudou a largura de X para 6");
3. as últimas 24 mensagens da conversa;
4. o bloco selecionado, se houver;
5. o pedido novo ou as respostas às perguntas.

Por que não usar a memória de sessão do próprio modelo:
- a spec muda por fora (edição manual), e o modelo precisa ver a versão atual, não a que ele lembra;
- a conversa sobrevive a troca de modelo, reinício do container e troca de provedor;
- dá para auditar exatamente o que o modelo recebeu: o log em `runs/` guarda a mensagem montada.

Regras da sessão:
- um turno por vez: a sessão tem lock, e um segundo turno recebe 409; um lock velho expira em 7 minutos;
- `save_draft` sempre grava no rascunho da sessão: o modelo não escolhe o id;
- `propose_options` grava perguntas com opções na sessão, e a resposta chega no turno seguinte.

## Do protótipo para produção

| Hoje | Num deploy de verdade |
|---|---|
| `claude -p` com o token da assinatura | API do Claude com uso de ferramentas (tool use) e chave de API; o laço de ferramentas fica na dash-ai |
| servidor MCP por stdio | as mesmas ferramentas, chamadas direto pela dash-ai |
| tenant no header `X-Tenant` | tenant da sessão autenticada, repassado pela dash-ai |
| kit e catálogo lidos por ferramenta a cada turno | kit e catálogo no contexto da sessão, com prompt caching |
| sem versões | histórico de versões da spec, com desfazer |

A sessão, o `buildTurn`, as ferramentas, a spec e as portas continuam iguais: só o motor do turno muda.
