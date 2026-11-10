// Roda os pedidos de teste contra o agente e compara a spec gerada com o esperado.
//
//   node evals/run.mjs                          # sonnet e haiku, todos os pedidos
//   node evals/run.mjs --models haiku --only T01,T07,T12
//   node evals/run.mjs --keep                   # não apaga os rascunhos criados
//
// Precisa do compose no ar (api em :8000, agente em :8100). Grava evals/resultados/<data>.{json,md}.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL || "http://localhost:8000/api";
const AGENT = process.env.AGENT_URL || "http://localhost:8100";

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const MODELS = arg("models", "sonnet,haiku").split(",");
const ONLY = arg("only", null)?.split(",");
const KEEP = argv.includes("--keep");

const suite = JSON.parse(fs.readFileSync(path.join(HERE, "pedidos.json"), "utf8"));
const TENANT = suite.tenant;
let cases = suite.cases;
if (ONLY) {
  // Edição precisa do pedido-base: inclui automaticamente.
  const need = new Set(ONLY);
  cases.filter((c) => need.has(c.id) && c.base).forEach((c) => need.add(c.base));
  cases = cases.filter((c) => need.has(c.id));
}

async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "X-Tenant": TENANT, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => null);
}

async function generate(prompt, model, draftId) {
  const r = await fetch(`${AGENT}/generate?wait=1`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model, tenant: TENANT, draftId }),
  });
  if (!r.ok) throw new Error(`agente HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── comparação ───────────────────────────────────────────────────────────────
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const blocksOf = (spec) => spec.rows.flatMap((r) => r.blocks);

function resolve(spec, b) {
  const params = spec.params || {};
  const val = (v) => (typeof v === "string" && v.startsWith("$") ? params[v.slice(1)]?.default : v);
  const filters = {};
  for (const [k, v] of Object.entries(b.query.filters || {})) {
    if (k === "value") continue;
    const arr = [].concat(val(v) ?? []);
    if (arr.length) filters[k] = arr;
  }
  return { filters, period: b.query.period ? val(b.query.period) : "last_30_days", dims: b.query.dimensions || [] };
}

function mismatches(exp, b, spec) {
  const r = resolve(spec, b), out = [];
  // metric pode ser uma lista: qualquer uma delas serve.
  const metrics = [].concat(exp.metric || []);
  const asColumn = exp.orAsColumn && b.kind === "table" && (b.query.columns || []).some((c) => metrics.includes(c));
  if (metrics.length && !metrics.includes(b.query.metric) && !asColumn) out.push(`métrica ${b.query.metric}`);
  if (exp.kinds && !exp.kinds.includes(b.kind)) out.push(`kind ${b.kind} (esperado ${exp.kinds.join("/")})`);
  if (exp.dims && !sameSet(r.dims, exp.dims)) out.push(`dimensões [${r.dims}] (esperado [${exp.dims}])`);
  if (exp.dimsInclude && !exp.dimsInclude.every((d) => r.dims.includes(d))) out.push(`dimensões [${r.dims}] sem ${exp.dimsInclude}`);
  for (const [k, ids] of Object.entries(exp.filters || {})) {
    if (!r.filters[k] || !sameSet(r.filters[k], ids)) out.push(`filtro ${k}=[${r.filters[k] || ""}] (esperado [${ids}])`);
  }
  if (exp.of && b.query.of !== exp.of) out.push(`of ${b.query.of}`);
  if (exp.periods && !exp.periods.includes(r.period)) out.push(`período ${r.period} (esperado ${exp.periods.join("/")})`);
  if (exp.sort && b.query.sort !== exp.sort) out.push(`sort ${b.query.sort} (esperado ${exp.sort})`);
  if (exp.span && b.span !== exp.span) out.push(`span ${b.span} (esperado ${exp.span})`);
  return out;
}

function evaluate(c, run, spec, baseSpec) {
  const e = c.expect || {}, fails = [];
  if (e.draft === false && run.draftId) fails.push("salvou rascunho, mas não deveria");
  if (e.draft === true && !run.draftId) fails.push("não salvou rascunho");
  const needsSpec = e.blocks || e.noKinds || e.keepOthers || e.filterCheck;
  if (needsSpec && !spec) {
    fails.push("sem rascunho para conferir");
    return fails;
  }
  if (e.blocks) {
    const blocks = blocksOf(spec), used = new Set();
    for (const exp of e.blocks) {
      // orAsColumn: uma table com a métrica como coluna extra pode cumprir dois esperados de uma vez.
      const hit = blocks.find((b) => (exp.orAsColumn || !used.has(b)) && mismatches(exp, b, spec).length === 0);
      if (hit) { used.add(hit); continue; }
      const near = blocks.filter((b) => !exp.metric || [].concat(exp.metric).includes(b.query.metric));
      const why = near.length ? mismatches(exp, near[0], spec).join(", ") : "nenhum bloco com essa métrica";
      fails.push(`faltou ${exp.kinds?.[0] || "bloco"} de ${[].concat(exp.metric || "?").join(" ou ")}: ${why}`);
    }
  }
  if (e.noKinds) {
    const bad = blocksOf(spec).filter((b) => e.noKinds.includes(b.kind));
    if (bad.length) fails.push(`ainda tem ${bad.map((b) => b.kind).join(", ")}`);
  }
  if (e.keepOthers && baseSpec) {
    const now = new Map(blocksOf(spec).map((b) => [b.id, stable(b)]));
    const shouldKeep = blocksOf(baseSpec).filter((b) => !e.keepOthers.changedKinds.includes(b.kind));
    const changed = shouldKeep.filter((b) => now.get(b.id) !== stable(b));
    if (changed.length) fails.push(`mexeu em blocos que não foram citados: ${changed.map((b) => b.id).join(", ")}`);
  }
  if (e.filterCheck) {
    const { dim, include, exclude } = e.filterCheck;
    const filtered = blocksOf(spec).map((b) => resolve(spec, b).filters[dim]).filter(Boolean);
    if (!filtered.length) fails.push(`nenhum bloco filtra ${dim}`);
    for (const ids of filtered) {
      if (!include.every((x) => ids.includes(x)) || exclude.some((x) => ids.includes(x))) {
        fails.push(`filtro de ${dim} [${ids}]`);
        break;
      }
    }
  }
  if (e.noBrand && spec) {
    // Só filtros e params: citar a marca num texto ("não achei a Brisa") é o comportamento certo.
    const values = [...Object.values(spec.params || {}).map((p) => p.default),
      ...blocksOf(spec).flatMap((b) => Object.values(resolve(spec, b).filters))].flat();
    if (values.some((v) => String(v).toLowerCase().includes(e.noBrand.toLowerCase()))) fails.push(`filtrou por ${e.noBrand}`);
  }
  return fails;
}

// ── execução ─────────────────────────────────────────────────────────────────
async function runModel(model) {
  const results = [], drafts = new Map(), specs = new Map();
  for (const c of cases) {
    const baseDraft = c.base ? drafts.get(c.base) : null;
    if (c.base && !baseDraft) {
      results.push({ id: c.id, model, skipped: `o pedido-base ${c.base} não gerou rascunho`, pass: false, fails: ["pulado"] });
      continue;
    }
    let run;
    try {
      run = await generate(c.prompt, model, baseDraft);
    } catch (e) {
      console.log(`[${model}] ${c.id} erro: ${e.message}`);
      results.push({ id: c.id, model, pass: false, fails: [e.message] });
      continue;
    }
    const spec = run.draftId ? (await api("GET", `/dashboards/${run.draftId}`))?.spec : null;
    const fails = evaluate(c, run, spec, c.base ? specs.get(c.base) : null);
    if (run.isError) fails.push(`erro do agente: ${run.stderr?.slice(-200) || run.resultText}`);
    if (run.draftId) { drafts.set(c.id, run.draftId); specs.set(c.id, structuredClone(spec)); }
    const u = run.usage || {};
    const res = {
      id: c.id, group: c.group, model, pass: fails.length === 0, fails,
      draftId: run.draftId, repairs: run.repairs, validFirstTry: run.validFirstTry,
      durationMs: run.durationMs, numTurns: run.numTurns,
      tokensIn: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      tokensOut: u.output_tokens || 0,
      calledProfile: run.toolCalls.some((t) => t.name === "profile_data"),
      toolCalls: run.toolCalls.map((t) => `${t.name}${t.ok ? "" : "✗"}`),
      answer: run.resultText, spec,
    };
    results.push(res);
    console.log(`[${model}] ${c.id} ${res.pass ? "ok" : "FALHOU"} · ${(run.durationMs / 1000).toFixed(1)} s · reparos ${run.repairs}${res.pass ? "" : " · " + fails.join("; ")}`);
  }
  if (!KEEP) {
    // Edições reaproveitam o rascunho-base: apaga cada id uma vez.
    for (const id of new Set(drafts.values())) await api("DELETE", `/dashboards/${id}`);
  }
  return results;
}

// --rescore <arquivo.json>: recalcula a nota de uma rodada salva, sem chamar o agente de novo
// (útil depois de corrigir um esperado em pedidos.json).
const RESCORE = arg("rescore", null);
let all;
if (RESCORE) {
  const prev = JSON.parse(fs.readFileSync(RESCORE, "utf8")).results;
  MODELS.splice(0, MODELS.length, ...new Set(prev.map((r) => r.model)));
  cases = suite.cases.filter((c) => prev.some((r) => r.id === c.id));
  all = prev.map((r) => {
    if (r.skipped) return r;
    const c = suite.cases.find((x) => x.id === r.id);
    const base = c.base ? prev.find((x) => x.id === c.base && x.model === r.model)?.spec : null;
    const agentErr = (r.fails || []).filter((f) => f.startsWith("erro do agente"));
    const fails = [...evaluate(c, { draftId: r.draftId }, r.spec, base), ...agentErr];
    return { ...r, fails, pass: fails.length === 0 };
  });
  console.log(`renota de ${RESCORE}`);
} else {
  all = (await Promise.all(MODELS.map(runModel))).flat();
}

// ── relatório ────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outDir = path.join(HERE, "resultados");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), tenant: TENANT, results: all }, null, 1));

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtInt = (n) => Math.round(n).toLocaleString("pt-BR");
const groups = ["fácil", "composto", "edição", "armadilha"];
let md = `# Evals do agente · ${new Date().toLocaleString("pt-BR")}\n\nCliente: ${TENANT} · ${cases.length} pedidos · modelos: ${MODELS.join(", ")}\n\n`;
md += "## Resumo por modelo\n\n| Modelo | Acertos | " + groups.map((g) => g[0].toUpperCase() + g.slice(1)).join(" | ") +
  " | Válida de 1ª | Reparos (média) | Tempo médio | Tokens de entrada (média) | Tokens de saída (média) |\n|---|---|" + groups.map(() => "---|").join("") + "---|---|---|---|---|\n";
for (const m of MODELS) {
  const rs = all.filter((r) => r.model === m);
  const ran = rs.filter((r) => r.durationMs);
  const byGroup = groups.map((g) => { const x = rs.filter((r) => r.group === g); return `${x.filter((r) => r.pass).length}/${x.length}`; });
  const vf = ran.filter((r) => r.validFirstTry !== null && r.validFirstTry !== undefined);
  md += `| ${m} | **${rs.filter((r) => r.pass).length}/${rs.length}** | ${byGroup.join(" | ")} | ${vf.filter((r) => r.validFirstTry).length}/${vf.length} | ${avg(ran.map((r) => r.repairs)).toFixed(2)} | ${(avg(ran.map((r) => r.durationMs)) / 1000).toFixed(1)} s | ${fmtInt(avg(ran.map((r) => r.tokensIn)))} | ${fmtInt(avg(ran.map((r) => r.tokensOut)))} |\n`;
}
md += "\nArmadilhas: a nota automática só confere o que dá para medir (salvou ou não, não citou a outra marca). Leia as respostas abaixo.\n";
md += "\n## Por pedido\n\n| Pedido | Grupo | " + MODELS.join(" | ") + " |\n|---|---|" + MODELS.map(() => "---|").join("") + "\n";
for (const c of cases) {
  const cells = MODELS.map((m) => {
    const r = all.find((x) => x.id === c.id && x.model === m);
    if (!r) return "—";
    if (r.skipped) return "pulado";
    return `${r.pass ? "✅" : "❌"} ${((r.durationMs || 0) / 1000).toFixed(0)} s · ${r.repairs ?? "?"} rep.${r.calledProfile ? " · perfil" : ""}`;
  });
  md += `| ${c.id} | ${c.group} | ${cells.join(" | ")} |\n`;
}
const failed = all.filter((r) => !r.pass);
if (failed.length) {
  md += "\n## O que falhou\n\n";
  for (const r of failed) md += `- **${r.id} · ${r.model}:** ${r.skipped || r.fails.join("; ")}\n`;
}
md += "\n## Pedidos e respostas\n";
for (const c of cases) {
  md += `\n### ${c.id} · ${c.prompt}\n\n${c.trap ? `Esperado: ${c.trap}\n\n` : ""}`;
  for (const m of MODELS) {
    const r = all.find((x) => x.id === c.id && x.model === m);
    if (!r || r.skipped) continue;
    const blocks = r.spec ? blocksOf(r.spec).map((b) => `${b.kind}(${b.query.metric}${b.query.dimensions?.length ? " por " + b.query.dimensions.join("+") : ""})`).join(", ") : "sem rascunho";
    md += `- **${m}** · ferramentas: ${r.toolCalls.join(" → ") || "nenhuma"}\n  - blocos: ${blocks}\n  - resposta: ${(r.answer || "").replace(/\s+/g, " ").trim()}\n`;
  }
}
fs.writeFileSync(path.join(outDir, `${stamp}.md`), md);
console.log(`\nrelatório: evals/resultados/${stamp}.md`);
