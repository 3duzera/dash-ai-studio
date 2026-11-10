"""Sessão do Studio, regra de edição, heatmap, coerência entre métricas e publicação, pela API (TestClient).

Rodar:  docker compose exec api pytest -q
Cria rascunhos no cliente aurora e apaga no fim.
"""
import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app

H = {"X-Tenant": "aurora"}
client = TestClient(app)   # sem `with`: o pool já vem aberto do conftest

SPEC = {
    "schemaVersion": 1, "kitVersion": "mvp-1", "title": "Studio teste",
    "rows": [
        {"blocks": [
            {"id": "kpi", "kind": "kpi", "span": 4, "title": "Pedidos",
             "query": {"metric": "orders"}},
            {"id": "rank", "kind": "ranking_bar", "span": 8, "title": "Receita por estado",
             "query": {"metric": "revenue", "dimensions": ["state"], "sort": "desc"}},
        ]},
        {"blocks": [
            {"id": "linha", "kind": "line", "span": 12, "title": "Receita no tempo",
             "query": {"metric": "revenue", "dimensions": ["day"]}},
        ]},
    ],
}


@pytest.fixture
def draft():
    """Uma sessão com um rascunho ligado. Apaga no fim (a sessão vai junto, em cascata)."""
    s = client.post("/api/studio/sessions", json={}, headers=H).json()
    r = client.post("/api/drafts", json={"spec": SPEC, "created_via": "agent", "session_id": s["id"]}, headers=H)
    assert r.status_code == 200, r.text
    d = r.json()
    yield s["id"], d["id"]
    client.delete(f"/api/dashboards/{d['id']}", headers=H)


def put(dash_id, spec, **extra):
    return client.put(f"/api/drafts/{dash_id}", json={"spec": spec, **extra}, headers=H)


def with_change(fn):
    s = copy.deepcopy(SPEC)
    fn(s)
    return s


# ── sessão ───────────────────────────────────────────────────────────────────

def test_rascunho_criado_fica_ligado_a_sessao(draft):
    sid, did = draft
    s = client.get(f"/api/studio/sessions/{sid}", headers=H).json()
    assert s["dashboard_id"] == did
    assert s["draft"]["spec"]["title"] == "Studio teste"
    assert client.get(f"/api/dashboards/{did}/session", headers=H).json()["id"] == sid


def test_edicao_manual_vira_mensagem_da_sessao(draft):
    sid, did = draft
    spec = with_change(lambda s: s["rows"][0]["blocks"][1].update(title="Onde mais vendemos"))
    r = put(did, spec, session_id=sid, edit_note="renomeou o bloco rank")
    assert r.status_code == 200, r.text
    msgs = client.get(f"/api/studio/sessions/{sid}", headers=H).json()["messages"]
    assert msgs[-1]["role"] == "manual" and msgs[-1]["content"]["note"] == "renomeou o bloco rank"


def test_edicao_manual_invalida_nao_grava_nada(draft):
    sid, did = draft
    spec = with_change(lambda s: s["rows"][0]["blocks"][0].update(span=6))   # linha soma 14
    r = put(did, spec, session_id=sid, edit_note="não deveria aparecer")
    assert r.status_code == 422
    msgs = client.get(f"/api/studio/sessions/{sid}", headers=H).json()["messages"]
    assert not any(m["role"] == "manual" for m in msgs)


def test_mensagens_e_ordem(draft):
    sid, _ = draft
    for role, text in [("user", "oi"), ("assistant", "olá"), ("note", "aviso")]:
        assert client.post(f"/api/studio/sessions/{sid}/messages", json={"role": role, "content": {"text": text}},
                           headers=H).status_code == 200
    msgs = client.get(f"/api/studio/sessions/{sid}", headers=H).json()["messages"]
    assert [m["content"]["text"] for m in msgs[-3:]] == ["oi", "olá", "aviso"]
    bad = client.post(f"/api/studio/sessions/{sid}/messages", json={"role": "system", "content": {}}, headers=H)
    assert bad.status_code == 422


def test_um_turno_por_vez(draft):
    sid, _ = draft
    assert client.post(f"/api/studio/sessions/{sid}/lock", json={"model": "haiku"}, headers=H).status_code == 200
    assert client.post(f"/api/studio/sessions/{sid}/lock", json={}, headers=H).status_code == 409
    client.post(f"/api/studio/sessions/{sid}/unlock", headers=H)
    assert client.post(f"/api/studio/sessions/{sid}/lock", json={}, headers=H).status_code == 200
    client.post(f"/api/studio/sessions/{sid}/unlock", headers=H)


def test_sessao_de_outro_cliente_nao_aparece(draft):
    sid, _ = draft
    assert client.get(f"/api/studio/sessions/{sid}", headers={"X-Tenant": "brisa"}).status_code == 404


# ── regra de edição ──────────────────────────────────────────────────────────

def test_only_block_recusa_mexer_em_outro_bloco(draft):
    _, did = draft
    spec = with_change(lambda s: s["rows"][1]["blocks"][0].update(title="Outro título"))
    r = put(did, spec, only_block="rank")
    assert r.status_code == 422
    v = r.json()["validation"]
    assert v["stage"] == "edit" and "linha" in v["errors"][0]["message"]


def test_only_block_aceita_mudar_o_bloco_alvo_e_o_span_dos_vizinhos(draft):
    _, did = draft

    def change(s):
        s["rows"][0]["blocks"][1].update(kind="bar", title="Receita por estado (barras)", span=6)
        s["rows"][0]["blocks"][0]["span"] = 6
    assert put(did, with_change(change), only_block="rank").status_code == 200


def test_only_block_recusa_sumir_com_outro_bloco(draft):
    _, did = draft

    def change(s):
        s["rows"].pop(1)
    r = put(did, with_change(change), only_block="rank")
    assert r.status_code == 422 and "sumiu" in r.json()["validation"]["errors"][0]["message"]


def test_sem_only_block_remocao_vira_aviso(draft):
    _, did = draft
    r = put(did, with_change(lambda s: s["rows"].pop(1)))
    assert r.status_code == 200
    assert "linha" in r.json()["warnings"][-1]["message"]


# ── heatmap e coerência entre métricas ─────────────────────────────────────────────────

def validate(spec):
    return client.post("/api/validate", json={"spec": spec}, headers=H).json()


def one_block(block):
    return {"schemaVersion": 1, "kitVersion": "mvp-1", "title": "t", "rows": [{"blocks": [block]}]}


def test_heatmap_estado_por_canal():
    v = validate(one_block({"id": "calor", "kind": "heatmap", "span": 12, "title": "Atraso estado × canal",
                            "query": {"metric": "late_delivery_rate", "dimensions": ["state", "channel"]}}))
    assert v["valid"], v["errors"]


def test_heatmap_nao_aceita_day():
    v = validate(one_block({"id": "calor", "kind": "heatmap", "span": 12, "title": "x",
                            "query": {"metric": "revenue", "dimensions": ["day", "channel"]}}))
    assert not v["valid"] and "heatmap precisa" in v["errors"][0]["message"]


def test_tabela_receita_pedidos_ticket():
    spec = one_block({"id": "tab", "kind": "table", "span": 12, "title": "Canais",
                      "query": {"metric": "revenue", "dimensions": ["channel"], "sort": "desc",
                                "columns": ["orders", "avg_ticket"]}})
    assert validate(spec)["valid"]
    s = client.post("/api/studio/sessions", json={}, headers=H).json()
    d = client.post("/api/drafts", json={"spec": spec, "session_id": s["id"]}, headers=H).json()
    try:
        res = client.post(f"/api/dashboards/{d['id']}/blocks/tab/query", json={}, headers=H).json()
        assert res["status"] == "ok"
        for row in res["data"]["rows"]:
            # ticket médio = receita ÷ pedidos (as colunas extras saem de consultas separadas)
            assert abs(row["avg_ticket"] - row["revenue"] / row["orders"]) < 0.01
    finally:
        client.delete(f"/api/dashboards/{d['id']}", headers=H)


# ── publicar e escopo ────────────────────────────────────────────────────────

def test_publicar_so_para_mim(draft):
    _, did = draft
    r = client.post(f"/api/dashboards/{did}/publish", json={"visibility": "individual"}, headers=H).json()
    assert r["status"] == "published" and r["visibility"] == "individual"
    assert client.post(f"/api/dashboards/{did}/publish", json={"visibility": "todos"}, headers=H).status_code == 422


def test_scope_do_cartao_vai_consultar():
    s = client.get("/api/scope", params={"metric": "revenue"}, headers=H).json()
    assert s["module"] == "Vendas" and s["states"] == 6 and s["channels"] == 5 and s["loads"] > 80
    brisa = client.get("/api/scope", params={"metric": "late_delivery_rate"}, headers={"X-Tenant": "brisa"}).json()
    assert brisa["module"] is None   # Operação não está no contrato da Brisa
