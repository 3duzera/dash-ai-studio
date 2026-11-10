"""As portas: formato (schema) → sentido (catálogo e regras do kit) → edição (só ao mudar um rascunho)
→ dry-run (dado de verdade).

Cada erro sai como {blockId, path, message, hint}, em português, para o agente conseguir corrigir sozinho.
"""
import re

from pydantic import ValidationError

from .catalog import FILTERABLE, METRICS, PERIODS, metrics_for
from .query import dimension_values, run_block, tenant_info
from .spec import Spec, ValueFilter

MAX_BLOCKS = 20
PARAM_NAME = re.compile(r"^[a-z][a-z0-9_]{0,19}$")


def err(message, hint=None, block_id=None, path=None):
    return {"blockId": block_id, "path": path, "message": message, "hint": hint}


def validate_spec(c, tenant: str, raw, previous: dict | None = None, only_block: str | None = None) -> dict:
    """`previous` é a spec salva antes (edição); `only_block` restringe a edição a um bloco."""
    result = {"valid": False, "stage": "schema", "errors": [], "warnings": [], "blocks": {}}

    # ── porta 1: formato ─────────────────────────────────────────────────────
    try:
        spec = Spec.model_validate(raw)
    except ValidationError as e:
        result["errors"] = _schema_errors(e, raw)
        return result

    # ── porta 2: sentido ─────────────────────────────────────────────────────
    result["stage"] = "semantic"
    errors, warnings = semantic_errors(c, tenant, spec)
    result["warnings"] = warnings
    if errors:
        result["errors"] = errors
        return result

    # ── edição: o que já existia não some nem muda sem ser pedido ────────────
    if previous:
        result["stage"] = "edit"
        errors, warnings = edit_errors(previous, spec, only_block)
        result["warnings"] += warnings
        if errors:
            result["errors"] = errors
            return result

    # ── porta 3: dry-run ─────────────────────────────────────────────────────
    result["stage"] = "dry_run"
    for b in spec.blocks():
        r = run_block(c, tenant, spec, b)
        result["blocks"][b.id] = {"status": r["status"], "rows": r.get("row_count", 0)}
        if r["status"] == "error":
            result["errors"].append(err(f"o bloco deu erro ao consultar: {r['message']}", block_id=b.id))
        elif r["status"] == "empty":
            result["errors"].append(err(
                "o bloco não trouxe dado com os filtros e o período padrão",
                "amplie o período (ex.: last_30_days), tire filtros ou confira os valores com profile_data",
                block_id=b.id))
    result["valid"] = not result["errors"]
    return result


# ── porta 1: traduz os erros do Pydantic ─────────────────────────────────────

def _block_id_at(raw, loc):
    try:
        if loc[0] == "rows" and loc[2] == "blocks":
            return raw["rows"][loc[1]]["blocks"][loc[3]].get("id")
    except (IndexError, KeyError, TypeError, AttributeError):
        pass
    return None


def _schema_errors(e: ValidationError, raw) -> list[dict]:
    out, seen = [], set()
    for x in e.errors():
        loc = tuple(x["loc"])
        # Erros de union (filters) vêm repetidos, um por alternativa: fica o primeiro por caminho.
        clean = tuple(p for p in loc if p not in ("ValueFilter", "list[str]", "str")
                      and not (isinstance(p, str) and p.startswith("function")))
        if clean in seen:
            continue
        seen.add(clean)
        path = ".".join(str(p) for p in clean)
        t, ctx = x["type"], x.get("ctx") or {}
        field = clean[-1] if clean else ""
        if t == "extra_forbidden":
            msg, hint = f"o campo '{field}' não existe na spec", "remova o campo; veja os campos aceitos em get_kit"
        elif t == "missing":
            msg, hint = f"falta o campo obrigatório '{field}'", None
        elif t == "literal_error":
            msg = f"valor {x.get('input')!r} não é aceito em '{field}'"
            hint = f"use um destes: {ctx.get('expected')}"
        elif t in ("string_too_long", "too_long"):
            msg = f"'{field}' passou do tamanho máximo ({ctx.get('max_length')})"
            hint = "encurte o texto" if t == "string_too_long" else "use menos itens"
        elif t in ("string_too_short", "too_short"):
            msg, hint = f"'{field}' não pode ficar vazio", None
        elif t in ("greater_than_equal", "less_than_equal"):
            msg = f"'{field}' fora do intervalo permitido ({x['msg']})"
            hint = "span vai de 1 a 12; limit de 1 a 500" if field in ("span", "limit") else None
        elif t == "string_pattern_mismatch":
            msg = f"'{field}' em formato inválido: {x.get('input')!r}"
            hint = "id de bloco: minúsculas, números e hífen (ex.: 'receita-canal')"
        else:
            msg, hint = f"'{path}': {x['msg']}", None
        out.append(err(msg, hint, _block_id_at(raw, clean), path))
    return out


# ── porta 2: catálogo e regras do kit ───────────────────────────────────────

def _kind_rule(kind: str, dims: list[str]) -> str | None:
    non_day = [d for d in dims if d != "day"]
    if kind in ("kpi", "kpi_progress"):
        return None if not dims else f"{kind} mostra um número só: não aceita dimensões"
    if kind == "ranking_bar":
        return None if len(dims) == 1 and dims[0] != "day" else "ranking_bar precisa de exatamente 1 dimensão, que não seja day"
    if kind == "bar":
        return None if "day" not in dims and 1 <= len(non_day) <= 2 else "bar precisa de 1 ou 2 dimensões (a 2ª vira série), sem day"
    if kind == "line":
        return None if "day" in dims and len(dims) <= 2 else "line precisa da dimensão day e, no máximo, mais 1 (que vira série)"
    if kind == "table":
        return None if 1 <= len(dims) <= 3 else "table precisa de 1 a 3 dimensões"
    if kind == "heatmap":
        return None if len(dims) == 2 and "day" not in dims else "heatmap precisa de exatamente 2 dimensões (linhas × colunas), sem day"
    return None


def semantic_errors(c, tenant: str, spec: Spec):
    errors, warnings = [], []
    t = tenant_info(c, tenant)
    available = metrics_for(t["modules"])
    values_cache = {}

    def known(dim):
        if dim not in values_cache:
            values_cache[dim] = dimension_values(c, tenant, dim)
        return values_cache[dim]

    def check_ids(dim, ids, block_id, path):
        valid = {v["id"] for v in known(dim)}
        bad = [i for i in ids if i not in valid]
        if bad:
            sample = ", ".join(f"{v['id']} ({v['label']})" for v in known(dim)[:12])
            errors.append(err(f"{dim}: valor(es) que não existem: {', '.join(bad)}",
                              f"use ids existentes, por exemplo: {sample}", block_id, path))

    # grade
    blocks = list(spec.blocks())
    if len(blocks) > MAX_BLOCKS:
        errors.append(err(f"a spec tem {len(blocks)} blocos; o máximo é {MAX_BLOCKS}", "junte ou remova blocos"))
    for i, row in enumerate(spec.rows):
        total = sum(b.span for b in row.blocks)
        if total != 12:
            errors.append(err(f"a linha {i + 1} soma {total} colunas; cada linha precisa somar 12",
                              "ajuste o span dos blocos da linha", row.blocks[0].id, f"rows.{i}"))
    ids = [b.id for b in blocks]
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        errors.append(err(f"o id '{dup}' aparece mais de uma vez", "cada bloco precisa de um id único", dup))

    # params
    for name, p in spec.params.items():
        path = f"params.{name}"
        if not PARAM_NAME.match(name):
            errors.append(err(f"nome de param inválido: '{name}'", "minúsculas, números e _ (ex.: state)", path=path))
        if p.type == "period":
            if not isinstance(p.default, str) or p.default not in PERIODS:
                errors.append(err(f"período padrão inválido: {p.default!r}", f"use um de: {', '.join(PERIODS)}", path=path))
        else:
            check_ids(p.type, [p.default] if isinstance(p.default, str) else p.default, None, path)
    used = set()

    # blocos
    for b in blocks:
        q, path = b.query, f"block.{b.id}.query"
        m = available.get(q.metric)
        if not m:
            if q.metric in METRICS:
                msg = f"a métrica '{q.metric}' é de um módulo que este cliente não contratou"
            else:
                msg = f"a métrica '{q.metric}' não existe no catálogo"
            errors.append(err(msg, f"métricas disponíveis: {', '.join(available)}", b.id, f"{path}.metric"))
            continue

        bad_dims = [d for d in q.dimensions if d not in m.dimensions]
        if bad_dims:
            errors.append(err(f"a métrica '{m.id}' não aceita a(s) dimensão(ões): {', '.join(bad_dims)}",
                              f"dimensões aceitas: {', '.join(m.dimensions)}", b.id, f"{path}.dimensions"))
        if len(set(q.dimensions)) != len(q.dimensions):
            errors.append(err("dimensão repetida", None, b.id, f"{path}.dimensions"))
        rule = _kind_rule(b.kind, q.dimensions)
        if rule:
            errors.append(err(rule, "troque o kind ou ajuste as dimensões (veja get_kit)", b.id, f"{path}.dimensions"))

        for key, val in q.filters.items():
            fpath = f"{path}.filters.{key}"
            if key == "value":
                if b.kind not in ("ranking_bar", "bar", "table"):
                    errors.append(err("filters.value só vale em ranking_bar, bar e table", None, b.id, fpath))
                elif not isinstance(val, ValueFilter):
                    errors.append(err("filters.value precisa ser um objeto como {\"gt\": 0}", None, b.id, fpath))
                continue
            if key not in FILTERABLE:
                errors.append(err(f"não dá para filtrar por '{key}'",
                                  f"filtros aceitos: {', '.join(FILTERABLE)} e value", b.id, fpath))
                continue
            if isinstance(val, ValueFilter):
                errors.append(err(f"filters.{key} precisa ser um id, uma lista de ids ou '$param'", None, b.id, fpath))
            elif isinstance(val, str) and val.startswith("$"):
                pname = val[1:]
                used.add(pname)
                p = spec.params.get(pname)
                if not p:
                    errors.append(err(f"o param '{val}' não foi declarado em params",
                                      f"declare params.{pname} com type '{key}' ou use um valor fixo", b.id, fpath))
                elif p.type != key:
                    errors.append(err(f"o param '{val}' é do tipo '{p.type}', mas o filtro é de '{key}'", None, b.id, fpath))
            else:
                check_ids(key, [val] if isinstance(val, str) else val, b.id, fpath)

        if m.fixed_period and q.period:
            errors.append(err(f"a métrica '{m.id}' tem período fixo e não aceita period",
                              "remova o campo period deste bloco", b.id, f"{path}.period"))
        elif q.period and q.period.startswith("$"):
            pname = q.period[1:]
            used.add(pname)
            p = spec.params.get(pname)
            if not p or p.type != "period":
                errors.append(err(f"o param '{q.period}' precisa existir em params com type 'period'", None, b.id, f"{path}.period"))
        elif q.period and q.period not in PERIODS:
            errors.append(err(f"período inválido: '{q.period}'",
                              f"use um período relativo: {', '.join(PERIODS)} (datas fixas não existem)", b.id, f"{path}.period"))

        if q.of:
            if b.kind != "kpi_progress":
                errors.append(err("o campo 'of' só vale em kpi_progress", None, b.id, f"{path}.of"))
            elif q.of not in available or available[q.of].unit != "count":
                errors.append(err(f"'of' precisa ser uma métrica de contagem do catálogo: '{q.of}' não serve",
                                  "ex.: orders_on_time com of: orders_delivered", b.id, f"{path}.of"))
        elif b.kind == "kpi_progress" and m.unit != "percent":
            errors.append(err("kpi_progress precisa de 'of' (o total) ou de uma métrica em %",
                              "ex.: of: orders_delivered", b.id, f"{path}.of"))

        if q.columns:
            if b.kind != "table":
                errors.append(err("o campo 'columns' só vale em table", None, b.id, f"{path}.columns"))
            for col in q.columns:
                cm = available.get(col)
                if not cm:
                    errors.append(err(f"'columns' cita uma métrica que não existe: '{col}'", None, b.id, f"{path}.columns"))
                elif any(d not in cm.dimensions for d in q.dimensions):
                    errors.append(err(f"a métrica '{col}' não aceita as dimensões deste bloco",
                                      f"dimensões aceitas por {col}: {', '.join(cm.dimensions)}", b.id, f"{path}.columns"))
        if q.sort and b.kind not in ("ranking_bar", "bar", "table"):
            errors.append(err("sort só vale em ranking_bar, bar e table", None, b.id, f"{path}.sort"))

    for name in spec.params:
        if name not in used:
            warnings.append(err(f"o param '{name}' foi declarado mas nenhum bloco usa", path=f"params.{name}"))
    return errors, warnings


# ── edição: o que já existia não muda sem pedido ───────────────────────────────────

def edit_errors(previous: dict, spec: Spec, only_block: str | None):
    """Com only_block, os outros blocos ficam iguais e na mesma ordem (só o span pode mudar, para a
    linha fechar 12). Sem only_block, um bloco que sumiu vira aviso: pode ter sido pedido."""
    errors, warnings = [], []
    try:
        before = list(Spec.model_validate(previous).blocks())
    except ValidationError:
        return errors, warnings   # spec antiga inválida: não há o que comparar
    now = {b.id: b for b in spec.blocks()}
    order_now = [b.id for b in spec.blocks()]

    if only_block:
        kept = [b for b in before if b.id != only_block]
        for b in kept:
            nb = now.get(b.id)
            if nb is None:
                errors.append(err(f"o bloco '{b.id}' sumiu, mas a edição era só do bloco '{only_block}'",
                                  f"devolva o bloco '{b.id}' como estava", b.id))
            elif nb.model_dump(exclude={"span"}) != b.model_dump(exclude={"span"}):
                changed = [k for k, v in b.model_dump(exclude={"span"}).items() if nb.model_dump()[k] != v]
                errors.append(err(f"o bloco '{b.id}' mudou ({', '.join(changed)}), mas a edição era só do "
                                  f"bloco '{only_block}'", f"deixe '{b.id}' exatamente como estava", b.id))
        present = [b.id for b in kept if b.id in now]
        if [i for i in order_now if i in present] != present:
            errors.append(err(f"a ordem dos outros blocos mudou, mas a edição era só do bloco '{only_block}'",
                              "mantenha a ordem dos demais blocos"))
        return errors, warnings

    gone = [b.id for b in before if b.id not in now]
    if gone:
        warnings.append(err(f"blocos removidos nesta edição: {', '.join(gone)}",
                            "confirme que a remoção foi pedida; para trocar um bloco, mantenha o id"))
    return errors, warnings
