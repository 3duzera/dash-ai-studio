// A camada dash-ai: fica entre a página e o modelo. Recebe o pedido, monta o contexto, dispara o agente e
// devolve o progresso.
//
//   POST /generate {prompt, tenant, model?, draftId?}            uma tacada (usado pelos evals)
//     → SSE: start, init, tool_call, tool_result, text, done, error
//     → com ?wait=1, espera o fim e devolve um JSON com o resumo
//
//   POST /studio/turn {tenant, sessionId?, message?, answers?, blockId?, model?}   um turno do Studio
//     → SSE: session, start, init, tool_call, tool_result, text, choices, draft_saved, done, error
//     → 409 se a sessão já tem um turno rodando
//
// O agente é o `claude -p` com todas as ferramentas nativas desligadas (--tools "") e só o servidor MCP
// do projeto (--strict-mcp-config). Cliente, sessão e rascunho vão para o servidor MCP por variável de
// ambiente: o modelo não escolhe nem vê o tenant.
//
// No Studio, a memória da conversa é nossa: ela fica no banco (via API) e cada turno é um `claude -p`
// novo, com o contexto montado por buildTurn(). Num deploy de verdade só o motor mudaria (API do Claude com uso de
// ferramentas no lugar do `claude -p`); a sessão, o contexto e as ferramentas continuam os mesmos.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = 8100;
const API = process.env.API_URL || "http://api:8000";
const RUNS = process.env.RUNS_DIR || "/runs";
const TIMEOUT_MS = 6 * 60 * 1000;
const MODELS = new Set(["sonnet", "haiku", "opus"]);
const BASE_TOOLS = ["get_kit", "get_catalog", "profile_data", "validate_spec", "save_draft", "get_draft"];
const STUDIO_TOOLS = [...BASE_TOOLS, "propose_options"];
const PROMPTS = { generate: "/app/prompts/system.md", studio: "/app/prompts/studio.md" };
const HISTORY = 24;   // mensagens da sessão que entram no contexto de cada turno

// ── API (a dash-ai nunca toca no banco) ──────────────────────────────────────
async function api(tenant, method, p, body) {
  const r = await fetch(`${API}/api${p}`, {
    method,
    headers: { "X-Tenant": tenant, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

// ── resumo de cada resultado de ferramenta, para a tela ──────────────────────
function summarize(name, payload, isError) {
  try {
    const d = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (name === "validate_spec") {
      return d.valid ? "válida" : `${d.errors.length} erro(s) na porta ${d.stage}: ${d.errors[0]?.message}`;
    }
    if (name === "save_draft") {
      if (d.saved) return `salvo como ${d.id}${d.warnings?.length ? ` · aviso: ${d.warnings.map((w) => w.message).join("; ")}` : ""}`;
      const v = d.validation || {};
      return `recusado (${v.errors?.length ?? "?"} erro(s) na porta ${v.stage}): ${v.errors?.[0]?.message ?? d.detail}`;
    }
    if (name === "get_catalog") return `${d.metrics.length} métricas`;
    if (name === "get_kit") return `${d.blocks.length} blocos`;
    if (name === "profile_data") {
      if (isError) return d.detail;
      const dims = Object.entries(d.dimensions || {}).map(([k, v]) => `${k}: ${v.distinct}`).join(", ");
      return `${d.row_count} linhas${dims ? ` (${dims})` : ""}`;
    }
    if (name === "get_draft") return isError ? d.detail : `"${d.title}"`;
    if (name === "propose_options") return isError ? d.detail || "erro" : `${d.questions} pergunta(s) enviada(s)`;
  } catch {
    /* resumo é só para a tela */
  }
  return isError ? "erro" : "";
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  return (content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

// ── um `claude -p` ───────────────────────────────────────────────────────────
// message: o texto do turno · promptFile: o system prompt · tools: as ferramentas MCP liberadas
// mcpEnv: o que o servidor MCP recebe (TENANT, SESSION_ID…) · meta: o que vai junto no log
function runAgent({ message, promptFile, tools, tenant, model, mcpEnv, meta }, emit) {
  return new Promise((resolve) => {
    const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");
    const cfgPath = path.join(os.tmpdir(), `mcp-${runId}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        dash: {
          type: "stdio",
          command: "node",
          args: ["/app/mcp-server.mjs"],
          env: { API_URL: API, TENANT: tenant, ...mcpEnv },
        },
      },
    }));
    const args = [
      "-p", message,
      "--output-format", "stream-json", "--verbose",
      "--model", model,
      "--tools", "",
      "--strict-mcp-config", "--mcp-config", cfgPath,
      "--allowedTools", tools.map((t) => `mcp__dash__${t}`).join(","),
      "--system-prompt", fs.readFileSync(promptFile, "utf8"),
    ];

    const started = Date.now();
    const summary = {
      runId, tenant, model, ...meta, draftId: null, choices: null,
      tools: null, toolCalls: [], texts: [], repairs: 0, validFirstTry: null,
      usage: null, durationMs: null, numTurns: null, resultText: null, isError: false, stderr: "",
    };
    const calls = new Map();
    const events = [];
    const send = (ev) => { events.push(ev); emit(ev); };
    send({ type: "start", runId, model, draftId: meta.editing || null });

    const child = spawn("claude", args, { cwd: "/work", env: process.env });
    const timer = setTimeout(() => {
      send({ type: "error", message: `o agente passou de ${TIMEOUT_MS / 60000} min e foi interrompido` });
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        handle(m);
      }
    });
    child.stderr.on("data", (c) => { summary.stderr = (summary.stderr + c).slice(-4000); });

    function handle(m) {
      if (m.type === "system" && m.subtype === "init") {
        summary.tools = m.tools;
        send({ type: "init", tools: m.tools, mcp: m.mcp_servers, model: m.model });
      } else if (m.type === "assistant") {
        for (const c of m.message?.content || []) {
          if (c.type === "text" && c.text.trim()) {
            summary.texts.push(c.text);
            send({ type: "text", text: c.text });
          } else if (c.type === "tool_use") {
            const name = c.name.replace(/^mcp__dash__/, "");
            calls.set(c.id, { name, input: c.input });
            send({ type: "tool_call", id: c.id, name, input: c.input });
          }
        }
      } else if (m.type === "user") {
        for (const c of m.message?.content || []) {
          if (c.type !== "tool_result") continue;
          const call = calls.get(c.tool_use_id) || { name: "?" };
          const text = toolResultText(c.content);
          const isError = Boolean(c.is_error);
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* não é JSON */ }
          if (call.name === "validate_spec" || call.name === "save_draft") {
            const ok = call.name === "validate_spec" ? parsed?.valid === true : parsed?.saved === true;
            if (summary.validFirstTry === null) summary.validFirstTry = ok;
            if (!ok) summary.repairs += 1;
            if (call.name === "save_draft" && ok) {
              summary.draftId = parsed.id;
              send({ type: "draft_saved", draftId: parsed.id, warnings: parsed.warnings || [] });
            }
          }
          const s = summarize(call.name, parsed ?? text, isError);
          summary.toolCalls.push({ name: call.name, input: call.input, ok: !isError, summary: s });
          send({ type: "tool_result", id: c.tool_use_id, name: call.name, ok: !isError, summary: s });
          if (call.name === "propose_options" && !isError) {
            summary.choices = parsed?.message ?? null;
            send({ type: "choices", message: parsed?.message });
          }
        }
      } else if (m.type === "result") {
        summary.usage = m.usage;
        summary.numTurns = m.num_turns;
        summary.resultText = m.result;
        summary.isError = Boolean(m.is_error);
        summary.costUsdIfApi = m.total_cost_usd;
      }
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rm(cfgPath, () => {});
      summary.durationMs = Date.now() - started;
      if (code !== 0 && !summary.resultText) {
        summary.isError = true;
        send({ type: "error", message: `o claude saiu com código ${code}: ${summary.stderr.trim().slice(-600) || "sem detalhe"}` });
      }
      send({
        type: "done", draftId: summary.draftId, durationMs: summary.durationMs, numTurns: summary.numTurns,
        usage: summary.usage, repairs: summary.repairs, validFirstTry: summary.validFirstTry,
        costUsdIfApi: summary.costUsdIfApi, asked: Boolean(summary.choices),
      });
      try {
        fs.appendFileSync(path.join(RUNS, `${new Date().toISOString().slice(0, 10)}.jsonl`),
          JSON.stringify({ at: new Date().toISOString(), ...summary, events }) + "\n");
      } catch (e) {
        console.error("não consegui gravar o log:", e.message);
      }
      resolve(summary);
    });
  });
}

// ── Studio: o contexto de cada turno ─────────────────────────────────────────
// É o coração da camada: o que o modelo recebe a cada turno sai daqui, não da memória dele.

function describeAnswers(answers, choicesMsg) {
  const qs = choicesMsg?.content?.questions || [];
  return qs.map((q, i) => {
    const pick = answers?.[q.id];
    const show = (o) => `${o.label}${o.detail ? ` (${o.detail})` : ""}`;
    const opt = q.options.find((o) => o.id === pick);
    const rec = q.options.find((o) => o.recommended) || q.options[0];
    const label = pick === "auto" || !opt ? `deixou o assistente escolher → use a recomendada: ${show(rec)}` : show(opt);
    return `${i + 1}. ${q.title} → ${label}`;
  }).join("\n");
}

function historyLine(m) {
  const c = m.content || {};
  switch (m.role) {
    case "user": return `Pessoa${c.blockId ? ` (sobre o bloco ${c.blockId})` : ""}: ${c.text}`;
    case "assistant": return `Você: ${c.text || "(sem texto)"}${c.draftId ? ` [salvou ${c.draftId}]` : ""}`;
    case "choices": return `Você perguntou: ${(c.questions || []).map((q, i) => `${i + 1}) ${q.title} [${q.options.map((o) => o.label).join(" | ")}]`).join(" ")}`;
    case "answers": return `Pessoa respondeu:\n${c.text}`;
    case "manual": return `Pessoa, à mão no canvas: ${c.note}`;
    case "note": return `Sistema: ${c.text}`;
    default: return null;
  }
}

function buildTurn(session, input) {
  const msgs = session.messages || [];
  const draft = session.draft;
  const parts = [];

  if (draft) {
    parts.push(`## Rascunho atual (${draft.id})\nJá está salvo e a pessoa o vê no canvas. save_draft atualiza este rascunho.\n` +
      "```json\n" + JSON.stringify(draft.spec) + "\n```");
  } else {
    parts.push("## Rascunho atual\nAinda não existe. O primeiro save_draft cria o rascunho desta sessão.");
  }

  const lastAssistant = msgs.map((m) => m.role).lastIndexOf("assistant");
  const manual = msgs.slice(lastAssistant + 1).filter((m) => m.role === "manual");
  if (manual.length) {
    parts.push("## Mudanças feitas à mão desde a sua última resposta\nJá estão no rascunho acima. Não desfaça sem pedido.\n" +
      manual.map((m) => `- ${m.content.note}`).join("\n"));
  }

  const history = msgs.slice(-HISTORY).map(historyLine).filter(Boolean);
  if (history.length) parts.push("## Conversa até aqui\n" + history.join("\n"));

  if (input.blockId) {
    const b = draft?.spec.rows.flatMap((r) => r.blocks).find((x) => x.id === input.blockId);
    parts.push(`## Bloco selecionado\nA pessoa selecionou o bloco \`${input.blockId}\`${b ? ` ("${b.title}", ${b.kind})` : ""}. ` +
      "Mude só esse bloco: o sistema recusa mudanças nos outros (só o span dos vizinhos pode mudar, para a linha fechar 12). " +
      "Se o pedido exigir mexer em outros blocos, explique e não salve.");
  }

  if (input.answers) {
    const lastChoices = [...msgs].reverse().find((m) => m.role === "choices");
    parts.push("## Respostas às suas perguntas\n" + describeAnswers(input.answers, lastChoices) +
      (input.message ? `\n\nA pessoa acrescentou: ${input.message}` : "") +
      "\n\nMonte o dashboard com essas escolhas, valide e salve.");
  } else {
    parts.push(`## Pedido agora\n${input.message}`);
  }
  return parts.join("\n\n");
}

async function studioTurn(input, emit) {
  const { tenant } = input;
  let sessionId = input.sessionId;
  if (!sessionId) {
    const r = await api(tenant, "POST", "/studio/sessions", { model: input.model });
    if (r.status !== 200) throw Object.assign(new Error(r.data?.detail || "não consegui criar a sessão"), { status: r.status });
    sessionId = r.data.id;
  }
  const lock = await api(tenant, "POST", `/studio/sessions/${sessionId}/lock`, { model: input.model });
  if (lock.status !== 200) throw Object.assign(new Error(lock.data?.detail || "sessão indisponível"), { status: lock.status });

  try {
    const s = await api(tenant, "GET", `/studio/sessions/${sessionId}?limit=${HISTORY + 20}`);
    const session = s.data;
    emit({ type: "session", sessionId, draftId: session.draft?.id || null });
    const message = buildTurn(session, input);

    // O pedido entra na sessão antes de rodar: se o turno cair, a conversa não perde o que a pessoa pediu.
    if (input.answers) {
      const lastChoices = [...(session.messages || [])].reverse().find((m) => m.role === "choices");
      await api(tenant, "POST", `/studio/sessions/${sessionId}/messages`, {
        role: "answers", content: { answers: input.answers, text: describeAnswers(input.answers, lastChoices), extra: input.message || null },
      });
    } else {
      await api(tenant, "POST", `/studio/sessions/${sessionId}/messages`, {
        role: "user", content: { text: input.message, blockId: input.blockId || null },
      });
    }

    const summary = await runAgent({
      message,
      promptFile: PROMPTS.studio,
      tools: STUDIO_TOOLS,
      tenant,
      model: input.model,
      mcpEnv: {
        SESSION_ID: sessionId,
        DRAFT_ID: session.draft?.id || "",
        ONLY_BLOCK: input.blockId || "",
        PROMPT: input.message || "",
      },
      meta: { mode: "studio", sessionId, prompt: input.message, answers: input.answers || null, blockId: input.blockId || null, editing: session.draft?.id || null, turnMessage: message },
    }, emit);

    await api(tenant, "POST", `/studio/sessions/${sessionId}/messages`, {
      role: "assistant",
      content: {
        text: summary.resultText || summary.texts.at(-1) || (summary.isError ? "O turno falhou." : ""),
        draftId: summary.draftId, asked: Boolean(summary.choices), error: summary.isError || undefined,
        tools: summary.toolCalls.map((t) => `${t.name}${t.ok ? "" : "✗"}`),
      },
      run: {
        model: input.model, durationMs: summary.durationMs, numTurns: summary.numTurns, repairs: summary.repairs,
        usage: summary.usage, costUsdIfApi: summary.costUsdIfApi,
      },
    });
    return summary;
  } finally {
    await api(tenant, "POST", `/studio/sessions/${sessionId}/unlock`);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { reject(e); } });
  });
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (res, status, obj) => {
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const sse = (res) => {
  res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, token: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) });
  }
  if (req.method !== "POST" || !["/generate", "/studio/turn"].includes(url.pathname)) {
    res.writeHead(404, cors);
    return res.end();
  }
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { detail: "JSON inválido" }); }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return json(res, 500, { detail: "CLAUDE_CODE_OAUTH_TOKEN não está no .env" });
  const tenant = String(body.tenant || "");
  const model = MODELS.has(body.model) ? body.model : "sonnet";
  const prompt = String(body.prompt ?? body.message ?? "").trim().slice(0, 2000);

  if (url.pathname === "/studio/turn") {
    const answers = body.answers && typeof body.answers === "object" ? body.answers : null;
    if (!tenant || (!prompt && !answers)) return json(res, 400, { detail: "tenant e message (ou answers) são obrigatórios" });
    const input = {
      tenant, model, message: prompt, answers,
      sessionId: body.sessionId ? String(body.sessionId) : null,
      blockId: body.blockId ? String(body.blockId) : null,
    };
    // O lock é pedido antes de abrir o SSE, para o 409 voltar como status HTTP.
    let emit = null;
    try {
      await studioTurn(input, (ev) => {
        if (!emit) emit = sse(res);
        emit(ev);
      });
    } catch (e) {
      if (!emit) return json(res, e.status || 500, { detail: e.message });
      emit({ type: "error", message: e.message });
    }
    return res.end();
  }

  const draftId = body.draftId ? String(body.draftId) : null;
  if (!prompt || !tenant) return json(res, 400, { detail: "prompt e tenant são obrigatórios" });
  const run = (emit) => runAgent({
    message: draftId
      ? `Você está editando o rascunho ${draftId}. Leia-o com get_draft antes de mudar.\n\nPedido de edição: ${prompt}`
      : `Pedido: ${prompt}`,
    promptFile: PROMPTS.generate,
    tools: BASE_TOOLS,
    tenant, model,
    mcpEnv: { PROMPT: prompt },
    meta: { mode: "generate", prompt, editing: draftId },
  }, emit);

  if (url.searchParams.get("wait")) return json(res, 200, await run(() => {}));
  const emit = sse(res);
  await run(emit);
  res.end();
}).listen(PORT, () => console.log(`agente ouvindo em :${PORT}`));
