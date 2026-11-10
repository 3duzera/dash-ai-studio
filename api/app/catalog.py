"""Catálogo de métricas: a única linguagem entre a IA e o dado.

O SQL mora aqui e nunca sai da API. O agente vê só id, rótulo, descrição, unidade e dimensões
(`public_catalog`). As métricas e as histórias plantadas nos dados estão em docs/METRICAS.md.

Cada métrica é um SELECT sobre a CTE `base` (uma linha por item de pedido, já filtrada por tenant, período e
filtros). Marcadores que o query.py substitui:
  __SEL__      colunas das dimensões pedidas, com vírgula no fim   (ex.: state_id as "state", ...)
  __GROUP__    "group by ..." das dimensões, ou vazio
  __GCOLS_C__  ", col, col" das dimensões, para CTEs internas, ou vazio
"""
from dataclasses import dataclass

MODULES = {
    "sales": "Vendas",
    "customers": "Clientes",
    "operations": "Operação",
}


@dataclass(frozen=True)
class Dimension:
    id: str
    label: str
    id_col: str        # coluna na CTE base
    label_col: str
    src_col: str       # coluna na tabela de origem (para o filtro dentro da base)
    description: str


DIMENSIONS: dict[str, Dimension] = {d.id: d for d in [
    Dimension("product", "Produto", "product_id", "product_name", "o.product_id", "Produto vendido"),
    Dimension("category", "Categoria", "category", "category_name", "p.category", "Categoria do produto"),
    Dimension("channel", "Canal", "channel_id", "channel_name", "o.channel_id",
              "Canal de venda: site, app, marketplace, loja física ou redes sociais"),
    Dimension("state", "Estado", "state_id", "state_name", "o.state_id", "Estado de entrega do pedido"),
    Dimension("segment", "Segmento", "segment_id", "segment_name", "o.segment_id",
              "Segmento do cliente: pessoa física, empresas ou clube de assinantes"),
    Dimension("day", "Dia", "day", "day", "o.day",
              "Dia do pedido. Use para evolução no tempo (bloco line)"),
]}

PERIODS: dict[str, tuple[int, str]] = {
    "latest_day": (1, "Último dia"),
    "last_7_days": (7, "Últimos 7 dias"),
    "last_30_days": (30, "Últimos 30 dias"),
    "last_90_days": (90, "Últimos 90 dias"),
}
DEFAULT_PERIOD = "last_30_days"

ALL = ("product", "category", "channel", "state", "segment", "day")
NOT_CANCELED = "status <> 'canceled'"
DELIVERED = "status in ('delivered', 'returned')"


@dataclass(frozen=True)
class Metric:
    id: str
    label: str
    module: str
    unit: str                  # percent (fração: 0.12 = 12%), currency (R$), count
    description: str           # o texto que a IA lê para escolher
    dimensions: tuple[str, ...]
    select: str                # SELECT final (vira a CTE `result`)
    ctes: str = ""             # CTEs extras, começando com ", nome as (...)"
    fixed_period: str | None = None   # a métrica ignora o period da spec
    signed: bool = False              # pode ser negativa (mostra "+" nos positivos)
    question: str = ""


def _simple(expr: str, where: str | None = None) -> str:
    w = f" where {where}" if where else ""
    return f"select __SEL__ {expr} as value from base{w} __GROUP__"


METRICS: dict[str, Metric] = {m.id: m for m in [
    # ── Vendas ───────────────────────────────────────────────────────────────
    Metric(
        id="revenue", label="Receita", module="sales", unit="currency",
        description=("Receita em R$ (quantidade × preço, já com desconto) dos pedidos não cancelados. Use para "
                     "'quanto vendemos', 'faturamento' ou 'vendas em R$'."),
        dimensions=ALL,
        select=_simple("sum(revenue)", NOT_CANCELED),
        question="Quanto vendemos por canal neste mês?",
    ),
    Metric(
        id="orders", label="Pedidos", module="sales", unit="count",
        description="Quantidade de pedidos não cancelados. Use para volume de vendas em número de pedidos.",
        dimensions=ALL,
        select=_simple("count(distinct order_id)", NOT_CANCELED),
        question="Quantos pedidos tivemos por dia?",
    ),
    Metric(
        id="avg_ticket", label="Ticket médio", module="sales", unit="currency",
        description="Valor médio de um pedido, em R$ (receita ÷ pedidos). Use para 'ticket médio' ou 'valor por pedido'.",
        dimensions=("category", "channel", "state", "segment", "day"),
        select=_simple("sum(revenue) / nullif(count(distinct order_id), 0)", NOT_CANCELED),
        question="Qual canal tem o maior ticket médio?",
    ),
    Metric(
        id="units_sold", label="Unidades vendidas", module="sales", unit="count",
        description="Soma das unidades vendidas nos pedidos não cancelados.",
        dimensions=ALL,
        select=_simple("sum(qty)", NOT_CANCELED),
        question="Quais produtos mais vendem em unidades?",
    ),
    Metric(
        id="avg_discount", label="Desconto médio", module="sales", unit="percent",
        description="Desconto médio dado nos itens vendidos, em %. Use para 'quanto estamos dando de desconto'.",
        dimensions=ALL,
        select=_simple("avg(discount)", NOT_CANCELED),
        question="Em que canal damos mais desconto?",
    ),
    Metric(
        id="gross_margin", label="Margem bruta", module="sales", unit="percent",
        description="Margem bruta em %: (receita − custo dos produtos) ÷ receita. Quanto maior, melhor.",
        dimensions=ALL,
        select=_simple("sum(revenue - cost) / nullif(sum(revenue), 0)", NOT_CANCELED),
        question="Qual categoria tem a melhor margem?",
    ),
    Metric(
        id="revenue_change_7d", label="Variação da receita em 7 dias", module="sales", unit="percent",
        description=("Variação, em %, da receita dos últimos 7 dias contra os 7 dias anteriores. Ignora o período: "
                     "sempre compara as duas últimas semanas. NÃO aceita o campo period."),
        dimensions=("product", "category", "channel", "state", "segment"),
        fixed_period="last_14_days", signed=True,
        select=_simple("sum(revenue) filter (where day > %(mid)s) / "
                       "nullif(sum(revenue) filter (where day <= %(mid)s), 0) - 1", NOT_CANCELED),
        question="Quais categorias mais caíram nesta semana?",
    ),
    Metric(
        id="products_sold", label="Produtos vendidos", module="sales", unit="count",
        description="Quantos produtos diferentes tiveram pelo menos uma venda no recorte (amplitude do mix).",
        dimensions=("category", "channel", "state", "segment", "day"),
        select=_simple("count(distinct product_id)", NOT_CANCELED),
        question="Quantos produtos diferentes vendemos no app?",
    ),
    # ── Clientes ─────────────────────────────────────────────────────────────
    Metric(
        id="customers", label="Clientes ativos", module="customers", unit="count",
        description="Quantidade de clientes diferentes que compraram no recorte. Combine com new_customers.",
        dimensions=ALL,
        select=_simple("count(distinct customer_id)", NOT_CANCELED),
        question="Quantos clientes compraram no último mês?",
    ),
    Metric(
        id="new_customers", label="Clientes novos", module="customers", unit="count",
        description=("Clientes que fizeram a primeira compra na loja dentro do recorte. Em kpi_progress, use "
                     "of: customers para mostrar 'X de Y' (quanto da base ativa é nova)."),
        dimensions=ALL,
        select=_simple("count(distinct customer_id)", f"{NOT_CANCELED} and first_order"),
        question="Quantos clientes novos ganhamos por canal?",
    ),
    Metric(
        id="repeat_rate", label="Recompra", module="customers", unit="percent",
        description=("Percentual dos clientes ativos que fizeram 2 ou mais pedidos no período. Mede fidelidade. "
                     "Não aceita a dimensão day (recompra é medida no período inteiro)."),
        dimensions=("category", "channel", "state", "segment"),
        ctes="""
, per_customer as (
    select customer_id __GCOLS_C__, count(distinct order_id) as n
      from base
     where status <> 'canceled'
     group by customer_id __GCOLS_C__
)""",
        select="select __SEL__ avg(case when n >= 2 then 1.0 else 0.0 end) as value from per_customer __GROUP__",
        question="Qual segmento de cliente volta a comprar mais?",
    ),
    Metric(
        id="revenue_per_customer", label="Receita por cliente", module="customers", unit="currency",
        description="Receita média por cliente ativo no período, em R$.",
        dimensions=("category", "channel", "state", "segment", "day"),
        select=_simple("sum(revenue) / nullif(count(distinct customer_id), 0)", NOT_CANCELED),
        question="Quanto cada cliente do clube gasta em média?",
    ),
    # ── Operação ─────────────────────────────────────────────────────────────
    Metric(
        id="orders_delivered", label="Pedidos entregues", module="operations", unit="count",
        description=("Pedidos entregues (inclusive os que depois tiveram devolução). Serve de total (of) para "
                     "orders_on_time em kpi_progress."),
        dimensions=ALL,
        select=_simple("count(distinct order_id)", DELIVERED),
    ),
    Metric(
        id="orders_on_time", label="Entregues no prazo", module="operations", unit="count",
        description=("Pedidos entregues dentro do prazo prometido. Combine com orders_delivered em kpi_progress "
                     "(of) para mostrar 'X de Y no prazo'."),
        dimensions=ALL,
        select=_simple("count(distinct order_id)", f"{DELIVERED} and not late"),
        question="Quantos pedidos chegaram no prazo?",
    ),
    Metric(
        id="late_delivery_rate", label="Atraso na entrega", module="operations", unit="percent",
        description="Percentual dos pedidos entregues que chegaram depois do prazo. Quanto menor, melhor.",
        dimensions=ALL,
        select=_simple("count(distinct order_id) filter (where late) * 1.0 / nullif(count(distinct order_id), 0)",
                       DELIVERED),
        question="Em que estados as entregas mais atrasam?",
    ),
    Metric(
        id="return_rate", label="Devolução", module="operations", unit="percent",
        description="Percentual das unidades vendidas que foram devolvidas. Quanto menor, melhor.",
        dimensions=ALL,
        select=_simple("sum(qty) filter (where status = 'returned') * 1.0 / nullif(sum(qty), 0)", NOT_CANCELED),
        question="Quais categorias têm mais devolução?",
    ),
    Metric(
        id="cancel_rate", label="Cancelamento", module="operations", unit="percent",
        description="Percentual dos pedidos que foram cancelados. Quanto menor, melhor.",
        dimensions=ALL,
        select=_simple("count(distinct order_id) filter (where status = 'canceled') * 1.0 / "
                       "nullif(count(distinct order_id), 0)"),
        question="Qual canal tem mais cancelamento?",
    ),
]}

FILTERABLE = [d for d in DIMENSIONS if d != "day"]


def metrics_for(modules: list[str]) -> dict[str, Metric]:
    return {k: m for k, m in METRICS.items() if m.module in modules}


def public_catalog(modules: list[str]) -> dict:
    """O que o agente vê. Sem SQL, sem tabela."""
    return {
        "modules": [{"id": m, "label": MODULES[m]} for m in modules],
        "dimensions": [{"id": d.id, "label": d.label, "description": d.description} for d in DIMENSIONS.values()],
        "periods": [{"id": k, "label": v[1]} for k, v in PERIODS.items()],
        "default_period": DEFAULT_PERIOD,
        "filters": ("filters aceita qualquer dimensão exceto day: um id, uma lista de ids ou '$param'. "
                    "Em ranking_bar, bar e table, filters.value aceita {gt|gte|lt|lte: número} sobre o valor "
                    "(percentuais como fração: 0.05 = 5%). Os ids válidos saem do profile_data."),
        "metrics": [
            {
                "id": m.id, "label": m.label, "module": m.module, "unit": m.unit,
                "description": m.description, "dimensions": list(m.dimensions),
                "accepts_period": m.fixed_period is None,
            }
            for m in metrics_for(modules).values()
        ],
    }
