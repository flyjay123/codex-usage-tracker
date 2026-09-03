const SERIES_COLORS = ["#2563eb", "#0f9f75", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f"];

function barChart(title, rows, field, formatter, element) {
  const maximum = Math.max(...rows.map((row) => Number(row[field]) || 0), 1);
  return element("section", { className: "comparison-chart" }, [
    element("h3", { text: title }),
    ...rows.map((row) => {
      const value = Number(row[field]) || 0;
      return element("div", { className: "comparison-bar-row" }, [
        element("span", { className: "comparison-name", text: row.label }),
        element("div", { className: "comparison-track" }, [
          element("div", {
            className: `comparison-fill ${field === "total_cost" ? "cost" : "tokens"}`,
            style: `width:${Math.max(value > 0 ? 2 : 0, (value / maximum) * 100)}%`,
          }),
        ]),
        element("strong", { className: "comparison-value", text: formatter(value) }),
      ]);
    }),
  ]);
}

function dailyChart(rows, element, formatNumber) {
  let field = "total_tokens";
  const chart = element("div", { className: "daily-chart" });
  const tokenButton = element("button", { className: "active", type: "button", text: "Token" });
  const costButton = element("button", { type: "button", text: "花费" });
  const dates = [...new Set(rows.flatMap((row) => row.daily_usage.map((day) => day.date)))].sort();
  const render = () => {
    const values = rows.flatMap((row) => row.daily_usage.map((day) => Number(day[field]) || 0));
    const maximum = Math.max(...values, 1);
    chart.replaceChildren(...dates.map((date) => element("section", { className: "daily-group" }, [
      element("h4", { text: date }),
      ...rows.map((row, index) => {
        const day = row.daily_usage.find((item) => item.date === date);
        const value = Number(day?.[field]) || 0;
        return element("div", { className: "daily-row" }, [
          element("span", { className: "daily-name", text: row.label }),
          element("div", { className: "comparison-track" }, [
            element("div", { className: "daily-fill", style: `width:${Math.max(value > 0 ? 2 : 0, value / maximum * 100)}%;background:${SERIES_COLORS[index % SERIES_COLORS.length]}` }),
          ]),
          element("strong", { className: "comparison-value", text: field === "total_cost" ? `${value.toFixed(2)} USD` : formatNumber(value) }),
        ]);
      }),
    ])));
  };
  const selectMetric = (nextField) => {
    field = nextField;
    tokenButton.classList.toggle("active", field === "total_tokens");
    costButton.classList.toggle("active", field === "total_cost");
    render();
  };
  tokenButton.addEventListener("click", () => selectMetric("total_tokens"));
  costButton.addEventListener("click", () => selectMetric("total_cost"));
  render();
  return element("section", { className: "daily-section" }, [
    element("div", { className: "daily-heading" }, [
      element("h3", { text: "每日趋势" }),
      element("div", { className: "metric-switch", role: "group", "aria-label": "每日对比指标" }, [tokenButton, costButton]),
    ]),
    dates.length ? chart : element("p", { className: "month-empty", text: "所选范围内没有每日数据。" }),
  ]);
}

export function createRelayComparisonPanel(keys, helpers) {
  const { element, errorPanel, formatNumber, request, usageCard } = helpers;
  const search = element("input", { type: "search", placeholder: "输入姓名筛选", "aria-label": "筛选对比账号" });
  const dateFrom = element("input", { type: "date", "aria-label": "开始日期" });
  const dateTo = element("input", { type: "date", "aria-label": "结束日期" });
  const keyList = element("div", { className: "comparison-key-list" });
  const selectedStatus = element("span", { className: "selection-status" });
  const result = element("div", { className: "comparison-result" });
  const compareButton = element("button", { className: "button primary", type: "button", text: "开始对比" });
  const selectVisible = element("button", { className: "button ghost", type: "button", text: "全选筛选结果" });
  const clearSelection = element("button", { className: "button ghost", type: "button", text: "清空" });
  const checks = keys.map((key) => {
    const checkbox = element("input", { type: "checkbox", value: key.id, "aria-label": `选择 ${key.label}` });
    const item = element("label", { className: "comparison-key", title: key.label }, [checkbox, element("span", { text: key.label })]);
    keyList.append(item);
    return { key, checkbox, item };
  });
  const updateCount = () => { selectedStatus.textContent = `已选 ${checks.filter(({ checkbox }) => checkbox.checked).length} / ${keys.length}`; };
  checks.forEach(({ checkbox }) => checkbox.addEventListener("change", updateCount));
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    checks.forEach(({ key, item }) => { item.hidden = Boolean(query) && !key.label.toLocaleLowerCase().includes(query); });
  });
  selectVisible.addEventListener("click", () => { checks.forEach(({ checkbox, item }) => { if (!item.hidden) checkbox.checked = true; }); updateCount(); });
  clearSelection.addEventListener("click", () => { checks.forEach(({ checkbox }) => { checkbox.checked = false; }); updateCount(); });
  updateCount();
  compareButton.addEventListener("click", async () => {
    const keyIds = checks.filter(({ checkbox }) => checkbox.checked).map(({ key }) => key.id);
    if (!keyIds.length) {
      result.replaceChildren(element("p", { className: "month-empty", text: "请至少选择一个账号。" }));
      return;
    }
    if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
      result.replaceChildren(element("p", { className: "month-empty", text: "开始日期不能晚于结束日期。" }));
      return;
    }
    compareButton.disabled = true;
    result.replaceChildren(element("div", { className: "loading", text: `正在查询 ${keyIds.length} 个账号…` }));
    try {
      const response = await request("/usage-provider/compare", {
        method: "POST",
        body: JSON.stringify({ key_ids: keyIds, date_from: dateFrom.value, date_to: dateTo.value }),
      });
      const rows = (response.rows || []).filter((row) => !row.error).sort((a, b) => b.total_cost - a.total_cost);
      const failures = (response.rows || []).filter((row) => row.error);
      result.replaceChildren(
        element("div", { className: "comparison-summary" }, [
          usageCard("账号数量", rows.length, "primary"),
          usageCard("合计 Token", rows.reduce((sum, row) => sum + row.total_tokens, 0)),
          usageCard("合计花费", `${rows.reduce((sum, row) => sum + row.total_cost, 0).toFixed(2)} USD`),
        ]),
        barChart("总消耗对比", rows, "total_tokens", formatNumber, element),
        barChart("总花费对比", rows, "total_cost", (value) => `${value.toFixed(2)} USD`, element),
        dailyChart(rows, element, formatNumber),
        failures.length ? element("p", { className: "comparison-warning", text: `查询失败：${failures.map((row) => row.label).join("、")}` }) : element("span"),
      );
    } catch (error) {
      result.replaceChildren(errorPanel(error));
    } finally {
      compareButton.disabled = false;
    }
  });
  return element("section", { className: "comparison-panel" }, [
    element("div", { className: "comparison-heading" }, [element("h2", { text: "账号用量对比" })]),
    element("div", { className: "comparison-filter-row" }, [search, element("label", {}, [element("span", { text: "开始" }), dateFrom]), element("label", {}, [element("span", { text: "结束" }), dateTo])]),
    element("div", { className: "selection-toolbar" }, [selectedStatus, selectVisible, clearSelection, compareButton]),
    keyList,
    result,
  ]);
}
