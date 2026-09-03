const COLORS = ["#2563eb", "#0f9f75", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f"];

function localDate(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function lineChart(rows, field, container, formatNumber) {
  const dates = [...new Set(rows.flatMap((row) => row.daily_usage.map((day) => day.date)))].sort();
  const width = Math.max(container.clientWidth, 320);
  const height = width < 560 ? 330 : 390;
  const margin = { top: 18, right: 18, bottom: 48, left: width < 560 ? 58 : 76 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const values = rows.flatMap((row) => row.daily_usage.map((day) => Number(day[field]) || 0));
  const maximum = Math.max(...values, 1);
  const x = (index) => dates.length === 1 ? margin.left + innerWidth / 2 : margin.left + index * innerWidth / (dates.length - 1);
  const y = (value) => margin.top + innerHeight - value / maximum * innerHeight;
  const svg = svgElement("svg", { class: "comparison-line-chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": field === "total_cost" ? "每日花费对比折线图" : "每日 Token 对比折线图" });
  for (let index = 0; index <= 4; index += 1) {
    const value = maximum * index / 4;
    const position = y(value);
    svg.append(svgElement("line", { class: "comparison-grid", x1: margin.left, x2: width - margin.right, y1: position, y2: position }));
    const label = svgElement("text", { class: "comparison-axis", x: margin.left - 10, y: position + 4, "text-anchor": "end" });
    label.textContent = field === "total_cost" ? value.toFixed(1) : formatNumber(value);
    svg.append(label);
  }
  const tickEvery = Math.max(1, Math.ceil(dates.length / (width < 560 ? 4 : 7)));
  dates.forEach((date, index) => {
    if (index % tickEvery && index !== dates.length - 1) return;
    const label = svgElement("text", { class: "comparison-axis", x: x(index), y: height - 16, "text-anchor": index === 0 ? "start" : index === dates.length - 1 ? "end" : "middle" });
    label.textContent = date.slice(5);
    svg.append(label);
  });
  rows.forEach((row, rowIndex) => {
    const byDate = new Map(row.daily_usage.map((day) => [day.date, Number(day[field]) || 0]));
    const points = dates.map((date, index) => [x(index), y(byDate.get(date) || 0), date, byDate.get(date) || 0]);
    svg.append(svgElement("polyline", { class: "comparison-series", points: points.map(([px, py]) => `${px},${py}`).join(" "), stroke: COLORS[rowIndex % COLORS.length] }));
    points.forEach(([px, py, date, value]) => {
      const point = svgElement("circle", { class: "comparison-point", cx: px, cy: py, r: 4, fill: COLORS[rowIndex % COLORS.length] });
      const title = svgElement("title");
      title.textContent = `${date} · ${row.label} · ${field === "total_cost" ? `${Number(value).toFixed(2)} USD` : formatNumber(value)}`;
      point.append(title);
      svg.append(point);
    });
  });
  container.replaceChildren(svg);
}

function comparisonResult(rows, helpers) {
  const { element, formatNumber } = helpers;
  let field = "total_tokens";
  const plot = element("div", { className: "comparison-plot" });
  const title = element("h2", { text: "每日 Token 对比" });
  const total = element("span", { className: "comparison-total" });
  const tokenButton = element("button", { className: "active", type: "button", text: "Token" });
  const costButton = element("button", { type: "button", text: "花费" });
  const legend = element("div", { className: "comparison-legend" }, rows.map((row, index) => element("span", {}, [
    element("i", { style: `background:${COLORS[index % COLORS.length]}` }), document.createTextNode(row.label),
  ])));
  const draw = () => {
    title.textContent = field === "total_cost" ? "每日花费对比" : "每日 Token 对比";
    const sum = rows.reduce((value, row) => value + Number(row[field]), 0);
    total.textContent = `${rows.length} 个账号 · ${field === "total_cost" ? `${sum.toFixed(2)} USD` : `${formatNumber(sum)} Token`}`;
    lineChart(rows, field, plot, formatNumber);
  };
  const selectMetric = (next) => {
    field = next;
    tokenButton.classList.toggle("active", field === "total_tokens");
    costButton.classList.toggle("active", field === "total_cost");
    draw();
  };
  tokenButton.addEventListener("click", () => selectMetric("total_tokens"));
  costButton.addEventListener("click", () => selectMetric("total_cost"));
  requestAnimationFrame(draw);
  new ResizeObserver(draw).observe(plot);
  return element("section", { className: "comparison-result" }, [
    element("div", { className: "comparison-chart-heading" }, [element("div", {}, [title, total]), element("div", { className: "metric-switch", role: "group", "aria-label": "对比指标" }, [tokenButton, costButton])]),
    legend, plot,
  ]);
}

export function createRelayComparisonPanel(keys, helpers) {
  const { element, errorPanel, request } = helpers;
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 6);
  const dateFrom = element("input", { type: "date", value: localDate(weekAgo), "aria-label": "开始日期" });
  const dateTo = element("input", { type: "date", value: localDate(now), "aria-label": "结束日期" });
  const search = element("input", { type: "search", placeholder: "搜索账号", "aria-label": "搜索账号" });
  const keyList = element("div", { className: "comparison-key-list" });
  const pickerLabel = element("span", { text: "选择账号" });
  const notice = element("span", { className: "selection-status", role: "status" });
  const output = element("div", { className: "comparison-output" }, [element("p", { className: "empty", text: "选择账号后开始对比。" })]);
  const picker = element("details", { className: "account-picker" });
  const selected = new Set();
  const checks = keys.map((key) => {
    const checkbox = element("input", { type: "checkbox", value: key.id, "aria-label": `选择 ${key.label}` });
    const item = element("label", { className: "comparison-key" }, [checkbox, element("span", { text: key.label })]);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && selected.size >= 8) {
        checkbox.checked = false;
        notice.textContent = "一次最多对比 8 个账号。";
        return;
      }
      if (checkbox.checked) selected.add(key.id); else selected.delete(key.id);
      pickerLabel.textContent = selected.size ? `已选 ${selected.size} 个账号` : "选择账号";
      notice.textContent = "";
    });
    keyList.append(item);
    return { key, item };
  });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    checks.forEach(({ key, item }) => { item.hidden = Boolean(query) && !key.label.toLocaleLowerCase().includes(query); });
  });
  picker.append(element("summary", {}, [pickerLabel]), element("div", { className: "account-menu" }, [search, keyList]));
  const compareButton = element("button", { className: "button primary", type: "button", text: "开始对比" });
  compareButton.addEventListener("click", async () => {
    if (!selected.size) {
      notice.textContent = "请至少选择一个账号。";
      return;
    }
    if (dateFrom.value > dateTo.value) {
      notice.textContent = "开始日期不能晚于结束日期。";
      return;
    }
    picker.open = false;
    notice.textContent = "";
    compareButton.disabled = true;
    output.replaceChildren(element("div", { className: "loading", text: `正在查询 ${selected.size} 个账号…` }));
    try {
      const response = await request("/usage-provider/compare", { method: "POST", body: JSON.stringify({ key_ids: [...selected], date_from: dateFrom.value, date_to: dateTo.value }) });
      const rows = (response.rows || []).filter((row) => !row.error && row.daily_usage?.length);
      const failures = (response.rows || []).filter((row) => row.error);
      output.replaceChildren(rows.length ? comparisonResult(rows, helpers) : element("p", { className: "empty", text: "所选范围内没有可对比的数据。" }));
      if (failures.length) output.append(element("p", { className: "comparison-warning", text: `查询失败：${failures.map((row) => row.label).join("、")}` }));
    } catch (error) {
      output.replaceChildren(errorPanel(error));
    } finally {
      compareButton.disabled = false;
    }
  });
  if (!keys.length) return element("p", { className: "empty", text: "请先在用量页面保存中转站 API Key。" });
  return element("section", { className: "comparison-page" }, [
    element("div", { className: "comparison-filter-row" }, [element("label", {}, [element("span", { text: "开始日期" }), dateFrom]), element("label", {}, [element("span", { text: "结束日期" }), dateTo]), picker, compareButton]),
    notice, output,
  ]);
}
