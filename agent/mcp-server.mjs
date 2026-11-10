// Servidor MCP (stdio) com as ferramentas do agente. Cada uma só repassa para a API por HTTP.
// Não há publish: publicar é um clique humano na página, nunca uma decisão do modelo.
//
// Tudo o que define "quem" e "onde" vem do serviço que disparou o agente, por variável de ambiente,
// nunca do modelo:
//   TENANT       o cliente
//   SESSION_ID   a sessão do Studio (vazio no /generate)
//   DRAFT_ID     o rascunho da sessão; no Studio, save_draft sempre grava nele (o modelo não escolhe o id)
//   ONLY_BLOCK   o bloco selecionado na tela; a API recusa mudanças nos outros
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.API_URL;
const TENANT = process.env.TENANT;
const PROMPT = process.env.PROMPT || null;
const SESSION_ID = process.env.SESSION_ID || null;
const ONLY_BLOCK = process.env.ONLY_BLOCK || null;
let sessionDraft = process.env.DRAFT_ID || null;   // no Studio, o 1º save_draft cria e os seguintes atualizam

async function call(method, path, body) {
  const r = await fetch(`${API}/api${path}`, {
    method,
    headers: { "X-Tenant": TENANT, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

const reply = (obj, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError });

// O modelo às vezes manda a spec (ou outro objeto) como string JSON em vez de objeto, e às vezes com um
// fechamento a mais no fim (o Haiku erra a conta de "}]}]}}"). Tirar até 3 fechamentos sobrando é seguro:
// o que sobra é exatamente o objeto que ele escreveu.
function asObject(v) {
  if (typeof v !== "string") return v;
  for (let cut = 0; cut <= 3; cut++) {
    const text = v.trimEnd().slice(0, v.trimEnd().length - cut);
    if (cut && !/[}\]]$/.test(v.trimEnd().slice(-cut))) break;
    try { return JSON.parse(text); } catch { /* tenta tirar mais um fechamento */ }
  }
  return v;
}

// Spec que nem é JSON: erro claro em vez do "Input should be a valid dictionary" do Pydantic.
function notJson(v) {
  let detail = "";
  try { JSON.parse(v); } catch (e) { detail = e.message; }
  return reply({
    valid: false, saved: false, stage: "schema",
    errors: [{ blockId: null, path: "", message: `a spec chegou como texto que não é JSON válido (${detail})`,
      hint: "mande a spec como objeto JSON, não como string, e confira se chaves e colchetes fecham" }],
  }, true);
}

const server = new McpServer({ name: "dash", version: "0.2.0" });

server.registerTool("get_kit", {
  description: "Devolve o kit: os tipos de bloco e quando usar cada um, as regras da grade de 12 colunas, " +
    "os campos aceitos na spec e um exemplo completo. Chame antes de montar.",
  inputSchema: {},
}, async () => reply((await call("GET", "/kit")).data));

server.registerTool("get_catalog", {
  description: "Devolve as métricas que este cliente pode usar (id, descrição, unidade, dimensões aceitas, se aceita " +
    "período), as dimensões e os períodos. Só existem as métricas daqui.",
  inputSchema: {},
}, async () => reply((await call("GET", "/catalog")).data));

server.registerTool("profile_data", {
  description: "Resumo do dado de uma métrica nos últimos 90 dias: valores existentes de cada dimensão pedida (ids e " +
    "nomes, até 12), faixa de valores e 5 linhas de exemplo. Use para descobrir ids de filtros (estado, canal, " +
    "categoria, segmento, produto) e quantos valores uma dimensão tem. Não aceita filtros.",
  inputSchema: {
    metric: z.string().describe("id da métrica no catálogo"),
    dimensions: z.array(z.string()).default([]).describe("dimensões a perfilar, ex.: ['state']"),
  },
}, async ({ metric, dimensions }) => {
  const r = await call("POST", "/profile", { metric, dimensions });
  return reply(r.data, r.status !== 200);
});

server.registerTool("validate_spec", {
  description: "Valida a spec sem salvar: formato, sentido (catálogo e regras do kit), regras de edição (quando há " +
    "rascunho) e dry-run com dado real. Devolve valid, a porta em que parou (stage) e os erros com dica (hint).",
  inputSchema: { spec: z.any().describe("a spec completa, como objeto JSON") },
}, async ({ spec }) => {
  const obj = asObject(spec);
  if (typeof obj === "string") return notJson(obj);
  const draftId = SESSION_ID ? sessionDraft : null;
  const r = await call("POST", "/validate", { spec: obj, draft_id: draftId, only_block: ONLY_BLOCK });
  return reply(r.data, !r.data?.valid);
});

server.registerTool("save_draft", {
  description: SESSION_ID
    ? "Valida e salva a spec no rascunho desta sessão do Studio (o primeiro save cria; os seguintes atualizam). " +
      "Se a spec for inválida, nada é salvo e os erros voltam. Publicar não é com você: a pessoa publica na tela."
    : "Valida e salva a spec como rascunho. Sem draft_id cria um rascunho novo; com draft_id atualiza aquele " +
      "rascunho. Se a spec for inválida, nada é salvo e os erros voltam. Publicar não é com você: a pessoa publica na tela.",
  inputSchema: {
    spec: z.any().describe("a spec completa, como objeto JSON"),
    draft_id: z.string().optional().describe(SESSION_ID ? "ignorado no Studio" : "id do rascunho a atualizar (só na edição)"),
  },
}, async ({ spec, draft_id }) => {
  const obj = asObject(spec);
  if (typeof obj === "string") return notJson(obj);
  const body = { spec: obj, created_via: "agent", prompt: PROMPT };
  if (SESSION_ID) {
    Object.assign(body, { session_id: SESSION_ID, only_block: ONLY_BLOCK });
    const r = sessionDraft ? await call("PUT", `/drafts/${sessionDraft}`, body) : await call("POST", "/drafts", body);
    if (r.status === 200) sessionDraft = r.data.id;
    return reply(r.data, r.status !== 200);
  }
  const r = draft_id ? await call("PUT", `/drafts/${draft_id}`, body) : await call("POST", "/drafts", body);
  return reply(r.data, r.status !== 200);
});

server.registerTool("get_draft", {
  description: "Lê a spec atual de um rascunho (para editar).",
  inputSchema: { draft_id: z.string().optional().describe(SESSION_ID ? "opcional no Studio" : "id do rascunho") },
}, async ({ draft_id }) => {
  const id = draft_id || sessionDraft;
  if (!id) return reply({ detail: "ainda não há rascunho nesta sessão" }, true);
  const r = await call("GET", `/dashboards/${id}`);
  if (r.status !== 200) return reply(r.data, true);
  return reply({ id: r.data.id, title: r.data.title, spec: r.data.spec });
});

// Só no Studio: perguntar com opções. A pessoa responde na tela, e a resposta chega no próximo turno.
if (SESSION_ID) {
  const option = z.object({
    id: z.string().describe("id curto, ex.: 'gap'"),
    label: z.string().describe("o que a pessoa lê, ex.: 'Receita em R$'"),
    detail: z.string().optional().describe("linha de apoio, ex.: 'vendas · soma do período' ou 'estado (6) · canal (5)'"),
    recommended: z.boolean().optional().describe("marque exatamente uma opção por pergunta"),
  });
  server.registerTool("propose_options", {
    description: "Faz até 3 perguntas com opções quando o pedido está aberto (mais de uma métrica, recorte ou peça " +
      "plausível). Cada pergunta tem um slot (metric, dimensions, visualization ou period), 2 a 4 opções e uma " +
      "recomendada. Mande também plan: o esboço dos blocos que pretende montar, para o canvas mostrar. Depois de " +
      "chamar, encerre sua vez com uma frase curta: a resposta chega na próxima mensagem.",
    inputSchema: {
      questions: z.array(z.object({
        id: z.string(),
        slot: z.enum(["metric", "dimensions", "visualization", "period"]),
        title: z.string().describe("a pergunta, ex.: 'O que você quer comparar?'"),
        options: z.array(option).min(2).max(4),
      })).min(1).max(3),
      plan: z.object({
        blocks: z.array(z.object({
          kind: z.string(), title: z.string(), span: z.number().int().min(1).max(12),
          note: z.string().optional().describe("ex.: 'estado × canal, 6 × 5' ou 'top 10'"),
        })).max(8),
      }).optional(),
      metric: z.string().optional().describe("id da métrica principal que pretende usar (para o cartão 'Vai consultar')"),
    },
  }, async (raw) => {
    const input = { questions: asObject(raw.questions), plan: asObject(raw.plan) || null, metric: raw.metric || null };
    const r = await call("POST", `/studio/sessions/${SESSION_ID}/messages`, { role: "choices", content: input });
    if (r.status !== 200) return reply({ detail: r.data?.detail || "não consegui enviar as perguntas" }, true);
    return reply({
      sent: true, questions: input.questions.length, message: r.data,
      next: "Perguntas enviadas para a tela. Encerre sua vez agora com uma frase curta, sem chamar outras ferramentas.",
    });
  });
}

await server.connect(new StdioServerTransport());
