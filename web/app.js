// A casca da página: cliente, tema, rotas, lista de dashboards e visualização. O Studio fica em studio.js.
// O navegador nunca manda query: só blockId + params (ver POST /api/dashboards/{id}/blocks/{blockId}/query).
//
// Rotas (hash):  #/  lista · #/d/<id>  visualização · #/studio  novo · #/studio/<d-… ou s-…>  Studio
//                #/studio/<d-…>/preview  pré-visualização

// A porta do agente vem da API (/api/config), para dar para trocar no compose sem mexer aqui.
let AGENT_URL = `${location.protocol}//${location.hostname}:8100`;
const $ = (s, root = document) => root.querySelector(s);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem storage, segue sem lembrar */ } },
};

const state = {
  tenant: null,
  options: {},     // valores possíveis por tipo de param (cache por cliente)
  catalog: null,   // catálogo público do cliente (rótulos das métricas)
};

const KIND_LABEL = {
  kpi: "Número", kpi_progress: "X de Y", ranking_bar: "Ranking", bar: "Barras",
  line: "Linha", table: "Tabela", heatmap: "Mapa de calor",
};
const VIA_LABEL = { agent: "assistente", manual: "à mão", example: "exemplo" };

// ── utilidades ───────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { "X-Tenant": state.tenant, "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok && r.status !== 422) throw new Error(data?.detail || `HTTP ${r.status}`);
  return { status: r.status, data };
}

// h("div", {class: "x", onclick: fn}, "texto", outroNó)
function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), 4000);
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `há ${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

async function catalog() {
  if (!state.catalog) state.catalog = (await api("/catalog")).data;
  return state.catalog;
}

async function options(type) {
  if (!state.options[type]) state.options[type] = (await api(`/dimensions/${type}`)).data;
  return state.options[type];
}

// Lê um corpo SSE ("data: {...}\n\n") e chama onEvent para cada evento.
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, k);
      buf = buf.slice(k + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

// ── peças compartilhadas: barra de filtros e grade ───────────────────────────
async function ParamsBar(spec, overrides, onChange) {
  const box = h("div", { class: "params" });
  for (const [name, p] of Object.entries(spec.params || {})) {
    const opts = await options(p.type);
    const wrap = h("div", { class: "p" }, h("span", {}, p.label || name));
    const current = overrides[name] ?? p.default;
    if (p.type === "period") {
      const sel = h("select", {}, opts.map((o) => h("option", { value: o.id }, o.label)));
      sel.value = current;
      sel.onchange = () => { overrides[name] = sel.value; onChange(); };
      wrap.append(sel);
    } else {
      const chosen = new Set(Array.isArray(current) ? current : [current]);
      const summary = h("summary");
      const label = () => {
        if (chosen.size === 0) return "Todos";
        const names = opts.filter((o) => chosen.has(o.id)).map((o) => o.label);
        return names.length > 2 ? `${names.slice(0, 2).join(", ")} · +${names.length - 2}` : names.join(", ");
      };
      summary.textContent = label();
      const menu = h("div", { class: "menu" });
      for (const o of opts) {
        const cb = h("input", { type: "checkbox" });
        cb.checked = chosen.has(o.id);
        cb.onchange = () => {
          cb.checked ? chosen.add(o.id) : chosen.delete(o.id);
          summary.textContent = label();
          overrides[name] = [...chosen];
          onChange();
        };
        menu.append(h("label", {}, cb, h("span", {}, o.label)));
      }
      wrap.append(h("details", { class: "multi" }, summary, menu));
    }
    box.append(wrap);
  }
  box.fresh = h("div", { class: "fresh" });
  box.append(box.fresh);
  return box;
}

const freshText = (res) => `Atualizado em ${Fmt.dateTime(res.materialized_at)} · carga diária`;

// Desenha a spec na grade de 12 colunas. Cada bloco busca o próprio dado.
// decorate(card, block) acrescenta controles (Studio); load(block) troca a busca padrão.
function renderGrid(grid, { dashId, spec, version = "draft", overrides = {}, decorate, load, onFresh }) {
  disposeCharts();
  grid.innerHTML = "";
  let freshShown = false;
  for (const row of spec.rows) {
    const r = h("div", { class: "row" });
    grid.append(r);
    for (const block of row.blocks) {
      const card = h("div");
      card.style.gridColumn = `span ${block.span}`;
      r.append(card);
      const fetchData = load ? () => load(block) : async () => (await api(`/dashboards/${dashId}/blocks/${block.id}/query`, {
        method: "POST", body: { params: overrides, version },
      })).data;
      renderBlock(card, block, fetchData).then((res) => {
        if (!freshShown && res?.materialized_at && onFresh) { freshShown = true; onFresh(res); }
      });
      decorate?.(card, block);
    }
  }
}

// ── tema e cliente ───────────────────────────────────────────────────────────
let currentView = null;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set("dash-mvp-theme", theme);
}
$("#theme").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  currentView?.rerender?.();
};

async function init() {
  const forced = new URLSearchParams(location.search).get("theme");
  applyTheme(forced || store.get("dash-mvp-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (cfg.agent_port) AGENT_URL = `${location.protocol}//${location.hostname}:${cfg.agent_port}`;
  const tenants = await fetch("/api/tenants").then((r) => r.json());
  const sel = $("#tenant");
  sel.innerHTML = tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} · ${escapeHtml(t.segment)}${t.modules.includes("operations") ? "" : " (sem Operação)"}</option>`).join("");
  state.tenant = tenants.some((t) => t.id === store.get("dash-mvp-tenant")) ? store.get("dash-mvp-tenant") : tenants[0].id;
  sel.value = state.tenant;
  sel.onchange = () => {
    state.tenant = sel.value;
    store.set("dash-mvp-tenant", sel.value);
    state.options = {};
    state.catalog = null;
    if (location.hash === "#/" || location.hash === "") route();
    else location.hash = "#/";
  };
  window.addEventListener("hashchange", route);
  await route();
}

// ── rotas ────────────────────────────────────────────────────────────────────
async function route() {
  currentView?.dispose?.();
  currentView = null;
  disposeCharts();
  const legacy = location.hash.match(/^#(d-[0-9a-f]+)$/);   // links antigos: #d-xxxx
  if (legacy) return location.replace(`#/d/${legacy[1]}`);
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const root = $("#view");
  root.innerHTML = "";
  document.body.dataset.route = parts[0] === "studio" ? (parts[2] === "preview" ? "preview" : "studio") : parts[0] === "d" ? "view" : "list";
  try {
    if (!parts.length) currentView = await ListView(root);
    else if (parts[0] === "d" && parts[1]) currentView = await DashView(root, parts[1]);
    else if (parts[0] === "studio" && parts[2] === "preview") currentView = await Studio.preview(root, parts[1]);
    else if (parts[0] === "studio") currentView = await Studio.open(root, parts[1] || null);
    else location.replace("#/");
  } catch (e) {
    console.error(e);
    root.innerHTML = "";
    root.append(h("div", { class: "empty-state" },
      h("h1", {}, "Não deu para abrir"), h("p", {}, e.message), h("a", { class: "btn", href: "#/" }, "Voltar para a lista")));
  }
}

// ── lista (tela 1 do Figma) ──────────────────────────────────────────────────
const LIST_TABS = [
  ["all", "Todos", () => true],
  ["team", "Do time", (d) => d.status === "published" && d.visibility === "team"],
  ["individual", "Individuais", (d) => d.status === "published" && d.visibility === "individual"],
  ["drafts", "Rascunhos", (d) => d.status === "draft"],
];

function typeBadge(d) {
  if (d.status === "draft") return h("span", { class: "badge draft" }, "rascunho");
  return h("span", { class: `badge ${d.visibility === "individual" ? "individual" : "team"}` }, d.visibility === "individual" ? "individual" : "do time");
}

async function ListView(root) {
  const { data: all } = await api("/dashboards");
  let tab = LIST_TABS.some(([k]) => k === store.get("dash-mvp-tab")) ? store.get("dash-mvp-tab") : "all";
  const tabs = h("div", { class: "tabs" });
  const body = h("tbody");

  function draw() {
    tabs.innerHTML = "";
    for (const [key, label, fn] of LIST_TABS) {
      tabs.append(h("button", {
        class: key === tab ? "on" : "",
        onclick: () => { tab = key; store.set("dash-mvp-tab", key); draw(); },
      }, label, h("span", { class: "count" }, all.filter(fn).length)));
    }
    body.innerHTML = "";
    const rows = all.filter(LIST_TABS.find(([k]) => k === tab)[2]);
    if (!rows.length) {
      body.append(h("tr", { class: "empty" }, h("td", { colspan: 5 }, all.length
        ? "Nada nesta aba."
        : "Nenhum dashboard ainda. Crie o primeiro com o assistente.")));
    }
    for (const d of rows) {
      const href = d.status === "draft" ? `#/studio/${d.id}` : `#/d/${d.id}`;
      body.append(h("tr", { onclick: () => { location.hash = href; } },
        h("td", {},
          h("a", { class: "name", href }, d.title),
          h("div", { class: "meta" }, `${d.blocks} blocos · ${VIA_LABEL[d.created_via] || d.created_via}`,
            d.has_unpublished_changes ? h("span", { class: "dot-note" }, "alterações não publicadas") : null)),
        h("td", {}, typeBadge(d)),
        h("td", {}, h("span", { class: "author" }, h("span", { class: "avatar" }, "VC"), "Você")),
        h("td", { class: "muted" }, d.status === "published" ? "diária" : "—"),
        h("td", { class: "muted", title: new Date(d.updated_at).toLocaleString("pt-BR") }, timeAgo(d.updated_at))));
    }
  }

  const loadExamples = async () => {
    const { data } = await api("/examples/load", { method: "POST" });
    const bad = data.filter((r) => !r.saved);
    toast(`${data.length - bad.length} exemplo(s) carregado(s)` + (bad.length ? `; recusado(s): ${bad.map((b) => b.file).join(", ")} (${bad[0].errors[0].message})` : ""));
    route();
  };

  root.append(h("div", { class: "page list-page" },
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "Dashboards"),
        h("p", { class: "sub" }, "Painéis montados com o assistente a partir do catálogo de métricas. Atualizam a cada carga diária.")),
      h("a", { class: "btn primary", href: "#/studio" }, "+ Novo dashboard")),
    tabs,
    h("div", { class: "table-card" }, h("table", { class: "list" },
      h("thead", {}, h("tr", {}, ["Nome", "Tipo", "Autor", "Frequência", "Atualizado"].map((t) => h("th", {}, t)))),
      body)),
    h("div", { class: "mvp-tools" }, h("span", {}, "Ferramentas do MVP:"),
      h("button", { class: "btn small", onclick: loadExamples }, "Carregar exemplos"),
      h("button", { class: "btn small", onclick: () => openSpec(BLANK, null, { onSaved: (d) => { location.hash = `#/studio/${d.id}`; } }) }, "Spec à mão"))));
  draw();
  return {};
}

// ── visualização (tela 2 do Figma) ───────────────────────────────────────────
async function DashView(root, id) {
  const { data: d } = await api(`/dashboards/${id}`);
  const published = Boolean(d.published_spec);
  const spec = published ? d.published_spec : d.spec;
  const version = published ? "published" : "draft";
  const overrides = {};
  const grid = h("div", { class: "grid" });
  const bar = await ParamsBar(spec, overrides, () => draw());
  const draw = () => renderGrid(grid, {
    dashId: id, spec, version, overrides, onFresh: (res) => { bar.fresh.textContent = freshText(res); },
  });

  const share = async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copiado."); } catch { toast(location.href); }
  };
  const remove = async () => {
    if (!confirm(`Excluir "${d.title}"? A conversa do Studio vai junto.`)) return;
    await api(`/dashboards/${id}`, { method: "DELETE" });
    location.hash = "#/";
  };

  let note = null;
  if (!published) note = h("div", { class: "note warn" }, "Rascunho: ainda não publicado. ", h("a", { href: `#/studio/${id}` }, "Abrir no Studio"), " para terminar e publicar.");
  else if (d.has_unpublished_changes) note = h("div", { class: "note" }, "Há mudanças feitas no Studio que ainda não foram publicadas. Esta é a versão que o time vê.");

  root.append(h("div", { class: "page view-page" },
    h("div", { class: "crumbs" }, h("a", { href: "#/" }, "Dashboards"), h("span", {}, "/"), h("span", {}, spec.title)),
    h("div", { class: "view-head" },
      h("div", { class: "titles" },
        h("h1", {}, spec.title),
        spec.subtitle ? h("div", { class: "sub" }, spec.subtitle) : null,
        h("div", { class: "badges" }, typeBadge(d), h("span", { class: "badge" }, VIA_LABEL[d.created_via] || d.created_via))),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => window.print() }, "Exportar PDF"),
        h("button", { class: "btn", onclick: share }, "Compartilhar"),
        h("a", { class: "btn primary", href: `#/studio/${id}` }, "Editar"),
        h("button", { class: "btn ghost danger", onclick: remove, title: "Excluir" }, "Excluir"))),
    note, bar, grid));
  draw();
  return { rerender: draw };
}

// ── publicar ─────────────────────────────────────────────────────────────────
function publishDialog(dashId) {
  const dlg = $("#pub-dlg");
  const current = dlg.querySelector('input[name="vis"]:checked');
  if (!current) dlg.querySelector('input[value="team"]').checked = true;
  dlg.showModal();
  return new Promise((resolve) => {
    $("#pub-cancel").onclick = () => { dlg.close(); resolve(null); };
    $("#pub-ok").onclick = async () => {
      const visibility = dlg.querySelector('input[name="vis"]:checked').value;
      const { data } = await api(`/dashboards/${dashId}/publish`, { method: "POST", body: { visibility } });
      dlg.close();
      toast(visibility === "team" ? "Publicado para o time." : "Publicado só para você.");
      resolve(data);
    };
  });
}

// ── spec à mão (depuração) ───────────────────────────────────────────────────
const dlg = $("#spec-dlg");
const BLANK = {
  schemaVersion: 1, kitVersion: "mvp-1", title: "Novo dashboard",
  params: { period: { type: "period", default: "last_30_days", label: "Período" } },
  rows: [{ blocks: [{ id: "bloco-1", kind: "kpi", span: 12, title: "Produtos monitorados",
    query: { metric: "products_monitored", period: "$period" } }] }],
};
let specCtx = {};

// opts: {onSaved(dashboard), sessionId}
function openSpec(spec, editingId, opts = {}) {
  specCtx = { editingId, ...opts };
  $("#spec-dlg-title").textContent = editingId ? `Spec de ${editingId}` : "Nova spec";
  $("#spec-text").value = JSON.stringify(spec, null, 2);
  $("#spec-save").disabled = !editingId;
  $("#spec-result").innerHTML = "<p>Valide para ver as portas: formato, sentido, edição e dry-run.</p>";
  dlg.showModal();
}
$("#spec-close").onclick = () => dlg.close();

function parseSpec() {
  try {
    return JSON.parse($("#spec-text").value);
  } catch (e) {
    $("#spec-result").innerHTML = `<p class="bad">JSON inválido</p><p>${escapeHtml(e.message)}</p>`;
    return null;
  }
}

function showValidation(v) {
  const stage = { schema: "1 · formato", semantic: "2 · sentido", edit: "edição", dry_run: "3 · dry-run" }[v.stage];
  let html = v.valid ? `<p class="ok">Válida</p>` : `<p class="bad">Recusada na porta ${stage}</p>`;
  if (v.errors.length) {
    html += "<ul>" + v.errors.map((e) => `<li>${e.blockId ? `<b>${escapeHtml(e.blockId)}</b>: ` : ""}${escapeHtml(e.message)}${e.hint ? `<span class="hint">${escapeHtml(e.hint)}</span>` : ""}</li>`).join("") + "</ul>";
  }
  if (v.warnings?.length) html += "<p>Avisos:</p><ul>" + v.warnings.map((w) => `<li>${escapeHtml(w.message)}</li>`).join("") + "</ul>";
  const blocks = Object.entries(v.blocks || {});
  if (blocks.length) html += "<p>Dry-run:</p><ul>" + blocks.map(([id, b]) => `<li>${escapeHtml(id)}: ${b.status} (${b.rows} linhas)</li>`).join("") + "</ul>";
  $("#spec-result").innerHTML = html;
}

$("#spec-validate").onclick = async () => {
  const spec = parseSpec();
  if (spec) showValidation((await api("/validate", { method: "POST", body: { spec, draft_id: specCtx.editingId || null } })).data);
};

async function saveSpec(asNew) {
  const spec = parseSpec();
  if (!spec) return;
  const id = specCtx.editingId;
  const { status, data } = asNew || !id
    ? await api("/drafts", { method: "POST", body: { spec, created_via: "manual" } })
    : await api(`/drafts/${id}`, { method: "PUT", body: { spec, session_id: specCtx.sessionId || null, edit_note: specCtx.sessionId ? "editou a spec JSON à mão" : null } });
  if (status === 422) return showValidation(data.validation);
  dlg.close();
  toast("Rascunho salvo.");
  specCtx.onSaved?.(data, asNew || !id);
}
$("#spec-save").onclick = () => saveSpec(false);
$("#spec-save-new").onclick = () => saveSpec(true);

window.addEventListener("load", () => {
  init().catch((e) => {
    document.body.insertAdjacentHTML("afterbegin", `<p style="padding:12px;color:#b91c1c">Erro ao iniciar: ${escapeHtml(e.message)}</p>`);
  });
});
