function comparisonChart(title, rows, field, formatter, element) {
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

export function createRelayComparisonPanel(keys, helpers) {
  const { element, errorPanel, formatNumber, request, usageCard } = helpers;
  const search = element("input", { type: "search", placeholder: "筛选账号", "aria-label": "筛选对比账号" });
  const dateFrom = element("input", { type: "date", "aria-label": "开始日期" });
  const dateTo = element("input", { type: "date", "aria-label": "结束日期" });
  const keyList = element("div", { className: "comparison-key-list" });
  const result = element("div", { className: "comparison-result" });
  const compareButton = element("button", { className: "button primary", type: "button", text: "开始对比" });
  const selectVisible = element("button", { className: "button ghost", type: "button", text: "选择筛选结果" });
  const clearSelection = element("button", { className: "button ghost", type: "button", text: "清空选择" });
  const checks = keys.map((key) => {
    const checkbox = element("input", { type: "checkbox", value: key.id, "aria-label": `选择 ${key.label}` });
    const item = element("label", { className: "comparison-key" }, [checkbox, element("span", { text: key.label })]);
    keyList.append(item);
    return { key, checkbox, item };
  });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    checks.forEach(({ key, item }) => { item.hidden = Boolean(query) && !key.label.toLocaleLowerCase().includes(query); });
  });
  selectVisible.addEventListener("click", () => checks.forEach(({ checkbox, item }) => { if (!item.hidden) checkbox.checked = true; }));
  clearSelection.addEventListener("click", () => checks.forEach(({ checkbox }) => { checkbox.checked = false; }));
  compareButton.addEventListener("click", async () => {
    const keyIds = checks.filter(({ checkbox }) => checkbox.checked).map(({ key }) => key.id);
    if (!keyIds.length) {
      result.replaceChildren(element("p", { className: "month-empty", text: "请至少选择一个账号。" }));
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
        comparisonChart("总消耗对比", rows, "total_tokens", formatNumber, element),
        comparisonChart("总花费对比", rows, "total_cost", (value) => `${value.toFixed(2)} USD`, element),
        failures.length ? element("p", { className: "comparison-warning", text: `${failures.length} 个账号查询失败，已跳过。` }) : element("span"),
      );
    } catch (error) {
      result.replaceChildren(errorPanel(error));
    } finally {
      compareButton.disabled = false;
    }
  });
  return element("section", { className: "comparison-panel" }, [
    element("div", { className: "comparison-heading" }, [
      element("h2", { text: "账号用量对比" }),
      element("p", { className: "month-hint", text: "选择账号和日期范围，对比总 Token 与实际花费。日期留空时统计全部数据。" }),
    ]),
    element("div", { className: "comparison-filters" }, [search, dateFrom, dateTo, selectVisible, clearSelection, compareButton]),
    keyList,
    result,
  ]);
}
