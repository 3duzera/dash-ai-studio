"""As três portas da validação, com specs erradas de propósito.

Rodar:  docker compose exec api pytest -q
Usa o banco do compose (dados do seed), cliente aurora salvo indicação.
"""
import copy

import pytest

from app import db
from app.validate import validate_spec

GOOD = {
    "schemaVersion": 1,
    "kitVersion": "mvp-1",
    "title": "Teste",
    "params": {
        "state": {"type": "state", "default": ["sp", "rj"]},
        "period": {"type": "period", "default": "last_30_days"},
    },
    "rows": [
        {"blocks": [
            {"id": "rank", "kind": "ranking_bar", "span": 8, "title": "Receita por canal",
             "query": {"metric": "revenue", "dimensions": ["channel"],
                       "filters": {"state": "$state"}, "period": "$period", "sort": "desc"}},
            {"id": "kpi", "kind": "kpi_progress", "span": 4, "title": "Entregues no prazo",
             "query": {"metric": "orders_on_time", "of": "orders_delivered", "period": "$period"}},
        ]},
        {"blocks": [
            {"id": "linha", "kind": "line", "span": 12, "title": "Receita no tempo",
             "query": {"metric": "revenue", "dimensions": ["day"], "period": "$period"}},
        ]},
    ],
}


def run(spec, tenant="aurora"):
    with db.conn() as c:
        return validate_spec(c, tenant, spec)


def mutate(fn):
    s = copy.deepcopy(GOOD)
    fn(s)
    return s


def block(s, i, j=0):
    return s["rows"][i]["blocks"][j]


def messages(r):
    return " | ".join(e["message"] for e in r["errors"])


def test_spec_boa_passa_nas_tres_portas():
    r = run(GOOD)
    assert r["valid"], messages(r)
    assert r["stage"] == "dry_run"
    assert all(b["status"] == "ok" for b in r["blocks"].values())


# ── porta 1: formato ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("name, fn, expected", [
    ("campo de cor não existe", lambda s: block(s, 0).update(color="#ff0000"), "o campo 'color' não existe"),
    ("bloco inventado", lambda s: block(s, 0).update(kind="mapa_3d"), "não é aceito em 'kind'"),
    ("span acima de 12", lambda s: block(s, 1).update(span=13), "fora do intervalo"),
    ("sem título", lambda s: block(s, 0).pop("title"), "falta o campo obrigatório 'title'"),
    ("SQL na query", lambda s: block(s, 0)["query"].update(sql="select 1"), "o campo 'sql' não existe"),
    ("kitVersion errada", lambda s: s.update(kitVersion="2026.10"), "não é aceito em 'kitVersion'"),
])
def test_porta_1_formato(name, fn, expected):
    r = run(mutate(fn))
    assert not r["valid"] and r["stage"] == "schema", name
    assert expected in messages(r), messages(r)


def test_erro_de_formato_aponta_o_bloco():
    r = run(mutate(lambda s: block(s, 0).update(kind="mapa_3d")))
    assert r["errors"][0]["blockId"] == "rank"


# ── porta 2: sentido ─────────────────────────────────────────────────────────

def _two_kpis(s):
    block(s, 1).update(span=6)
    s["rows"][1]["blocks"].append({"id": "linha", "kind": "kpi", "span": 4, "title": "x",
                                   "query": {"metric": "orders"}})


@pytest.mark.parametrize("name, fn, expected", [
    ("linha não soma 12", lambda s: block(s, 0).update(span=6), "a linha 1 soma 10 colunas"),
    ("métrica inventada", lambda s: block(s, 1)["query"].update(metric="lucro_por_produto"), "não existe no catálogo"),
    ("line sem day", lambda s: block(s, 1)["query"].update(dimensions=["state"]), "line precisa da dimensão day"),
    ("kpi com dimensão", lambda s: block(s, 0, 1)["query"].update(dimensions=["state"]), "não aceita dimensões"),
    ("dimensão que a métrica não aceita",
     lambda s: block(s, 1)["query"].update(metric="repeat_rate", dimensions=["day", "state"]),
     "não aceita a(s) dimensão(ões)"),
    ("estado que não existe", lambda s: s["params"]["state"].update(default=["sao_paulo"]), "valor(es) que não existem: sao_paulo"),
    ("param não declarado", lambda s: block(s, 0)["query"]["filters"].update(state="$estados"), "não foi declarado"),
    ("data fixa", lambda s: block(s, 1)["query"].update(period="2025-03"), "período inválido"),
    ("período em métrica de período fixo",
     lambda s: block(s, 0)["query"].update(metric="revenue_change_7d"), "tem período fixo"),
    ("kpi_progress de contagem sem total", lambda s: block(s, 0, 1)["query"].pop("of"), "precisa de 'of'"),
    ("id repetido", _two_kpis, "aparece mais de uma vez"),
    ("filtro de valor em kpi", lambda s: block(s, 0, 1)["query"].setdefault("filters", {}).update(value={"gt": 0}), "filters.value só vale"),
])
def test_porta_2_sentido(name, fn, expected):
    r = run(mutate(fn))
    assert not r["valid"] and r["stage"] == "semantic", f"{name}: {r['stage']} {messages(r)}"
    assert expected in messages(r), messages(r)


def test_hint_traz_valores_validos():
    r = run(mutate(lambda s: s["params"]["state"].update(default=["sao_paulo"])))
    assert "sp (São Paulo)" in r["errors"][0]["hint"]


def test_modulo_nao_contratado():
    s = mutate(lambda s: block(s, 1)["query"].update(metric="late_delivery_rate"))
    assert run(s, "aurora")["valid"]
    r = run(s, "brisa")
    assert r["stage"] == "semantic"
    assert "não contratou" in messages(r)


def test_param_sem_uso_vira_aviso_e_nao_erro():
    r = run(mutate(lambda s: s["params"].update(channel={"type": "channel", "default": ["app"]})))
    assert r["valid"]
    assert any("'channel'" in w["message"] for w in r["warnings"])


# ── porta 3: dry-run ─────────────────────────────────────────────────────────

def test_porta_3_bloco_vazio():
    # Devolução é uma fração (0 a 1): pedir só os canais acima de 5 (500%) não traz linha.
    def fn(s):
        q = block(s, 0)["query"]
        q.update(metric="return_rate", filters={"value": {"gt": 5}})
    r = run(mutate(fn))
    assert not r["valid"] and r["stage"] == "dry_run", messages(r)
    assert r["blocks"]["rank"]["status"] == "empty"
    assert r["errors"][0]["blockId"] == "rank"
