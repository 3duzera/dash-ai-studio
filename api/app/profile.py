"""Perfil de uma métrica: o que a IA vê do dado na criação. Resumo, nunca a tabela.

Não aceita filtros: O perfil é sempre o da métrica inteira nos últimos 90
dias, então chamar em laço com filtros diferentes não extrai dado.
"""
from .catalog import METRICS
from .query import QueryError, run_metric

MAX_VALUES = 12
SAMPLE = 5


def profile(c, tenant: str, metric_id: str, dimensions: list[str]) -> dict:
    m = METRICS[metric_id]
    bad = [d for d in dimensions if d not in m.dimensions]
    if bad:
        raise QueryError(f"a métrica '{metric_id}' não aceita: {', '.join(bad)} (aceita: {', '.join(m.dimensions)})")
    rows, pinfo = run_metric(c, tenant, metric_id, dimensions, {}, None, "last_90_days", None, 5000)
    out = {
        "metric": metric_id,
        "unit": m.unit,
        "period": {"id": pinfo["id"], "from": pinfo["from"].isoformat(), "to": pinfo["to"].isoformat()},
        "row_count": len(rows),
        "dimensions": {},
        "value_range": None,
        "sample": [],
    }
    values = [r["value"] for r in rows if r["value"] is not None]
    if values:
        out["value_range"] = {"min": round(min(values), 4), "max": round(max(values), 4)}
    for d in dimensions:
        seen = {}
        for r in rows:
            seen.setdefault(r[d], r[f"{d}__label"])
        items = list(seen.items())
        if d == "day":
            out["dimensions"][d] = {"distinct": len(items), "from": items[0][0] if items else None,
                                    "to": items[-1][0] if items else None}
        else:
            out["dimensions"][d] = {
                "distinct": len(items),
                "values": [{"id": k, "label": v} for k, v in items[:MAX_VALUES]],
                "more": max(0, len(items) - MAX_VALUES),
            }
    out["sample"] = [
        {**{d: r[f"{d}__label"] for d in dimensions}, "value": round(r["value"], 4) if r["value"] is not None else None}
        for r in rows[:SAMPLE]
    ]
    return out
