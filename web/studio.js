// O Studio (telas 3, 4 e 5 do Figma): conversa com o assistente + canvas editável à mão.
//
// A spec salva é a fonte da verdade. Edição manual e edição pelo agente mexem na mesma spec e passam pela
// mesma validação da API. A conversa fica no banco (sessão do Studio): recarregar a página traz tudo de volta.
// Cada edição manual salva vai com uma nota (edit_note), que o agente recebe no turno seguinte.

const Studio = (() => {
  let S = null;   // a instância aberta (null quando a rota muda)

  const SPANS = [3, 4, 6, 8, 9, 12];
  const SLOT_LABEL = { metric: "Métrica", dimensions: "Dimensões", period: "Período", visualization: "Visualização" };
  const TOOL_LABEL = {
    get_kit: "Leu o kit de blocos", get_catalog: "Leu o catálogo de métricas", profile_data: "Olhou o perfil do dado",
    validate_spec: "Validou a spec", save_draft: "Salvou o rascunho", get_draft: "Leu o rascunho",
    propose_options: "Preparou perguntas",
  };
  const SUGGESTIONS = [
    "Receita por canal e a evolução diária",
    "Em que estados as entregas mais atrasam, por canal",
    "Quais categorias caíram nesta semana",
    "Clientes novos e recompra por segmento",
    "Quero acompanhar as vendas",
  ];

  // ── layout: empacota blocos em linhas que somam 12 ─────────────────────────
  const blocksOf = (spec) => spec.rows.flatMap((r) => r.blocks);

  // Linhas de até 4 blocos que somam 12. Se sobra espaço, puxa o próximo bloco para o lado (com a largura que
  // sobrou) ou alarga o último bloco da linha. `pinned` é o bloco que a pessoa acabou de mexer: ele não muda.
  function pack(blocks, pinned = null) {
    const queue = blocks.map((b) => ({ ...b, span: Math.min(12, Math.max(1, b.span)) }));
    const rows = [];
    while (queue.length) {
      const row = [];
      let sum = 0;
      while (queue.length && row.length < 4 && sum + queue[0].span <= 12) {
        const b = queue.shift();
        row.push(b);
        sum += b.span;
      }
      let left = 12 - sum;
      if (left >= 3 && queue.length && row.length < 4 && queue[0].id !== pinned) {
        const b = queue.shift();
        row.push({ ...b, span: left });
        left = 0;
      }
      if (left > 0) {
        const target = [...row].reverse().find((b) => b.id !== pinned) || row[row.length - 1];
        target.span += left;
      }
      rows.push({ blocks: row });
    }
    return rows;
  }

  // Muda a largura de um bloco tirando ou dando espaço ao vizinho da mesma linha; se não couber, reempacota.
  function setSpan(spec, id, span) {
    const row = spec.rows.find((r) => r.blocks.some((b) => b.id === id));
    const b = row.blocks.find((x) => x.id === id);
    let delta = span - b.span;
    b.span = span;
    const others = row.blocks.filter((x) => x !== b);
    const i = row.blocks.indexOf(b);
    const order = [...row.blocks.slice(i + 1), ...row.blocks.slice(0, i).reverse()];
    if (delta > 0) {
      for (const n of order) {
        const take = Math.min(delta, n.span - 3);
        if (take > 0) { n.span -= take; delta -= take; }
      }
    } else if (delta < 0 && others.length) {
      order[0].span -= delta;
      delta = 0;
    }
    spec.rows = pack(blocksOf(spec), id);
  }

  function compatibleKinds(block) {
    const dims = block.query.dimensions || [];
    const nonDay = dims.filter((d) => d !== "day");
    if (dims.includes("day")) return ["line", "table"];
    if (!dims.length) return ["kpi", "kpi_progress"];
    if (nonDay.length === 1) return ["ranking_bar", "bar", "table"];
    return ["bar", "heatmap", "table"];
  }

  // ── abrir ──────────────────────────────────────────────────────────────────
  async function open(root, ref) {
    S = {
      root, sessionId: null, draft: null, spec: null, savedSpec: null, messages: [],
      running: false, live: null, selected: null, tab: "canvas", picks: {}, picksFor: null,
      autosave: store.get("studio-autosave") !== "0", pending: [], saving: Promise.resolve(), savedAt: null,
      model: store.get("studio-model") || "sonnet", overrides: {}, abort: null, el: {},
    };
    if (ref?.startsWith("d-")) S.sessionId = (await api(`/dashboards/${ref}/session`)).data.id;
    else if (ref?.startsWith("s-")) S.sessionId = ref;
    await catalog();
    if (S.sessionId) await reload();
    render();
    const me = S;
    return {
      rerender: () => { if (S === me) drawCanvas(); },
      dispose: () => { me.abort?.abort(); if (S === me) S = null; },
    };
  }

  async function reload() {
    const { data } = await api(`/studio/sessions/${S.sessionId}`);
    S.messages = data.messages;
    S.draft = data.draft;
    S.spec = data.draft ? structuredClone(data.draft.spec) : null;
    S.savedSpec = data.draft ? structuredClone(data.draft.spec) : null;
    S.pending = [];
  }

  function render() {
    S.root.innerHTML = "";
    if (!S.messages.length && !S.draft) return renderEmpty();
    renderWorkspace();
  }

  // ── topo do Studio ─────────────────────────────────────────────────────────
  function topBar() {
    const top = h("div", { class: "studio-top" });
    S.el.top = top;
    drawTop();
    return top;
  }

  function drawTop() {
    const top = S.el.top;
    if (!top) return;
    top.innerHTML = "";
    const title = h("input", {
      class: "st-title", value: S.spec?.title || "Novo dashboard", disabled: !S.spec, maxlength: 80,
      title: "Título do dashboard",
    });
    const fit = () => { title.style.width = `${Math.min(64, Math.max(14, title.value.length + 2))}ch`; };
    fit();
    title.oninput = fit;
    title.onkeydown = (e) => { if (e.key === "Enter") title.blur(); };
    title.onchange = () => {
      const v = title.value.trim();
      if (!v || v === S.spec.title) { title.value = S.spec.title; return; }
      applyEdit((spec) => { spec.title = v; }, `mudou o título do dashboard para "${v}"`);
    };
    let status = "Novo";
    if (S.draft) {
      status = S.draft.status === "published" ? (S.draft.has_unpublished_changes ? "Publicado · com alterações" : "Publicado") : "Rascunho";
      if (S.pending.length && !S.autosave) status += ` · ${S.pending.length} edição(ões) não salva(s)`;
      else if (S.savedAt) status += ` · salvo às ${S.savedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    }
    const auto = h("input", { type: "checkbox" });
    auto.checked = S.autosave;
    auto.onchange = async () => {
      S.autosave = auto.checked;
      store.set("studio-autosave", auto.checked ? "1" : "0");
      if (S.autosave) await save();
      drawTop();
    };
    top.append(...[
      h("a", { class: "back", href: "#/", title: "Voltar para a lista" }, "← Dashboards"),
      h("div", { class: "st-titles" }, title, h("small", {}, status)),
      h("div", { class: "spacer" }),
      h("label", { class: "switch" }, auto, h("span", {}, "Salvamento automático")),
      !S.autosave ? h("button", { class: "btn", disabled: !S.pending.length, onclick: async () => { await save(); } }, "Salvar") : null,
      h("button", { class: "btn", disabled: !S.draft, onclick: async () => {
        if (!(await flush())) return;
        location.hash = `#/studio/${S.draft.id}/preview`;
      } }, "Pré-visualizar"),
      h("button", { class: "btn primary", disabled: !S.draft || S.running, onclick: async () => {
        if (!(await flush())) return;
        const id = S.draft.id;
        if (await publishDialog(id)) location.hash = `#/d/${id}`;
      } }, "Publicar"),
    ].filter(Boolean));
  }

  // ── Studio vazio (tela 3) ──────────────────────────────────────────────────
  function renderEmpty() {
    const cat = state.catalog;
    const text = h("textarea", { placeholder: "Ex.: Quero ver receita, ticket médio e margem por canal no Sudeste", rows: 3 });
    const module = h("select", { class: "chip-select", title: "Módulo" },
      h("option", { value: "" }, "Todos os módulos"), cat.modules.map((m) => h("option", { value: m.label }, m.label)));
    const period = h("select", { class: "chip-select", title: "Período" },
      h("option", { value: "" }, "Período: o assistente escolhe"), cat.periods.map((p) => h("option", { value: p.label }, p.label)));
    const model = modelSelect();
    const start = () => {
      const t = text.value.trim();
      if (!t) return text.focus();
      const ctx = [module.value && `Módulo: ${module.value}.`, period.value && `Período: ${period.value}.`].filter(Boolean).join(" ");
      renderWorkspace();
      sendTurn({ message: ctx ? `${t}\n\n(${ctx})` : t });
    };
    text.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } };
    S.root.append(h("div", { class: "studio studio-empty" },
      topBar(),
      h("div", { class: "hero" },
        h("div", { class: "eyebrow" }, "Novo dashboard"),
        h("h1", {}, "O que você quer acompanhar?"),
        h("p", { class: "sub" }, "Descreva em português. O assistente pergunta o que faltar e monta os blocos; depois você ajusta à mão ou pedindo."),
        h("div", { class: "ask-box" }, text,
          h("div", { class: "row" }, module, period, h("div", { class: "spacer" }), model,
            h("button", { class: "btn primary", onclick: start }, "Começar"))),
        h("div", { class: "suggestions" }, h("span", {}, "Sugestões:"),
          SUGGESTIONS.map((s) => h("button", { onclick: () => { text.value = s; text.focus(); } }, s))))));
    text.focus();
  }

  function modelSelect() {
    const sel = h("select", { class: "chip-select small", title: "Modelo" },
      [["sonnet", "Sonnet"], ["haiku", "Haiku"], ["opus", "Opus"]].map(([v, l]) => h("option", { value: v }, l)));
    sel.value = S.model;
    sel.onchange = () => { S.model = sel.value; store.set("studio-model", sel.value); };
    return sel;
  }

  // ── Studio em andamento (tela 4) ───────────────────────────────────────────
  function renderWorkspace() {
    S.root.innerHTML = "";
    S.el.status = h("span", { class: "pill" });
    S.el.feed = h("div", { class: "as-feed" });
    S.el.chip = h("div", { class: "as-chip" });
    S.el.input = h("textarea", { placeholder: "Peça um ajuste ou um bloco novo", rows: 2 });
    S.el.send = h("button", { class: "btn primary small", type: "submit" }, "Enviar");
    S.el.input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } };
    const submit = () => {
      const t = S.el.input.value.trim();
      if (!t || S.running) return;
      S.el.input.value = "";
      sendTurn({ message: t });
    };
    S.el.canvas = h("div", { class: "canvas" });
    S.el.tabs = h("div", { class: "tabs" });

    S.root.append(h("div", { class: "studio" },
      topBar(),
      h("div", { class: "studio-body" },
        h("aside", { class: "assistant" },
          h("div", { class: "as-head" },
            h("div", { class: "as-id" }, h("span", { class: "spark" }, "✦"),
              h("div", {}, h("b", {}, "Assistente"), h("small", {}, "Monta e ajusta o dashboard com você"))),
            S.el.status, modelSelect()),
          S.el.feed,
          h("form", { class: "as-input", onsubmit: (e) => { e.preventDefault(); submit(); } },
            S.el.chip, S.el.input,
            h("div", { class: "row" },
              h("button", { type: "button", class: "btn ghost small", disabled: true, title: "Fora do MVP" }, "Anexar"),
              h("button", { type: "button", class: "btn ghost small", disabled: true, title: "Fora do MVP" }, "Link"),
              h("div", { class: "spacer" }), S.el.send))),
        h("section", { class: "canvas-area" }, S.el.tabs, S.el.canvas))));
    drawAll();
  }

  function drawAll() {
    drawTop();
    drawStatus();
    drawFeed();
    drawChip();
    drawTabs();
    drawCanvas();
  }

  function activeChoices() {
    if (S.running) return null;
    const i = S.messages.map((m) => m.role).lastIndexOf("choices");
    if (i < 0) return null;
    return S.messages.slice(i + 1).some((m) => m.role === "answers" || m.role === "user") ? null : S.messages[i];
  }

  function answersAfter(choicesMsg) {
    const i = S.messages.indexOf(choicesMsg);
    return S.messages.slice(i + 1).find((m) => m.role === "answers")?.content.answers || null;
  }

  function drawStatus() {
    const el = S.el.status;
    if (!el) return;
    el.className = "pill" + (S.running ? " busy" : "");
    el.textContent = S.running ? "Trabalhando…" : "Aguardando você";
    if (S.el.send) S.el.send.disabled = S.running;
  }

  // ── conversa ───────────────────────────────────────────────────────────────
  function md(t) {
    const lines = escapeHtml(t || "").split("\n");
    let out = "", list = false;
    for (const l of lines) {
      const m = l.match(/^\s*[-*]\s+(.*)/);
      if (m) {
        if (!list) { out += "<ul>"; list = true; }
        out += `<li>${m[1]}</li>`;
        continue;
      }
      if (list) { out += "</ul>"; list = false; }
      if (l.trim()) out += `<p>${l}</p>`;
    }
    if (list) out += "</ul>";
    return out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function blockTitle(id) {
    return (S.spec && blocksOf(S.spec).find((b) => b.id === id)?.title) || id;
  }

  function messageEl(m) {
    const c = m.content || {};
    if (m.role === "user") {
      return h("div", { class: "msg me" },
        c.blockId ? h("span", { class: "chip" }, `Bloco: ${blockTitle(c.blockId)}`) : null,
        h("div", { class: "bubble" }, c.text));
    }
    if (m.role === "answers") return h("div", { class: "msg me" }, h("div", { class: "bubble pre" }, c.text || "Respostas enviadas"));
    if (m.role === "manual") return h("div", { class: "msg sys" }, h("span", {}, "✎"), ` Você, à mão: ${c.note}`);
    if (m.role === "note") return h("div", { class: "msg sys bad" }, c.text);
    if (m.role === "choices") return choicesCard(m);
    if (m.role === "assistant") {
      const r = m.run || {};
      const tools = c.tools || [];
      return h("div", { class: "msg ai" + (c.error ? " bad" : "") },
        h("div", { class: "bubble", html: md(c.text) }),
        tools.length ? h("details", { class: "steps" },
          h("summary", {}, [`${tools.length} etapas`, r.durationMs ? `${(r.durationMs / 1000).toFixed(0)} s` : null, r.model].filter(Boolean).join(" · ")),
          h("ol", {}, tools.map((t) => h("li", { class: t.endsWith("✗") ? "bad" : "" }, TOOL_LABEL[t.replace("✗", "")] || t)))) : null);
    }
    return null;
  }

  function choicesCard(m) {
    const qs = m.content.questions || [];
    const active = activeChoices() === m;
    const answered = answersAfter(m);
    if (active && S.picksFor !== m.id) {
      // Começa com as recomendadas marcadas, como no Figma.
      S.picksFor = m.id;
      S.picks = Object.fromEntries(qs.map((q) => [q.id, q.options.find((o) => o.recommended)?.id]).filter(([, v]) => v));
    }
    const picks = active ? S.picks : answered || {};
    const card = h("div", { class: "choices" + (active ? " active" : "") });
    qs.forEach((q, i) => {
      card.append(h("div", { class: "q" },
        h("div", { class: "q-step" }, `${i + 1} de ${qs.length}`),
        h("div", { class: "q-title" }, q.title),
        h("div", { class: "opts" }, q.options.map((o) => h("button", {
          type: "button", class: "opt" + (picks[q.id] === o.id ? " on" : ""), disabled: !active,
          onclick: () => { S.picks[q.id] = o.id; drawFeed(); drawCanvas(); },
        },
        h("span", { class: "radio" }),
        h("span", { class: "opt-text" },
          h("span", { class: "opt-label" }, o.label, o.recommended ? h("span", { class: "rec" }, "recomendado") : null),
          o.detail ? h("code", { class: "opt-detail" }, o.detail) : null))))));
    });
    if (active) {
      const fill = (auto) => Object.fromEntries(qs.map((q) => [q.id, auto ? "auto" : S.picks[q.id] || "auto"]));
      card.append(h("div", { class: "choices-foot" },
        h("button", { type: "button", class: "btn link", onclick: () => sendTurn({ answers: fill(true) }) }, "Deixar o assistente escolher"),
        h("button", { type: "button", class: "btn primary", onclick: () => sendTurn({ answers: fill(false) }) }, "Montar relatório")));
    } else if (answered) {
      card.append(h("div", { class: "choices-foot muted" }, "Respondido"));
    }
    return card;
  }

  function liveEl() {
    const L = S.live;
    return h("div", { class: "msg ai live" },
      L.steps.length ? h("ol", { class: "steps-live" }, L.steps.map((s) => h("li", { class: s.ok === false ? "bad" : s.ok ? "ok" : "" },
        TOOL_LABEL[s.name] || s.name, s.summary ? h("span", { class: "muted" }, ` · ${s.summary}`) : null))) : null,
      L.texts.map((t) => h("div", { class: "bubble", html: md(t) })),
      L.errors.map((t) => h("div", { class: "bubble bad" }, t)),
      h("div", { class: "running" }, h("span", { class: "spinner" }), "Trabalhando…"));
  }

  function drawFeed() {
    const feed = S.el.feed;
    if (!feed) return;
    feed.innerHTML = "";
    for (const m of S.messages) {
      const e = messageEl(m);
      if (e) feed.append(e);
    }
    if (S.live) feed.append(liveEl());
    // Com perguntas abertas, mostra o começo do cartão; senão, a última mensagem.
    const card = feed.querySelector(".choices.active");
    feed.scrollTop = card ? card.offsetTop - 8 : feed.scrollHeight;
  }

  function drawChip() {
    const chip = S.el.chip;
    if (!chip) return;
    chip.innerHTML = "";
    if (!S.selected) return;
    chip.append(h("span", { class: "chip on" }, `Ajustando: ${blockTitle(S.selected)}`,
      h("button", { type: "button", title: "Tirar seleção", onclick: () => select(null) }, "×")));
  }

  // ── turno do agente ────────────────────────────────────────────────────────
  async function sendTurn({ message = null, answers = null }) {
    if (S.running) return;
    if (!(await flush())) return;   // o agente precisa ver as edições manuais já salvas
    const me = S;
    const blockId = answers ? null : S.selected;
    S.running = true;
    S.live = { steps: [], texts: [], errors: [] };
    if (answers) S.messages.push({ role: "answers", content: { answers, text: "Respostas enviadas" } });
    else S.messages.push({ role: "user", content: { text: message, blockId } });
    drawAll();
    S.abort = new AbortController();
    let failed = null;
    try {
      const r = await fetch(AGENT_URL + "/studio/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: state.tenant, sessionId: S.sessionId, message, answers, blockId, model: S.model }),
        signal: S.abort.signal,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `o agente respondeu HTTP ${r.status}`);
      }
      await readSSE(r, (ev) => { if (S === me) onEvent(ev); });
    } catch (e) {
      if (e.name === "AbortError" || S !== me) return;
      failed = e.message;
    }
    if (S !== me) return;
    S.running = false;
    S.live = null;
    if (S.sessionId) await reload();
    if (failed) {
      S.messages.push({ role: "note", content: { text: `Não consegui falar com o agente: ${failed}. Ele está rodando? (docker compose up -d agent)` } });
    }
    drawAll();
  }

  function onEvent(ev) {
    const L = S.live;
    if (ev.type === "session") {
      S.sessionId = ev.sessionId;
      if (!S.draft) history.replaceState(null, "", `#/studio/${ev.sessionId}`);
    } else if (ev.type === "tool_call") {
      L.steps.push({ id: ev.id, name: ev.name });
    } else if (ev.type === "tool_result") {
      const s = L.steps.find((x) => x.id === ev.id);
      if (s) Object.assign(s, { ok: ev.ok, summary: ev.summary });
    } else if (ev.type === "text") {
      L.texts.push(ev.text);
    } else if (ev.type === "error") {
      L.errors.push(ev.message);
    } else if (ev.type === "choices") {
      if (ev.message) S.messages.push(ev.message);
      drawCanvas();
    } else if (ev.type === "draft_saved") {
      onDraftSaved(ev.draftId);
    }
    drawFeed();
  }

  async function onDraftSaved(id) {
    const me = S;
    const { data } = await api(`/dashboards/${id}`);
    if (S !== me) return;
    S.draft = data;
    S.spec = structuredClone(data.spec);
    S.savedSpec = structuredClone(data.spec);
    S.savedAt = new Date();
    history.replaceState(null, "", `#/studio/${id}`);
    drawTop();
    drawCanvas();
  }

  // ── edição manual ──────────────────────────────────────────────────────────
  function applyEdit(mutate, note) {
    if (S.running) return toast("Espere o assistente terminar para mexer à mão.");
    const next = structuredClone(S.spec);
    mutate(next);
    S.spec = next;
    S.pending.push(note);
    drawTop();
    drawCanvas();
    if (S.autosave) save();
  }

  // Salva as edições pendentes (uma por vez, em fila). Se a validação recusar, volta para a última versão salva.
  function save() {
    const me = S;
    S.saving = S.saving.then(async () => {
      if (S !== me || !S.pending.length || !S.draft) return true;
      const notes = S.pending.splice(0);
      const spec = S.spec;
      const note = notes.join("; ");
      const { status, data } = await api(`/drafts/${S.draft.id}`, {
        method: "PUT", body: { spec, session_id: S.sessionId, edit_note: note },
      });
      if (S !== me) return false;
      if (status === 422) {
        const e = data.validation.errors[0];
        toast(`Não deu para salvar: ${e?.message}${e?.hint ? ` (${e.hint})` : ""}`);
        S.spec = structuredClone(S.savedSpec);
        drawTop();
        drawCanvas();
        return false;
      }
      S.savedSpec = structuredClone(spec);
      S.draft = { ...S.draft, ...data, spec };
      S.savedAt = new Date();
      S.messages.push({ role: "manual", content: { note } });
      drawTop();
      drawFeed();
      return true;
    }).catch((e) => {
      toast(`Não deu para salvar: ${e.message}`);
      return false;
    });
    return S.saving;
  }

  async function flush() {
    if (!S.pending.length) { await S.saving; return true; }
    return save();
  }

  function select(id) {
    S.selected = id && S.selected !== id ? id : null;
    S.el.canvas?.querySelectorAll(".block.editable").forEach((c) => c.classList.toggle("selected", c.dataset.id === S.selected));
    drawChip();
    if (S.selected) S.el.input?.focus();
  }

  function resize(block, dir) {
    const cur = block.span;
    const next = dir > 0 ? SPANS.find((s) => s > cur) : [...SPANS].reverse().find((s) => s < cur);
    if (!next) return;
    applyEdit((spec) => setSpan(spec, block.id, next), `mudou a largura de "${block.title}" (${block.id}) de ${cur} para ${next} colunas`);
  }

  function changeKind(block, kind) {
    applyEdit((spec) => { blocksOf(spec).find((b) => b.id === block.id).kind = kind; },
      `trocou "${block.title}" (${block.id}) de ${KIND_LABEL[block.kind]} para ${KIND_LABEL[kind]}`);
  }

  function rename(block, title) {
    applyEdit((spec) => { blocksOf(spec).find((b) => b.id === block.id).title = title; },
      `renomeou o bloco ${block.id} de "${block.title}" para "${title}"`);
  }

  function remove(block) {
    if (blocksOf(S.spec).length === 1) return toast("O dashboard precisa de pelo menos um bloco.");
    if (!confirm(`Excluir o bloco "${block.title}"?`)) return;
    if (S.selected === block.id) select(null);
    applyEdit((spec) => { spec.rows = pack(blocksOf(spec).filter((b) => b.id !== block.id)); },
      `excluiu o bloco "${block.title}" (${block.id})`);
  }

  function move(dragId, beforeId) {
    if (!dragId || dragId === beforeId) return;
    const all = blocksOf(S.spec);
    const b = all.find((x) => x.id === dragId);
    const target = beforeId ? all.find((x) => x.id === beforeId) : null;
    applyEdit((spec) => {
      const list = blocksOf(spec).filter((x) => x.id !== dragId);
      const moved = blocksOf(spec).find((x) => x.id === dragId);
      const at = beforeId ? list.findIndex((x) => x.id === beforeId) : list.length;
      list.splice(at, 0, moved);
      spec.rows = pack(list, dragId);
    }, target ? `moveu "${b.title}" (${dragId}) para antes de "${target.title}"` : `moveu "${b.title}" (${dragId}) para o fim`);
  }

  // Controles de cada bloco no canvas: alça de arrastar, largura, tipo, título editável, excluir, selecionar.
  function decorate(card, block) {
    card.dataset.id = block.id;
    card.classList.add("editable");
    if (S.selected === block.id) card.classList.add("selected");

    const handle = h("button", { class: "handle", type: "button", title: "Arraste para mover", draggable: "true" }, "⋮⋮");
    handle.addEventListener("dragstart", (e) => {
      S.dragId = block.id;
      e.dataTransfer.setData("text/plain", block.id);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => { card.classList.remove("dragging"); S.dragId = null; });
    card.addEventListener("dragover", (e) => {
      if (!S.dragId || S.dragId === block.id) return;
      e.preventDefault();
      card.classList.add("drop-before");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drop-before");
      move(S.dragId, block.id);
    });

    const kinds = compatibleKinds(block);
    const kindSel = h("select", { title: "Tipo de peça" }, kinds.map((k) => h("option", { value: k }, KIND_LABEL[k])));
    if (!kinds.includes(block.kind)) kindSel.prepend(h("option", { value: block.kind }, KIND_LABEL[block.kind] || block.kind));
    kindSel.value = block.kind;
    kindSel.onchange = () => changeKind(block, kindSel.value);

    const tools = h("div", { class: "btools" },
      h("button", { type: "button", title: "Diminuir largura", onclick: () => resize(block, -1) }, "−"),
      h("span", { class: "w", title: "Largura em colunas" }, `${block.span}/12`),
      h("button", { type: "button", title: "Aumentar largura", onclick: () => resize(block, +1) }, "+"),
      kindSel,
      h("button", { type: "button", class: "danger", title: "Excluir bloco", onclick: () => remove(block) }, "✕"));

    const h3 = card.querySelector("h3");
    if (h3) {
      h3.contentEditable = "true";
      h3.spellcheck = false;
      h3.title = "Clique para renomear";
      h3.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); h3.blur(); } if (e.key === "Escape") { h3.textContent = block.title; h3.blur(); } };
      h3.onblur = () => {
        const t = h3.textContent.trim().slice(0, 60);
        if (t && t !== block.title) rename(block, t);
        else h3.textContent = block.title;
      };
    }
    card.addEventListener("click", (e) => {
      if (e.target.closest(".btools, .handle, h3")) return;
      select(block.id);
    });
    card.prepend(handle);
    card.append(tools);
  }

  // ── canvas ─────────────────────────────────────────────────────────────────
  function drawTabs() {
    const t = S.el.tabs;
    if (!t) return;
    t.innerHTML = "";
    for (const [key, label] of [["canvas", "Canvas"], ["data", "Dados"]]) {
      t.append(h("button", { class: S.tab === key ? "on" : "", onclick: () => { S.tab = key; drawTabs(); drawCanvas(); } }, label));
    }
    t.append(h("button", { disabled: true, title: "Fora do MVP: versões e desfazer ficaram para depois" }, "Versões"));
    if (S.tab === "canvas" && S.spec) {
      t.append(h("div", { class: "spacer" }), h("span", { class: "hint" }, "Clique num bloco para pedir um ajuste só nele · arraste pela alça ⋮⋮ para mover"));
    }
  }

  async function drawCanvas() {
    const c = S?.el.canvas;
    if (!c) return;
    const gen = (S.canvasGen = (S.canvasGen || 0) + 1);
    disposeCharts();
    c.innerHTML = "";
    c.classList.toggle("locked", S.running);
    if (S.tab === "data") return c.append(dataTab());
    if (!S.spec) return c.append(planView());

    const me = S;
    const grid = h("div", { class: "grid" });
    const bar = await ParamsBar(S.spec, S.overrides, () => draw());
    if (S !== me || gen !== S.canvasGen) return;
    const saved = new Map(blocksOf(S.savedSpec).map((b) => [b.id, b]));
    const draw = () => renderGrid(grid, {
      dashId: S.draft.id, spec: S.spec, version: "draft", overrides: S.overrides, decorate,
      // Com o salvamento automático desligado, um bloco com tipo trocado ainda não existe assim na API.
      load: async (block) => (saved.get(block.id)?.kind === block.kind
        ? (await api(`/dashboards/${S.draft.id}/blocks/${block.id}/query`, { method: "POST", body: { params: S.overrides, version: "draft" } })).data
        : { status: "error", message: "Salve para ver este bloco com o novo tipo." }),
      onFresh: (res) => { bar.fresh.textContent = freshText(res); },
    });
    const end = h("div", { class: "drop-end" }, "Solte aqui para mover para o fim");
    end.addEventListener("dragover", (e) => { if (S.dragId) { e.preventDefault(); end.classList.add("on"); } });
    end.addEventListener("dragleave", () => end.classList.remove("on"));
    end.addEventListener("drop", (e) => { e.preventDefault(); end.classList.remove("on"); move(S.dragId, null); });
    c.append(bar, grid, end);
    if (S.running) c.append(h("div", { class: "lock-note" }, h("span", { class: "spinner" }), "O assistente está mexendo no rascunho…"));
    draw();
  }

  // Antes do rascunho: o plano do relatório (chips das escolhas + blocos tracejados + "Vai consultar").
  function planView() {
    const wrap = h("div", { class: "plan" });
    const lastChoices = [...S.messages].reverse().find((m) => m.role === "choices");
    const head = h("div", { class: "plan-head" }, h("span", { class: "eyebrow" }, "Plano do relatório"), h("span", { class: "muted" }, " · atualiza a cada resposta"));
    if (!lastChoices) {
      wrap.append(head, h("div", { class: "plan-wait" },
        S.running ? [h("span", { class: "spinner" }), "O assistente está lendo o catálogo e o kit…"] : "O plano aparece aqui assim que o assistente entender o pedido."),
      h("div", { class: "ghost-row" }, [4, 4, 4].map((s) => h("div", { class: "ghost-block empty", style: `grid-column: span ${s}` }))));
      return wrap;
    }
    const c = lastChoices.content;
    const picks = answersAfter(lastChoices) || S.picks;
    const chips = h("div", { class: "plan-chips" });
    for (const slot of ["metric", "dimensions", "period", "visualization"]) {
      const q = (c.questions || []).find((x) => x.slot === slot);
      let label = slot === "period" ? "Últimos 30 dias" : "a definir";
      if (q) {
        const pick = picks[q.id];
        const opt = q.options.find((o) => o.id === pick) || q.options.find((o) => o.recommended);
        label = opt ? opt.label + (pick === "auto" ? " (sugerido)" : "") : label;
      }
      chips.append(h("div", { class: "pchip" + (q ? "" : " dim") }, h("small", {}, SLOT_LABEL[slot]), h("b", {}, label)));
    }
    const ghosts = h("div", { class: "grid ghost-grid" });
    for (const row of pack((c.plan?.blocks || []).map((b, i) => ({ ...b, id: `p${i}` })))) {
      ghosts.append(h("div", { class: "row" }, row.blocks.map((b) => h("div", { class: "ghost-block", style: `grid-column: span ${b.span}` },
        h("small", {}, KIND_LABEL[b.kind] || b.kind), h("b", {}, b.title), b.note ? h("span", { class: "muted" }, b.note) : null,
        h("div", { class: `ghost-art ${b.kind}` })))));
    }
    const scope = h("div", { class: "scope" }, h("b", {}, "Vai consultar"), h("span", { class: "muted" }, "…"));
    api(`/scope${c.metric ? `?metric=${encodeURIComponent(c.metric)}` : ""}`).then(({ data: s }) => {
      scope.lastChild.textContent = ["Base de pedidos", s.module, `${s.products} produtos`, `${s.states} estados`, `${s.channels} canais`, `${s.loads} dias carregados`].filter(Boolean).join(" · ");
    }).catch(() => {});
    wrap.append(head, chips, ghosts, scope);
    if (S.running) wrap.append(h("div", { class: "plan-wait" }, h("span", { class: "spinner" }), "Montando com as suas escolhas…"));
    return wrap;
  }

  // Aba Dados: de onde vem cada bloco.
  function dataTab() {
    if (!S.spec) return h("div", { class: "plan-wait" }, "Ainda não há blocos.");
    const cat = state.catalog;
    const label = (id) => cat.metrics.find((m) => m.id === id)?.label || id;
    const fmtFilter = ([k, v]) => {
      if (k === "value") return `valor ${Object.entries(v).map(([op, n]) => `${{ gt: ">", gte: "≥", lt: "<", lte: "≤" }[op]} ${n}`).join(" e ")}`;
      if (typeof v === "string" && v.startsWith("$")) return `${k}: filtro "${S.spec.params?.[v.slice(1)]?.label || v.slice(1)}"`;
      return `${k}: ${[].concat(v).join(", ")}`;
    };
    const period = (q) => {
      if (!q.period) return "padrão (30 dias)";
      if (q.period.startsWith("$")) return `filtro "${S.spec.params?.[q.period.slice(1)]?.label || q.period.slice(1)}"`;
      return cat.periods.find((p) => p.id === q.period)?.label || q.period;
    };
    return h("div", { class: "data-tab" },
      h("table", { class: "list" },
        h("thead", {}, h("tr", {}, ["Bloco", "Peça", "Métrica", "Dimensões", "Filtros", "Período"].map((t) => h("th", {}, t)))),
        h("tbody", {}, blocksOf(S.spec).map((b) => h("tr", {},
          h("td", {}, h("b", {}, b.title), h("div", { class: "meta" }, h("code", {}, b.id))),
          h("td", {}, KIND_LABEL[b.kind] || b.kind),
          h("td", {}, label(b.query.metric), b.query.of ? h("div", { class: "meta" }, `de ${label(b.query.of)}`) : null,
            b.query.columns?.length ? h("div", { class: "meta" }, `+ ${b.query.columns.map(label).join(", ")}`) : null),
          h("td", {}, (b.query.dimensions || []).join(" × ") || "—"),
          h("td", {}, Object.entries(b.query.filters || {}).map(fmtFilter).join("; ") || "—"),
          h("td", {}, period(b.query)))))),
      h("div", { class: "data-foot" },
        h("span", { class: "muted" }, `${Object.keys(S.spec.params || {}).length} filtro(s) na tela · spec ${S.spec.kitVersion}`),
        h("button", { class: "btn small", onclick: async () => {
          if (!(await flush())) return;
          openSpec(S.spec, S.draft.id, { sessionId: S.sessionId, onSaved: async () => { await reload(); drawAll(); } });
        } }, "Ver spec JSON")));
  }

  // ── pré-visualização (tela 5) ──────────────────────────────────────────────
  async function preview(root, id) {
    const { data: d } = await api(`/dashboards/${id}`);
    const spec = d.spec;
    const overrides = {};
    const grid = h("div", { class: "grid" });
    const bar = await ParamsBar(spec, overrides, () => draw());
    const draw = () => renderGrid(grid, {
      dashId: id, spec, version: "draft", overrides, onFresh: (res) => { bar.fresh.textContent = freshText(res); },
    });
    root.append(h("div", { class: "page view-page" },
      h("div", { class: "preview-banner" },
        h("span", {}, h("b", {}, "Pré-visualização. "), "Os blocos não são editáveis aqui, e os filtros funcionam como para quem recebe o dashboard."),
        h("div", { class: "actions" },
          h("a", { class: "btn", href: `#/studio/${id}` }, "Voltar a editar"),
          h("button", { class: "btn primary", onclick: async () => { if (await publishDialog(id)) location.hash = `#/d/${id}`; } }, "Publicar"))),
      h("div", { class: "view-head" }, h("div", { class: "titles" },
        h("h1", {}, spec.title), spec.subtitle ? h("div", { class: "sub" }, spec.subtitle) : null)),
      bar, grid));
    draw();
    return { rerender: draw };
  }

  return { open, preview, pack };
})();
