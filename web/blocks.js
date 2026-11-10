// O renderer: um registro {kind → desenho}. É igual para todo dashboard que existir.
// Cada bloco recebe o dado no formato fixo do seu kind (ver api/app/query.py::_shape).

const Fmt = {
  number: new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }),
  money: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }),
  moneyBig: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 2 }),
  value(v, unit, signed = false) {
    if (v === null || v === undefined) return "—";
    if (unit === "percent") {
      const s = (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return (signed && v > 0 ? "+" : "") + s + "%";
    }
    if (unit === "currency") return Math.abs(v) >= 100000 ? Fmt.moneyBig.format(v) : Fmt.money.format(v);
    return Fmt.number.format(v);
  },
  short(v, unit) {
    if (unit === "percent") return Fmt.value(v, unit);
    if (unit === "currency") return Math.abs(v) >= 100000 ? Fmt.moneyBig.format(v) : "R$ " + Fmt.number.format(v);
    return Fmt.number.format(v);
  },
  day(iso) {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  },
  dateTime(iso) {
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  },
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6"];

function toneColor(tone) {
  return cssVar({ positive: "--positive", negative: "--negative", neutral: "--neutral" }[tone] || "--accent");
}

const charts = new Set();
function makeChart(el) {
  const c = echarts.init(el, null, { renderer: "svg" });
  charts.add(c);
  return c;
}
function disposeCharts() {
  charts.forEach((c) => c.dispose());
  charts.clear();
}
window.addEventListener("resize", () => charts.forEach((c) => c.resize()));

function baseOption(unit) {
  const muted = cssVar("--muted"), border = cssVar("--border");
  return {
    animationDuration: 400,
    textStyle: { fontFamily: "Segoe UI, system-ui, sans-serif", color: muted },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: cssVar("--surface"),
      borderColor: border,
      textStyle: { color: cssVar("--text") },
      valueFormatter: (v) => Fmt.value(v, unit),
    },
    _axisValue: {
      type: "value",
      axisLabel: { color: muted, formatter: (v) => Fmt.short(v, unit) },
      splitLine: { lineStyle: { color: border } },
    },
    _axisCat: { axisLine: { lineStyle: { color: border } }, axisTick: { show: false }, axisLabel: { color: muted } },
  };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function chartBody(body, height) {
  if (height) body.style.minHeight = height + "px";
  const c = el("div", "chart-el");
  body.appendChild(c);
  return makeChart(c);
}

const BLOCKS = {
  kpi: {
    chart: false,
    render(body, block, res) {
      const v = el("div", "kpi-value", Fmt.value(res.data.value, res.unit, res.signed));
      v.style.color = block.tone ? toneColor(block.tone === "diverging" ? (res.data.value >= 0 ? "negative" : "positive") : block.tone) : "";
      body.appendChild(v);
      if (res.metric.label.toLowerCase() !== block.title.toLowerCase()) body.appendChild(el("div", "kpi-label", res.metric.label));
    },
  },

  kpi_progress: {
    chart: false,
    render(body, block, res) {
      const { value, total, of_label } = res.data;
      const pct = total ? Math.max(0, Math.min(1, value / total)) : 0;
      const text = of_label ? `${Fmt.value(value, res.unit)} de ${Fmt.value(total, "count")}` : Fmt.value(value, res.unit);
      const v = el("div", "kpi-value", text);
      const bar = el("div", "progress");
      const fill = el("div");
      fill.style.width = (pct * 100).toFixed(1) + "%";
      fill.style.background = toneColor(block.tone);
      bar.appendChild(fill);
      const label = of_label ? `${(pct * 100).toFixed(0)}% de ${of_label.toLowerCase()}` : `${res.metric.label} · meta 100%`;
      body.append(v, bar, el("div", "kpi-label", label));
    },
  },

  ranking_bar: {
    chart: true,
    render(body, block, res) {
      const items = res.data.items;
      const chart = chartBody(body, Math.max(200, items.length * 30 + 30));
      const o = baseOption(res.unit);
      const diverging = block.tone === "diverging";
      chart.setOption({
        ...o,
        xAxis: { ...o._axisValue },
        yAxis: { type: "category", inverse: true, data: items.map((i) => i.label), ...o._axisCat },
        series: [{
          type: "bar",
          barMaxWidth: 22,
          data: items.map((i) => ({
            value: i.value,
            itemStyle: {
              color: diverging ? (i.value >= 0 ? cssVar("--div-pos") : cssVar("--div-neg")) : toneColor(block.tone),
              borderRadius: 3,
            },
          })),
          label: { show: true, position: "right", color: cssVar("--muted"), formatter: (p) => Fmt.value(p.value, res.unit, res.signed) },
        }],
        grid: { ...o.grid, right: 64 },
      });
    },
  },

  bar: {
    chart: true,
    render(body, block, res) {
      const items = res.data.items;
      const chart = chartBody(body);
      const o = baseOption(res.unit);
      const cats = [...new Map(items.map((i) => [i.key, i.label])).values()];
      const hasSeries = items.some((i) => i.series !== undefined);
      let series;
      if (hasSeries) {
        const names = [...new Set(items.map((i) => i.series_label))];
        series = names.map((name, k) => ({
          type: "bar", name, barMaxWidth: 26, itemStyle: { color: cssVar(SERIES_VARS[k % 6]), borderRadius: 3 },
          data: cats.map((c) => items.find((i) => i.label === c && i.series_label === name)?.value ?? null),
        }));
      } else {
        series = [{
          type: "bar", barMaxWidth: 36, itemStyle: { color: toneColor(block.tone), borderRadius: 3 },
          data: items.map((i) => i.value),
          label: { show: items.length <= 8, position: "top", color: cssVar("--muted"), formatter: (p) => Fmt.short(p.value, res.unit) },
        }];
      }
      // Gira os rótulos quando não cabem lado a lado (≈7 px por caractere).
      const perCat = body.clientWidth / Math.max(1, cats.length);
      const longest = Math.max(...cats.map((c) => String(c).length));
      const rotate = longest * 7 > perCat ? 35 : 0;
      chart.setOption({
        ...o,
        legend: hasSeries ? { top: 0, textStyle: { color: cssVar("--muted") } } : undefined,
        grid: { ...o.grid, top: hasSeries ? 32 : 20 },
        xAxis: { type: "category", data: cats, ...o._axisCat, axisLabel: { ...o._axisCat.axisLabel, interval: 0, rotate } },
        yAxis: { ...o._axisValue },
        series,
      });
    },
  },

  line: {
    chart: true,
    render(body, block, res) {
      const points = res.data.points;
      const chart = chartBody(body);
      const o = baseOption(res.unit);
      // Eixo com todos os dias do período: dia sem carga vira buraco na linha, não um traço enganoso.
      const days = [];
      for (let d = new Date(res.period.from + "T00:00:00Z"); d <= new Date(res.period.to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
        days.push(d.toISOString().slice(0, 10));
      }
      const hasSeries = points.some((p) => p.series !== undefined);
      const groups = new Map();
      for (const p of points) {
        const k = hasSeries ? p.series_label : res.metric.label;
        if (!groups.has(k)) groups.set(k, new Map());
        groups.get(k).set(p.x, p.value);
      }
      const series = [...groups.entries()].map(([name, byDay], k) => ({
        type: "line", name, showSymbol: false, connectNulls: false, smooth: false,
        lineStyle: { width: 2 },
        itemStyle: { color: hasSeries ? cssVar(SERIES_VARS[k % 6]) : toneColor(block.tone) },
        data: days.map((d) => (byDay.has(d) ? byDay.get(d) : null)),
      }));
      chart.setOption({
        ...o,
        tooltip: { ...o.tooltip, axisPointer: { type: "line" } },
        legend: hasSeries ? { top: 0, type: "scroll", textStyle: { color: cssVar("--muted") } } : undefined,
        grid: { ...o.grid, top: hasSeries ? 32 : 16 },
        xAxis: { type: "category", data: days.map(Fmt.day), boundaryGap: false, ...o._axisCat },
        // Só valor em R$ usa escala livre; contagem e % começam do zero para não exagerar a variação.
        yAxis: { ...o._axisValue, scale: res.unit === "currency" },
        series,
      });
    },
  },

  table: {
    chart: false,
    render(body, block, res) {
      const { columns, rows } = res.data;
      const wrap = el("div", "table-wrap");
      const t = el("table", "data");
      const head = el("tr");
      columns.forEach((c) => head.appendChild(el("th", c.type === "metric" ? "num" : "", c.label)));
      t.appendChild(el("thead")).appendChild(head);
      const tb = el("tbody");
      rows.forEach((r) => {
        const tr = el("tr");
        columns.forEach((c) => {
          tr.appendChild(c.type === "metric" ? el("td", "num", Fmt.value(r[c.key], c.unit, c.signed)) : el("td", "", r[c.key]));
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      body.appendChild(wrap);
    },
  },
};

BLOCKS.heatmap = {
  chart: true,
  render(body, block, res) {
    const items = res.data.items;
    const rows = [...new Map(items.map((i) => [i.key, i.label])).values()];
    const cols = [...new Map(items.map((i) => [i.series, i.series_label])).values()];
    const chart = chartBody(body, Math.max(220, rows.length * 34 + 80));
    const o = baseOption(res.unit);
    const vals = items.map((i) => i.value);
    // Valor com sinal: escala simétrica em volta do zero (azul = abaixo, laranja = acima).
    const diverging = block.tone === "diverging" || res.signed;
    const maxAbs = Math.max(...vals.map(Math.abs)) || 1;
    const [min, max] = diverging ? [-maxAbs, maxAbs] : [Math.min(...vals), Math.max(...vals)];
    const colors = diverging
      ? [cssVar("--div-neg"), cssVar("--surface-2"), cssVar("--div-pos")]
      : [cssVar("--surface-2"), toneColor(block.tone)];
    const fmt = (v) => (res.unit === "percent" ? Fmt.value(v, res.unit, res.signed) : Fmt.short(v, res.unit));
    const perCol = body.clientWidth / Math.max(1, cols.length);
    const rotate = Math.max(...cols.map((c) => String(c).length)) * 7 > perCol ? 30 : 0;
    chart.setOption({
      ...o,
      tooltip: {
        ...o.tooltip, trigger: "item",
        formatter: (p) => `${rows[p.value[1]]} · ${cols[p.value[0]]}<br><b>${Fmt.value(p.value[2], res.unit, res.signed)}</b>`,
      },
      grid: { ...o.grid, top: 8, bottom: 48 },
      xAxis: { type: "category", data: cols, ...o._axisCat, axisLabel: { ...o._axisCat.axisLabel, interval: 0, rotate } },
      yAxis: { type: "category", data: rows, inverse: true, ...o._axisCat },
      visualMap: {
        min, max, calculable: false, orient: "horizontal", left: "center", bottom: 0,
        itemWidth: 10, itemHeight: 140, inRange: { color: colors },
        textStyle: { color: cssVar("--muted") }, formatter: (v) => fmt(v),
      },
      series: [{
        type: "heatmap",
        data: items.map((i) => [cols.indexOf(i.series_label), rows.indexOf(i.label), i.value]),
        label: { show: items.length <= 80, color: cssVar("--text"), fontSize: 11, formatter: (p) => fmt(p.value[2]) },
        itemStyle: { borderColor: cssVar("--surface"), borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: cssVar("--text") } },
      }],
    });
  },
};

// Desenha um bloco num card. `load` é a função que busca o dado deste bloco na API.
async function renderBlock(card, block, load) {
  const kind = BLOCKS[block.kind];
  card.className = "block" + (kind?.chart ? " chart" : "");
  card.innerHTML = "";
  const head = el("div", "bh");
  const titles = el("div");
  titles.appendChild(el("h3", "", block.title));
  if (block.subtitle) titles.appendChild(el("div", "bs", block.subtitle));
  head.append(titles, el("span", "kind", block.kind));
  const body = el("div", "body");
  const foot = el("div", "foot");
  card.append(head, body, foot);
  body.appendChild(el("div", "skeleton"));

  if (!kind) {
    body.innerHTML = "";
    body.appendChild(el("div", "state error", `Bloco desconhecido: ${block.kind}`));
    return null;
  }
  let res;
  try {
    res = await load();
  } catch (e) {
    res = { status: "error", message: e.message };
  }
  body.innerHTML = "";
  if (res.status === "error") {
    body.appendChild(el("div", "state error", res.message || "Erro ao buscar o dado."));
    return res;
  }
  if (res.status === "empty") {
    body.appendChild(el("div", "state", "Sem dado para esse recorte."));
  } else {
    kind.render(body, block, res);
  }
  if (res.period) foot.textContent = `${res.metric.label} · ${res.period.label} (${Fmt.day(res.period.from)} a ${Fmt.day(res.period.to)})`;
  return res;
}
