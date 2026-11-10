"""Sessão do Studio: a conversa de um dashboard, guardada aqui e lida pela dash-ai a cada turno.

A dash-ai (agent/server.mjs) não toca no banco: ela monta o contexto de cada turno a partir de
GET /api/studio/sessions/{id} e grava pedido e resposta por POST .../messages.
"""
import secrets

from psycopg.types.json import Jsonb

ROLES = ("user", "assistant", "choices", "answers", "manual", "note")
LOCK_MINUTES = 7   # um turno passa de 6 min só se travou; depois disso o lock vale como solto


def create(c, tenant: str, dashboard_id: str | None = None, model: str | None = None) -> dict:
    return c.execute(
        "insert into dashboards.studio_session (tenant_id, id, dashboard_id, model) values (%s, %s, %s, %s) "
        "returning *", (tenant, "s-" + secrets.token_hex(4), dashboard_id, model)).fetchone()


def find(c, tenant: str, session_id: str) -> dict | None:
    return c.execute("select * from dashboards.studio_session where tenant_id = %s and id = %s",
                     (tenant, session_id)).fetchone()


def for_dashboard(c, tenant: str, dashboard_id: str) -> dict:
    """A sessão mais recente do dashboard; cria uma se ele nunca foi aberto no Studio."""
    row = c.execute(
        "select * from dashboards.studio_session where tenant_id = %s and dashboard_id = %s "
        "order by updated_at desc limit 1", (tenant, dashboard_id)).fetchone()
    return row or create(c, tenant, dashboard_id)


def messages(c, session_id: str, limit: int = 60) -> list[dict]:
    rows = c.execute(
        "select * from (select id, role, content, run, created_at from dashboards.studio_message "
        "where session_id = %s order by id desc limit %s) m order by id", (session_id, limit)).fetchall()
    return [{**r, "created_at": r["created_at"].isoformat()} for r in rows]


def add_message(c, session_id: str, role: str, content: dict, run: dict | None = None) -> dict:
    row = c.execute(
        "insert into dashboards.studio_message (session_id, role, content, run) values (%s, %s, %s, %s) "
        "returning id, role, content, run, created_at",
        (session_id, role, Jsonb(content), Jsonb(run) if run else None)).fetchone()
    c.execute("update dashboards.studio_session set updated_at = now() where id = %s", (session_id,))
    return {**row, "created_at": row["created_at"].isoformat()}


def link_dashboard(c, session_id: str, dashboard_id: str):
    c.execute("update dashboards.studio_session set dashboard_id = %s, updated_at = now() "
              "where id = %s and dashboard_id is null", (dashboard_id, session_id))


def lock(c, tenant: str, session_id: str, model: str | None) -> bool:
    """Um turno por vez. Devolve False se outro turno está rodando."""
    row = c.execute(
        "update dashboards.studio_session set status = 'running', locked_at = now(), "
        "model = coalesce(%s, model), updated_at = now() "
        "where tenant_id = %s and id = %s "
        f"and (status = 'idle' or locked_at < now() - interval '{LOCK_MINUTES} minutes') returning id",
        (model, tenant, session_id)).fetchone()
    return row is not None


def unlock(c, tenant: str, session_id: str):
    c.execute("update dashboards.studio_session set status = 'idle', locked_at = null, updated_at = now() "
              "where tenant_id = %s and id = %s", (tenant, session_id))


def summary(row: dict) -> dict:
    return {
        "id": row["id"], "dashboard_id": row["dashboard_id"], "status": row["status"], "model": row["model"],
        "created_at": row["created_at"].isoformat(), "updated_at": row["updated_at"].isoformat(),
    }
