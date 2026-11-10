"""As histórias plantadas pelo seed aparecem nas métricas. Se não aparecerem, os dashboards de exemplo ficam
sem graça e os evals perdem o sentido.

Rodar:  docker compose exec -w /srv api pytest -q
"""
from app import db
from app.query import run_metric


def by(metric, dim, tenant="aurora", period="last_90_days"):
    with db.conn() as c:
        rows, _ = run_metric(c, tenant, metric, [dim], {}, None, period, None, 500)
    return {r[dim]: r["value"] for r in rows}


def top(values):
    return max(values, key=values.get)


def bottom(values):
    return min(values, key=values.get)


def test_rs_atrasa_mais():
    assert top(by("late_delivery_rate", "state")) == "rs"


def test_marketplace_cancela_mais_e_tem_menos_margem():
    assert top(by("cancel_rate", "channel")) == "marketplace"
    assert bottom(by("gross_margin", "channel")) == "marketplace"


def test_clube_recompra_mais():
    assert top(by("repeat_rate", "segment", period="last_30_days")) == "clube"


def test_categoria_com_mais_devolucao():
    assert top(by("return_rate", "category")) == "cama_banho"
    assert top(by("return_rate", "category", tenant="brisa")) == "maquiagem"


def test_categoria_caindo_na_ultima_semana():
    change = by("revenue_change_7d", "category")
    assert bottom(change) == "climatizacao" and change["climatizacao"] < -0.3


def test_dois_dias_sem_carga():
    with db.conn() as c:
        rows, _ = run_metric(c, "aurora", "orders", ["day"], {}, None, "last_90_days", None, 500)
    assert len(rows) == 88
