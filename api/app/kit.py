"""O kit: as peças que o agente pode usar e as regras da grade. É o que o get_kit devolve."""
from .catalog import PERIODS
from .spec import KIT_VERSION

EXAMPLE_SPEC = {
    "schemaVersion": 1,
    "kitVersion": KIT_VERSION,
    "title": "Vendas por canal",
    "subtitle": "Receita, pedidos e ticket nos estados escolhidos",
    "params": {
        "state": {"type": "state", "default": ["sp", "rj", "mg"], "label": "Estados"},
        "period": {"type": "period", "default": "last_30_days", "label": "Período"},
    },
    "rows": [
        {"blocks": [
            {"id": "receita", "kind": "kpi", "span": 4, "title": "Receita",
             "query": {"metric": "revenue", "filters": {"state": "$state"}, "period": "$period"}},
            {"id": "pedidos", "kind": "kpi", "span": 4, "title": "Pedidos",
             "query": {"metric": "orders", "filters": {"state": "$state"}, "period": "$period"}},
            {"id": "ticket", "kind": "kpi", "span": 4, "title": "Ticket médio",
             "query": {"metric": "avg_ticket", "filters": {"state": "$state"}, "period": "$period"}},
        ]},
        {"blocks": [
            {"id": "receita-canal", "kind": "ranking_bar", "span": 6, "title": "Receita por canal",
             "query": {"metric": "revenue", "dimensions": ["channel"],
                       "filters": {"state": "$state"}, "period": "$period", "sort": "desc"}},
            {"id": "evolucao", "kind": "line", "span": 6, "title": "Receita por dia e canal",
             "query": {"metric": "revenue", "dimensions": ["day", "channel"],
                       "filters": {"state": "$state"}, "period": "$period"}},
        ]},
    ],
}

KIT = {
    "kitVersion": KIT_VERSION,
    "schemaVersion": 1,
    "blocks": [
        {"kind": "kpi", "use": "Um número em destaque.", "dimensions": "nenhuma",
         "spans": "3 ou 4", "data": "{value}"},
        {"kind": "kpi_progress",
         "use": "Número com barra de progresso ('X de Y'). Use 'of' com uma métrica de contagem como total, "
                "ou uma métrica em % sem 'of' (a barra vai até 100%).",
         "dimensions": "nenhuma", "spans": "3 ou 4", "data": "{value, total}"},
        {"kind": "ranking_bar", "use": "Barras horizontais ordenadas: ranking, 'os piores', 'os maiores'. "
                                       "Use sort e limit (padrão 10).",
         "dimensions": "exatamente 1, que não seja day", "spans": "6 a 12", "data": "[{label, value}]"},
        {"kind": "bar", "use": "Barras verticais para comparar poucas categorias. A 2ª dimensão vira série (barras agrupadas).",
         "dimensions": "1 ou 2, sem day", "spans": "4 a 12", "data": "[{label, series?, value}]"},
        {"kind": "line", "use": "Evolução no tempo. A 2ª dimensão vira séries (mantenha até 6 séries; filtre se houver mais).",
         "dimensions": "day + no máximo 1", "spans": "6 a 12", "data": "[{x, series?, value}]"},
        {"kind": "table", "use": "Lista detalhada. 'columns' traz até 3 métricas extras com as mesmas dimensões. "
                                 "limit padrão 50.",
         "dimensions": "1 a 3", "spans": "6 a 12", "data": "{columns, rows}"},
        {"kind": "heatmap", "use": "Mapa de calor: cruza duas dimensões (ex.: estado × canal) e pinta cada célula pelo "
                                   "valor. Bom para achar onde algo concentra. Use tone diverging para valores com sinal.",
         "dimensions": "exatamente 2, sem day (1ª = linhas, 2ª = colunas)", "spans": "8 a 12",
         "data": "[{label, series, value}]"},
    ],
    "grid": {
        "columns": 12,
        "rules": [
            "rows é uma lista de linhas; cada linha tem de 1 a 4 blocos",
            "a soma dos span de uma linha é exatamente 12",
            "no máximo 20 blocos e 10 linhas",
            "KPIs costumam vir juntos na primeira linha",
        ],
    },
    "block_fields": {
        "id": "minúsculas, números e hífen, único na spec (ex.: 'receita-canal')",
        "kind": "um dos 7 blocos",
        "span": "1 a 12",
        "title": "até 60 caracteres; diga o que o bloco mede, não o número",
        "subtitle": "opcional, até 100 caracteres",
        "tone": "opcional: positive, negative, neutral, diverging (valores com sinal) ou accent. Não existe cor livre.",
        "query": {
            "metric": "id de uma métrica do get_catalog",
            "dimensions": "lista de dimensões aceitas pela métrica",
            "filters": "{dimensão: id | [ids] | '$param'} e, em ranking_bar/bar/table, value: {gt|gte|lt|lte: n}",
            "period": f"'$param' do tipo period ou um de: {', '.join(PERIODS)}. Omitido = last_30_days. Nunca datas.",
            "sort": "desc ou asc (ranking_bar, bar, table)",
            "limit": "1 a 500",
            "of": "só kpi_progress: métrica de contagem que é o total",
            "columns": "só table: até 3 métricas extras",
        },
    },
    "params": {
        "what": "Filtros que quem abre o dashboard pode trocar. Declare aqui e use como '$nome' nos blocos.",
        "types": ["product", "category", "channel", "state", "segment", "period"],
        "shape": "{nome: {type, default, label?}}; default é um id ou uma lista de ids (period: um id de período)",
    },
    "spec_fields": "schemaVersion: 1, kitVersion: 'mvp-1', title (até 80), subtitle? (até 120), params, rows. "
                   "Nenhum outro campo é aceito.",
    "example": EXAMPLE_SPEC,
}
