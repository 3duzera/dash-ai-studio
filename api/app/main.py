"""API: catálogo, kit, validação, rascunhos, sessão do Studio e o dado de cada bloco.

Atalho de protótipo: o cliente vem no header X-Tenant (a página tem um seletor). Em produção viria da sessão
autenticada.
"""
import json
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from . import db, studio
from .catalog import METRICS, MODULES, PERIODS, public_catalog
from .kit import KIT
from .profile import profile
from .query import QueryError, dimension_values, run_block, tenant_info
from .spec import Spec
from .validate import validate_spec

WEB_DIR = Path("/web")
EXAMPLES_DIR = Path("/specs/exemplos")


@asynccontextmanager
async def lifespan(_app):
    db.pool.open(wait=True)
    yield
    db.pool.close()


app = FastAPI(title="Dash AI Studio", lifespan=lifespan)


@app.middleware("http")
async def no_stale_assets(request, call_next):
    # Em desenvolvimento, o navegador sempre revalida a página (senão guarda CSS/JS antigo depois de editar).
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _tenant(c, x_tenant: str | None) -> dict:
    if not x_tenant:
        raise HTTPException(400, "envie o header X-Tenant (aurora ou brisa)")
    t = tenant_info(c, x_tenant)
    if not t:
        raise HTTPException(404, f"cliente '{x_tenant}' não existe")
    return t


def _dashboard(c, tenant: str, dash_id: str) -> dict:
    row = c.execute("select * from dashboards.dashboard where tenant_id = %s and id = %s",
                    (tenant, dash_id)).fetchone()
    if not row:
        raise HTTPException(404, "dashboard não encontrado")
    return row


def _summary(row: dict) -> dict:
    spec = row["spec"]
    return {
        "id": row["id"], "title": row["title"], "status": row["status"],
        "has_unpublished_changes": row["published_spec"] is not None and row["published_spec"] != spec,
        "created_via": row["created_via"],
        "visibility": row.get("visibility", "team"),
        "blocks": sum(len(r.get("blocks", [])) for r in spec.get("rows", [])),
        "updated_at": row["updated_at"].isoformat(),
        "published_at": row["published_at"].isoformat() if row["published_at"] else None,
    }


# ── leitura do catálogo e do kit (o que o agente usa) ────────────────────────

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/config")
def config():
    """O que a página precisa saber do ambiente: a porta pública do agente."""
    return {"agent_port": int(os.environ.get("AGENT_PORT", "8100"))}


@app.get("/api/tenants")
def tenants():
    with db.conn() as c:
        return c.execute("select id, name, segment, modules from warehouse.tenant order by id").fetchall()


@app.get("/api/catalog")
def catalog(x_tenant: str | None = Header(None)):
    with db.conn() as c:
        return public_catalog(_tenant(c, x_tenant)["modules"])


@app.get("/api/kit")
def kit():
    return KIT


@app.get("/api/dimensions/{dim}")
def dimension(dim: str, x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        if dim == "period":
            return [{"id": k, "label": v[1]} for k, v in PERIODS.items()]
        return dimension_values(c, x_tenant, dim)


@app.post("/api/profile")
def profile_route(body: dict = Body(...), x_tenant: str | None = Header(None)):
    with db.conn() as c:
        t = _tenant(c, x_tenant)
        metric = body.get("metric")
        if metric not in METRICS or METRICS[metric].module not in t["modules"]:
            raise HTTPException(422, f"métrica '{metric}' não está no catálogo deste cliente")
        if body.get("filters"):
            # O perfil é sempre o da métrica inteira. Filtro não é aceito, nem ignorado em silêncio.
            raise HTTPException(422, "profile_data não aceita filtros: o perfil é sempre o da métrica inteira")
        try:
            return profile(c, x_tenant, metric, list(body.get("dimensions") or []))
        except QueryError as e:
            raise HTTPException(422, str(e))


@app.post("/api/validate")
def validate(body: dict = Body(...), x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        previous = _dashboard(c, x_tenant, body["draft_id"])["spec"] if body.get("draft_id") else None
        return validate_spec(c, x_tenant, body.get("spec"), previous=previous, only_block=body.get("only_block"))


# ── rascunhos e dashboards ──────────────────────────────────────────────────

def _save(c, tenant: str, spec: dict, dash_id: str | None, created_via: str, prompt: str | None,
          session_id: str | None = None, edit_note: str | None = None, only_block: str | None = None):
    """Valida e grava. Com session_id, o rascunho fica ligado à sessão do Studio; com edit_note, a edição
    manual vira uma mensagem da sessão na mesma transação (o agente vê no próximo turno)."""
    session = None
    if session_id:
        session = studio.find(c, tenant, session_id)
        if not session:
            raise HTTPException(404, "sessão do Studio não encontrada")
    previous = _dashboard(c, tenant, dash_id)["spec"] if dash_id else None
    v = validate_spec(c, tenant, spec, previous=previous, only_block=only_block)
    if not v["valid"]:
        return JSONResponse(status_code=422, content={"saved": False, "validation": v})
    with c.transaction():
        if dash_id:
            row = c.execute(
                "update dashboards.dashboard set spec = %s, title = %s, updated_at = now() "
                "where tenant_id = %s and id = %s returning *",
                (Jsonb(spec), spec["title"], tenant, dash_id)).fetchone()
        else:
            row = c.execute(
                "insert into dashboards.dashboard (tenant_id, id, title, status, spec, created_via, prompt) "
                "values (%s, %s, %s, 'draft', %s, %s, %s) returning *",
                (tenant, "d-" + secrets.token_hex(4), spec["title"], Jsonb(spec), created_via, prompt)).fetchone()
        if session:
            studio.link_dashboard(c, session_id, row["id"])
            if edit_note:
                studio.add_message(c, session_id, "manual", {"note": edit_note[:300]})
    return {"saved": True, **_summary(row), "warnings": v["warnings"], "blocks_dry_run": v["blocks"]}


@app.post("/api/drafts")
def create_draft(body: dict = Body(...), x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        return _save(c, x_tenant, body.get("spec"), None, body.get("created_via") or "manual", body.get("prompt"),
                     session_id=body.get("session_id"))


@app.put("/api/drafts/{dash_id}")
def update_draft(dash_id: str, body: dict = Body(...), x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        return _save(c, x_tenant, body.get("spec"), dash_id, "", None, session_id=body.get("session_id"),
                     edit_note=body.get("edit_note"), only_block=body.get("only_block"))


@app.get("/api/dashboards")
def list_dashboards(x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        rows = c.execute("select * from dashboards.dashboard where tenant_id = %s order by updated_at desc",
                         (x_tenant,)).fetchall()
        return [_summary(r) for r in rows]


@app.get("/api/dashboards/{dash_id}")
def get_dashboard(dash_id: str, x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        row = _dashboard(c, x_tenant, dash_id)
        return {**_summary(row), "prompt": row["prompt"], "spec": row["spec"], "published_spec": row["published_spec"]}


@app.delete("/api/dashboards/{dash_id}")
def delete_dashboard(dash_id: str, x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        c.execute("delete from dashboards.dashboard where tenant_id = %s and id = %s", (x_tenant, dash_id))
        return {"deleted": True}


@app.post("/api/dashboards/{dash_id}/publish")
def publish(dash_id: str, body: dict = Body(default={}), x_tenant: str | None = Header(None)):
    """Publicar é um clique humano na página. O agente não tem esta ferramenta (F3).
    visibility: team (todo o time vê) ou individual (só quem criou; no MVP não há login)."""
    visibility = body.get("visibility") or "team"
    if visibility not in ("team", "individual"):
        raise HTTPException(422, "visibility deve ser team ou individual")
    with db.conn() as c:
        _tenant(c, x_tenant)
        _dashboard(c, x_tenant, dash_id)
        row = c.execute(
            "update dashboards.dashboard set published_spec = spec, status = 'published', published_at = now(), "
            "visibility = %s where tenant_id = %s and id = %s returning *",
            (visibility, x_tenant, dash_id)).fetchone()
        return _summary(row)


@app.post("/api/dashboards/{dash_id}/blocks/{block_id}/query")
def query_block(dash_id: str, block_id: str, body: dict = Body(default={}), x_tenant: str | None = Header(None)):
    """O navegador manda só blockId + params. A query vem da spec salva, nunca do navegador."""
    with db.conn() as c:
        _tenant(c, x_tenant)
        row = _dashboard(c, x_tenant, dash_id)
        raw = row["published_spec"] if body.get("version") == "published" and row["published_spec"] else row["spec"]
        spec = Spec.model_validate(raw)
        block = spec.block(block_id)
        if not block:
            raise HTTPException(404, "bloco não existe nesta versão do dashboard")
        overrides = _check_overrides(c, x_tenant, spec, body.get("params") or {})
        return run_block(c, x_tenant, spec, block, overrides)


def _check_overrides(c, tenant: str, spec: Spec, params: dict) -> dict:
    """Só params declarados, só valores que existem."""
    clean = {}
    for name, value in params.items():
        p = spec.params.get(name)
        if not p:
            raise HTTPException(422, f"o param '{name}' não existe neste dashboard")
        if p.type == "period":
            if value not in PERIODS:
                raise HTTPException(422, f"período inválido: {value}")
        else:
            ids = [value] if isinstance(value, str) else list(value)
            valid = {v["id"] for v in dimension_values(c, tenant, p.type)}
            if any(i not in valid for i in ids):
                raise HTTPException(422, f"valor inválido para '{name}'")
        clean[name] = value
    return clean


# ── Studio: a sessão de conversa de cada dashboard ──────────────────────────

def _session(c, tenant: str, session_id: str) -> dict:
    row = studio.find(c, tenant, session_id)
    if not row:
        raise HTTPException(404, "sessão do Studio não encontrada")
    return row


@app.post("/api/studio/sessions")
def create_session(body: dict = Body(default={}), x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        if body.get("dashboard_id"):
            _dashboard(c, x_tenant, body["dashboard_id"])
        return studio.summary(studio.create(c, x_tenant, body.get("dashboard_id"), body.get("model")))


@app.get("/api/studio/sessions/{session_id}")
def get_session(session_id: str, limit: int = Query(60, ge=1, le=200), x_tenant: str | None = Header(None)):
    """O que a dash-ai lê a cada turno e o que o Studio mostra ao reabrir: conversa + rascunho atual."""
    with db.conn() as c:
        _tenant(c, x_tenant)
        s = _session(c, x_tenant, session_id)
        draft = None
        if s["dashboard_id"]:
            row = _dashboard(c, x_tenant, s["dashboard_id"])
            draft = {**_summary(row), "spec": row["spec"], "published_spec": row["published_spec"]}
        return {**studio.summary(s), "messages": studio.messages(c, session_id, limit), "draft": draft}


@app.get("/api/dashboards/{dash_id}/session")
def dashboard_session(dash_id: str, x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        _dashboard(c, x_tenant, dash_id)
        return studio.summary(studio.for_dashboard(c, x_tenant, dash_id))


@app.post("/api/studio/sessions/{session_id}/messages")
def add_session_message(session_id: str, body: dict = Body(...), x_tenant: str | None = Header(None)):
    if body.get("role") not in studio.ROLES or not isinstance(body.get("content"), dict):
        raise HTTPException(422, f"role deve ser um de {', '.join(studio.ROLES)} e content um objeto")
    with db.conn() as c:
        _tenant(c, x_tenant)
        _session(c, x_tenant, session_id)
        return studio.add_message(c, session_id, body["role"], body["content"], body.get("run"))


@app.post("/api/studio/sessions/{session_id}/lock")
def lock_session(session_id: str, body: dict = Body(default={}), x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        _session(c, x_tenant, session_id)
        if not studio.lock(c, x_tenant, session_id, body.get("model")):
            raise HTTPException(409, "o agente já está trabalhando nesta sessão")
        return {"locked": True}


@app.post("/api/studio/sessions/{session_id}/unlock")
def unlock_session(session_id: str, x_tenant: str | None = Header(None)):
    with db.conn() as c:
        _tenant(c, x_tenant)
        _session(c, x_tenant, session_id)
        studio.unlock(c, x_tenant, session_id)
        return {"locked": False}


@app.get("/api/scope")
def scope(metric: str | None = None, x_tenant: str | None = Header(None)):
    """O cartão "Vai consultar" do Studio: de onde vem o dado de uma métrica, em números."""
    with db.conn() as c:
        t = _tenant(c, x_tenant)
        m = METRICS.get(metric) if metric else None
        if m and m.module not in t["modules"]:
            m = None
        counts = c.execute(
            "select (select count(*) from warehouse.product where tenant_id = %(t)s) as products, "
            "(select count(*) from warehouse.state) as states, (select count(*) from warehouse.channel) as channels, "
            "(select count(*) from warehouse.daily_load where tenant_id = %(t)s and status = 'ok') "
            "as loads", {"t": x_tenant}).fetchone()
        return {"module": MODULES[m.module] if m else None, "metric": m.label if m else None, **counts}


# ── exemplos (specs escritas à mão) ─────────────────────────────────────────

@app.post("/api/examples/load")
def load_examples(x_tenant: str | None = Header(None)):
    out = []
    with db.conn() as c:
        _tenant(c, x_tenant)
        for f in sorted(EXAMPLES_DIR.glob("*.json")):
            spec = json.loads(f.read_text(encoding="utf-8"))
            r = _save(c, x_tenant, spec, None, "example", None)
            if isinstance(r, JSONResponse):
                errors = json.loads(r.body)["validation"]["errors"]
                out.append({"file": f.name, "saved": False, "errors": errors})
            else:
                out.append({"file": f.name, "saved": True, "id": r["id"]})
    return out


@app.exception_handler(ValidationError)
def _invalid_saved_spec(_req, e: ValidationError):
    return JSONResponse(status_code=500, content={"detail": "spec salva está inválida", "errors": e.errors()})


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
