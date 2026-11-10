"""Da spec ao SQL. A spec só escolhe métrica, dimensões, filtros e período; o SQL vem do catálogo.

Nome de coluna sai sempre de DIMENSIONS (lista fechada). Valor vai sempre como parâmetro.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal

import psycopg

from .catalog import DEFAULT_PERIOD, DIMENSIONS, METRICS, PERIODS, Metric
from .spec import Block, Spec

DEFAULT_LIMIT = {"kpi": 1, "kpi_progress": 1, "ranking_bar": 10, "bar": 50, "line": 500, "table": 50, "heatmap": 500}
VALUE_OPS = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

BASE = """
    select o.day, o.order_id, o.customer_id, o.product_id, p.name as product_name, p.category, p.category_name,
           o.channel_id, ch.name as channel_name, o.state_id, st.name as state_name,
           o.segment_id, sg.name as segment_name, o.qty, o.unit_price, o.discount,
           o.qty * o.unit_price * (1 - o.discount) as revenue, o.qty * p.unit_cost as cost,
           o.status, o.late, o.first_order
      from warehouse.order_line o
      join warehouse.product p on p.tenant_id = o.tenant_id and p.id = o.product_id
      join warehouse.channel ch on ch.id = o.channel_id
      join warehouse.state st on st.id = o.state_id
      join warehouse.segment sg on sg.id = o.segment_id
     where o.tenant_id = %(tenant)s and o.day between %(d0)s and %(d1)s __FILTERS__
"""


class QueryError(Exception):
    pass


# ── apoio ────────────────────────────────────────────────────────────────────

def tenant_info(c, tenant: str) -> dict | None:
    return c.execute("select * from warehouse.tenant where id = %s", (tenant,)).fetchone()


def dimension_values(c, tenant: str, dim: str) -> list[dict]:
    sql = {
        "product": "select id, name as label from warehouse.product where tenant_id = %(t)s order by name",
        "category": ("select distinct category as id, category_name as label from warehouse.product "
                     "where tenant_id = %(t)s order by 2"),
        "channel": "select id, name as label from warehouse.channel order by name",
        "state": "select id, name as label from warehouse.state order by name",
        "segment": "select id, name as label from warehouse.segment order by name",
    }.get(dim)
    if not sql:
        return []
    return c.execute(sql, {"t": tenant}).fetchall()


def resolve_period(c, tenant: str, period_id: str) -> dict:
    last = c.execute(
        "select day, materialized_at from warehouse.daily_load "
        "where tenant_id = %s and status = 'ok' order by day desc limit 1", (tenant,)).fetchone()
    if not last:
        raise QueryError("não há nenhuma carga de dados concluída para este cliente")
    if period_id == "last_14_days":
        n, label = 14, "Últimas 2 semanas"
    else:
        n, label = PERIODS[period_id]
    d1 = last["day"]
    return {"id": period_id, "from": d1 - timedelta(days=n - 1), "to": d1, "label": label,
            "materialized_at": last["materialized_at"]}


def _plain(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


# ── montagem do SQL ──────────────────────────────────────────────────────────

def build_sql(metric: Metric, dims: list[str], filters: dict[str, list[str]],
              value_filter: dict | None, sort: str | None) -> str:
    sel = "".join(f'{DIMENSIONS[d].id_col} as "{d}", {DIMENSIONS[d].label_col} as "{d}__label", ' for d in dims)
    gcols = list(dict.fromkeys(c for d in dims for c in (DIMENSIONS[d].id_col, DIMENSIONS[d].label_col)))
    group = f"group by {', '.join(gcols)}" if gcols else ""
    gcols_c = "".join(f", {c}" for c in gcols)

    def fsql(keys):
        return "".join(f" and {DIMENSIONS[k].src_col} = any(%(f_{k})s)" for k in keys)

    sql = f"with base as ({BASE.replace('__FILTERS__', fsql(filters))})"

    def fill(text):
        return text.replace("__SEL__", sel).replace("__GROUP__", group).replace("__GCOLS_C__", gcols_c)

    sql += fill(metric.ctes)
    sql += f", result as ({fill(metric.select)}) select * from result where value is not null"
    for op, sym in VALUE_OPS.items():
        if value_filter and value_filter.get(op) is not None:
            sql += f" and value {sym} %(v_{op})s"
    if sort:
        sql += f" order by value {'desc' if sort == 'desc' else 'asc'}"
    elif "day" in dims:
        sql += ' order by "day"' + "".join(f', "{d}__label"' for d in dims if d != "day")
    elif dims:
        sql += f' order by "{dims[0]}__label"'
    return sql + " limit %(limit)s"


def run_metric(c, tenant: str, metric_id: str, dims: list[str], filters: dict[str, list[str]],
               value_filter: dict | None, period_id: str, sort: str | None, limit: int):
    metric = METRICS[metric_id]
    pinfo = resolve_period(c, tenant, metric.fixed_period or period_id)
    params = {"tenant": tenant, "d0": pinfo["from"], "d1": pinfo["to"],
              "mid": pinfo["to"] - timedelta(days=7), "limit": limit}
    params.update({f"f_{k}": v for k, v in filters.items()})
    params.update({f"v_{op}": v for op, v in (value_filter or {}).items() if v is not None})
    rows = c.execute(build_sql(metric, dims, filters, value_filter, sort), params).fetchall()
    return [{k: _plain(v) for k, v in r.items()} for r in rows], pinfo


# ── bloco da spec → dado no formato fixo do bloco ────────────────────────────

def param_values(spec: Spec, overrides: dict | None) -> dict:
    values = {name: p.default for name, p in spec.params.items()}
    for name, v in (overrides or {}).items():
        if name in values:
            values[name] = v
    return values


def resolve_inputs(spec: Spec, block: Block, overrides: dict | None):
    values = param_values(spec, overrides)
    filters, value_filter = {}, None
    for key, raw in block.query.filters.items():
        if key == "value":
            value_filter = raw.model_dump(exclude_none=True) if hasattr(raw, "model_dump") else None
            continue
        v = values.get(raw[1:]) if isinstance(raw, str) and raw.startswith("$") else raw
        v = [v] if isinstance(v, str) else list(v or [])
        if v:
            filters[key] = v
    p = block.query.period
    period_id = values.get(p[1:]) if p and p.startswith("$") else p
    return filters, value_filter, period_id or DEFAULT_PERIOD


def run_block(c, tenant: str, spec: Spec, block: Block, overrides: dict | None = None) -> dict:
    q = block.query
    metric = METRICS[q.metric]
    out = {"block_id": block.id, "kind": block.kind, "unit": metric.unit, "signed": metric.signed,
           "metric": {"id": metric.id, "label": metric.label}}
    try:
        filters, value_filter, period_id = resolve_inputs(spec, block, overrides)
        limit = q.limit or DEFAULT_LIMIT[block.kind]
        rows, pinfo = run_metric(c, tenant, q.metric, q.dimensions, filters, value_filter, period_id, q.sort, limit)
        data, empty = _shape(c, tenant, block, metric, rows, filters, period_id)
    except QueryError as e:
        return {**out, "status": "error", "message": str(e)}
    except psycopg.errors.QueryCanceled:
        return {**out, "status": "error", "message": "a consulta passou de 5 s e foi cancelada"}
    except psycopg.Error as e:
        return {**out, "status": "error", "message": f"erro ao consultar o banco: {e.diag.message_primary}"}
    return {
        **out,
        "status": "empty" if empty else "ok",
        "data": data,
        "row_count": len(rows),
        "period": {"id": pinfo["id"], "label": pinfo["label"],
                   "from": pinfo["from"].isoformat(), "to": pinfo["to"].isoformat()},
        "materialized_at": _plain(pinfo["materialized_at"]),
    }


def _shape(c, tenant, block: Block, metric: Metric, rows, filters, period_id):
    q, kind, dims = block.query, block.kind, block.query.dimensions
    if kind == "kpi":
        v = rows[0]["value"] if rows else None
        return {"value": v}, v is None
    if kind == "kpi_progress":
        v = rows[0]["value"] if rows else None
        if q.of:
            of_rows, _ = run_metric(c, tenant, q.of, [], filters, None, period_id, None, 1)
            total = of_rows[0]["value"] if of_rows else None
            return {"value": v, "total": total, "of_label": METRICS[q.of].label}, v is None or not total
        return {"value": v, "total": 1.0, "of_label": None}, v is None
    if kind in ("ranking_bar", "bar", "heatmap"):
        items = []
        for r in rows:
            item = {"key": r[dims[0]], "label": r[f"{dims[0]}__label"], "value": r["value"]}
            if len(dims) > 1:
                item.update(series=r[dims[1]], series_label=r[f"{dims[1]}__label"])
            items.append(item)
        return {"items": items}, not items
    if kind == "line":
        other = next((d for d in dims if d != "day"), None)
        points = []
        for r in rows:
            p = {"x": r["day"], "value": r["value"]}
            if other:
                p.update(series=r[other], series_label=r[f"{other}__label"])
            points.append(p)
        return {"points": points}, not points
    # table
    columns = [{"key": d, "label": DIMENSIONS[d].label, "type": "dimension"} for d in dims]
    columns.append({"key": metric.id, "label": metric.label, "unit": metric.unit, "signed": metric.signed, "type": "metric"})
    table = [{**{d: r[f"{d}__label"] for d in dims}, metric.id: r["value"],
              "_key": tuple(r[d] for d in dims)} for r in rows]
    for extra in q.columns or []:
        em = METRICS[extra]
        columns.append({"key": em.id, "label": em.label, "unit": em.unit, "signed": em.signed, "type": "metric"})
        extra_rows, _ = run_metric(c, tenant, extra, dims, filters, None, period_id, None, 5000)
        by_key = {tuple(r[d] for d in dims): r["value"] for r in extra_rows}
        for row in table:
            row[em.id] = by_key.get(row["_key"])
    for row in table:
        row.pop("_key")
    return {"columns": columns, "rows": table}, not table
