// Cenários de sessão do Studio: o agente pergunta quando deve, respeita a edição manual e o bloco selecionado.
//
//   node evals/studio.mjs                    # sonnet e haiku
//   node evals/studio.mjs --models haiku --keep
//
// Precisa do compose no ar (api em :8000, agente em :8100). Grava evals/resultados/studio-<data>.{json,md}.
//
//   A · pedido aberto     "Quero acompanhar as vendas" → pergunta (propose_options), sem rascunho;
//                         respondendo "deixar o assistente escolher" → rascunho
//   B · mão + agente      a pessoa muda larguras à mão; depois pede um bloco novo → as larguras e os blocos
//                         que já existiam continuam iguais
//   C · bloco selecionado "troca esse por uma tabela" com blockId → só aquele bloco muda
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL || "http://localhost:8000/api";
const AGENT = process.env.AGENT_URL || "http://localhost:8100";
const TENANT = "aurora";
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const MODELS = arg("models", "sonnet,haiku").split(",");
const KEEP = argv.includes("--keep");

async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "X-Tenant": TENANT, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

// Um turno do Studio, lendo o SSE até o fim.
async function turn(body) {
  const started = Date.now();
  const r = await fetch(`${AGENT}/studio/turn`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenant: TENANT, ...body }),
  });
  if (!r.ok) throw new Error(`agente HTTP ${r.status}: ${await r.text()}`);
  const text = await r.text();
  const events = text.split("\n\n").map((c) => c.split("\n").find((l) => l.startsWith("data: "))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const done = events.find((e) => e.type === "done") || {};
  return {
    sessionId: events.find((e) => e.type === "session")?.sessionId,
    asked: events.some((e) => e.type === "choices"),
    draftId: done.draftId || null,
    tools: events.filter((e) => e.type === "tool_call").map((e) => e.name),
    errors: events.filter((e) => e.type === "error").map((e) => e.message),
    text: events.filter((e) => e.type === "text").map((e) => e.text).join(" "),
    ms: Date.now() - started, cost: done.costUsdIfApi || 0,
  };
}

const blocksOf = (spec) => spec.rows.flatMap((r) => r.blocks);
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const spec = async (id) => (await api("GET", `/dashboards/${id}`)).data.spec;

async function scenarios(model) {
  const out = [], turns = [];
  const record = (t) => { turns.push(t); return t; };
  const check = (id, name, fails, extra = {}) => out.push({ id, model, name, pass: fails.length === 0, fails, ...extra });

  // ── A · pedido aberto ───────────────────────────────────────────────────────
  const a1 = record(await turn({ model, message: "Quero acompanhar as vendas" }));
  const fa = [];
  if (!a1.asked) fa.push("não perguntou");
  if (a1.draftId) fa.push("salvou rascunho antes de ouvir a resposta");
  let draftId = null, sessionId = a1.sessionId;
  if (a1.asked) {
    const session = (await api("GET", `/studio/sessions/${sessionId}`)).data;
    const choices = [...session.messages].reverse().find((m) => m.role === "choices").content;
    const recs = choices.questions.map((q) => q.options.filter((o) => o.recommended).length);
    if (recs.some((n) => n !== 1)) fa.push(`recomendadas por pergunta: ${recs.join(", ")} (esperado 1 em cada)`);
    const a2 = record(await turn({ model, sessionId, answers: Object.fromEntries(choices.questions.map((q) => [q.id, "auto"])) }));
    if (a2.asked) fa.push("perguntou de novo depois das respostas");
    if (!a2.draftId) fa.push("não montou depois das respostas");
    draftId = a2.draftId;
  } else {
    draftId = a1.draftId;
  }
  check("A", "pedido aberto: pergunta e depois monta", fa, { asked: a1.asked });
  if (!draftId) {
    check("B", "mão + agente", ["sem rascunho do cenário A"]);
    check("C", "bloco selecionado", ["sem rascunho do cenário A"]);
    return { out, turns, sessionId, draftId };
  }

  // ── B · edição manual + pedido ao agente ───────────────────────────────────
  const before = await spec(draftId);
  const row = before.rows.find((r) => r.blocks.length >= 2);
  const fb = [];
  if (!row) fb.push("a spec não tem linha com 2 blocos para mexer à mão");
  else {
    const [x, y] = row.blocks;
    const step = x.span > 3 ? -1 : 1;
    x.span += step; y.span -= step;
    const put = await api("PUT", `/drafts/${draftId}`, {
      spec: before, session_id: sessionId,
      edit_note: `mudou a largura de "${x.title}" (${x.id}) para ${x.span} colunas e de "${y.title}" (${y.id}) para ${y.span}`,
    });
    if (put.status !== 200) fb.push(`a edição manual foi recusada: ${JSON.stringify(put.data?.validation?.errors?.[0])}`);
    const manual = structuredClone(before);
    const b1 = record(await turn({ model, sessionId, message: "Acrescenta no fim um bloco com o cancelamento por canal" }));
    const after = await spec(draftId);
    const now = new Map(blocksOf(after).map((b) => [b.id, b]));
    // Os blocos que existiam continuam iguais; as duas larguras mudadas à mão, exatamente iguais.
    // (Outras larguras podem mudar para o bloco novo caber ao lado de alguém.)
    const changed = blocksOf(manual).filter((b) => !now.has(b.id) || stable({ ...now.get(b.id), span: 0 }) !== stable({ ...b, span: 0 }));
    if (changed.length) fb.push(`mexeu em blocos que existiam: ${changed.map((b) => b.id + (now.has(b.id) ? "" : " (sumiu)")).join(", ")}`);
    for (const b of [x, y]) {
      if (now.has(b.id) && now.get(b.id).span !== b.span) fb.push(`desfez a largura manual de ${b.id} (${b.span} → ${now.get(b.id).span})`);
    }
    if (!blocksOf(after).some((b) => b.query.metric === "cancel_rate" && (b.query.dimensions || []).includes("channel"))) fb.push("não acrescentou o cancelamento por canal");
    if (b1.asked) fb.push("perguntou em vez de fazer");
  }
  check("B", "mão + agente: edição manual continua", fb);

  // ── C · bloco selecionado ──────────────────────────────────────────────────
  const base = await spec(draftId);
  const target = blocksOf(base).find((b) => ["ranking_bar", "bar", "heatmap"].includes(b.kind)) || blocksOf(base).at(-1);
  const c1 = record(await turn({ model, sessionId, blockId: target.id, message: "Troca esse por uma tabela" }));
  const after = await spec(draftId);
  const fc = [];
  const others = blocksOf(base).filter((b) => b.id !== target.id);
  const now = new Map(blocksOf(after).map((b) => [b.id, b]));
  const touched = others.filter((b) => { const n = now.get(b.id); return !n || stable({ ...n, span: 0 }) !== stable({ ...b, span: 0 }); });
  if (touched.length) fc.push(`mexeu em outros blocos: ${touched.map((b) => b.id).join(", ")}`);
  if (now.get(target.id)?.kind !== "table") fc.push(`o bloco ${target.id} ficou ${now.get(target.id)?.kind ?? "removido"}`);
  if (c1.errors.length) fc.push(c1.errors.join("; "));
  check("C", `bloco selecionado (${target.kind} → table)`, fc);

  return { out, turns, sessionId, draftId };
}

const runs = await Promise.all(MODELS.map(async (m) => {
  const r = await scenarios(m).catch((e) => ({ out: [{ id: "?", model: m, name: "erro", pass: false, fails: [e.message] }], turns: [] }));
  for (const c of r.out) console.log(`[${m}] ${c.id} ${c.pass ? "ok" : "FALHOU"} · ${c.name}${c.pass ? "" : " · " + c.fails.join("; ")}`);
  if (!KEEP && r.draftId) await api("DELETE", `/dashboards/${r.draftId}`);
  return { model: m, ...r };
}));

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outDir = path.join(HERE, "resultados");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `studio-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), runs }, null, 1));
let md = `# Evals do Studio · ${new Date().toLocaleString("pt-BR")}\n\nCliente: ${TENANT} · modelos: ${MODELS.join(", ")}\n\n`;
md += "| Modelo | Acertos | Turnos | Tempo médio por turno | Custo por turno se fosse API |\n|---|---|---|---|---|\n";
for (const r of runs) {
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  md += `| ${r.model} | ${r.out.filter((c) => c.pass).length}/${r.out.length} | ${r.turns.length} | ${(avg(r.turns.map((t) => t.ms)) / 1000).toFixed(1)} s | US$ ${avg(r.turns.map((t) => t.cost)).toFixed(3)} |\n`;
}
md += "\n## Cenários\n\n";
for (const r of runs) for (const c of r.out) md += `- **${c.id} · ${r.model}** ${c.pass ? "✅" : "❌"} ${c.name}${c.pass ? "" : `: ${c.fails.join("; ")}`}\n`;
md += "\n## Turnos\n\n";
for (const r of runs) for (const t of r.turns) md += `- **${r.model}** · ${(t.ms / 1000).toFixed(0)} s · ${t.tools.join(" → ") || "sem ferramentas"}${t.asked ? " · perguntou" : ""}\n  - ${t.text.replace(/\s+/g, " ").trim().slice(0, 400)}\n`;
fs.writeFileSync(path.join(outDir, `studio-${stamp}.md`), md);
console.log(`\nrelatório: evals/resultados/studio-${stamp}.md`);
