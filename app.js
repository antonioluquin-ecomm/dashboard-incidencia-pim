(function () {
  const cfg = window.PIM_INCIDENT_CONFIG;
  const manualPayments = new Set((cfg.manualPaymentMethods || []).map(normalizeText));

  const state = {
    raw: {
      pedidosError: [],
      pedidosPim: [],
      darDeBaja: [],
      cronologia: [],
      skuResumen: []
    },
    filters: {
      errores: { search: "", field: null, value: null, page: 1, perPage: 50 },
      bajas: { search: "", field: null, value: null, page: 1, perPage: 25 }
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", () => {
    bindUi();
    loadData();
  });

  function bindUi() {
    $("#refreshButton").addEventListener("click", loadData);
    $$(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.dataset.tab));
    });
    $("#searchErrores").addEventListener("input", (event) => {
      state.filters.errores.search = event.target.value.trim().toLowerCase();
      state.filters.errores.page = 1;
      renderPedidosError();
    });
    $("#searchBajas").addEventListener("input", (event) => {
      state.filters.bajas.search = event.target.value.trim().toLowerCase();
      state.filters.bajas.page = 1;
      renderBajas();
    });
    $$("[data-filter-table]").forEach((btn) => {
      btn.addEventListener("click", () => handleFilterButton(btn));
    });
  }

  async function loadData() {
    setLoading(true);
    clearError();

    try {
      const payload = cfg.dataMode === "appsScript" && cfg.appScriptUrl
        ? await fetchAppsScript()
        : await fetchPublishedCsv();

      state.raw.pedidosError = normalizeRows(payload.pedidosError || []);
      state.raw.pedidosPim = normalizeRows(payload.pedidosPim || []);
      state.raw.darDeBaja = normalizeRows(payload.darDeBaja || []);
      state.raw.cronologia = normalizeRows(payload.cronologia || []);
      state.raw.skuResumen = normalizeRows(payload.skuResumen || []);

      $("#sourceStatus").textContent = payload.sourceLabel || "Datos cargados";
      $("#sourceStatus").className = "status-pill ok";
      $("#lastUpdate").textContent = new Date().toLocaleString("es-AR");
      renderAll();
    } catch (error) {
      $("#sourceStatus").textContent = "Sin conexion";
      $("#sourceStatus").className = "status-pill error";
      showError("No se pudieron cargar los datos. " + error.message);
      renderAll();
    } finally {
      setLoading(false);
    }
  }

  async function fetchPublishedCsv() {
    const response = await fetch(cfg.csvUrl + cacheBust(cfg.csvUrl), { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const text = await response.text();
    return {
      sourceLabel: "CSV publicado",
      pedidosError: parseCsv(text),
      pedidosPim: [],
      darDeBaja: [],
      cronologia: [],
      skuResumen: []
    };
  }

  async function fetchAppsScript() {
    const response = await fetch(cfg.appScriptUrl + cacheBust(cfg.appScriptUrl), { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    return {
      sourceLabel: "Apps Script",
      pedidosError: payload.pedidosError || payload.pedidos_error || [],
      pedidosPim: payload.pedidosPim || payload.pedidos_pim || [],
      darDeBaja: payload.darDeBaja || payload.dar_de_baja || [],
      cronologia: payload.cronologia || [],
      skuResumen: payload.skuResumen || payload.sku_resumen || []
    };
  }

  function cacheBust(url) {
    return String(url || "").includes("?") ? "&t=" + Date.now() : "?t=" + Date.now();
  }

  function renderAll() {
    const metrics = buildMetrics();
    renderRiskStrip(metrics);
    renderSummaryKpis(metrics);
    renderPaymentBreakdown(metrics);
    renderHourChart(metrics);
    renderPedidosError();
    renderTimeline();
    renderSku();
    renderPimKpis(metrics);
    renderBajas();
  }

  function buildMetrics() {
    const pedidosError = state.raw.pedidosError;
    const pedidosPim = state.raw.pedidosPim;
    const bajas = state.raw.darDeBaja;
    const paymentCounts = groupCount(pedidosError, getPayment);
    const totalError = pedidosError.length;
    const manual = pedidosError.filter((row) => manualPayments.has(normalizeText(getPayment(row)))).length;
    const automatico = Math.max(0, totalError - manual);
    const hourCounts = groupCount(pedidosError, getRealHour);
    const pimsUnicos = uniqueCount(pedidosPim, ["Nro Pedido", "nro_pedido_canal", "Nro pedido"]);
    const bajaPedidos = uniqueCount(bajas, ["nro_pedido_canal", "Nro Pedido", "pedido"]);
    const despachados = bajas.filter((row) => hasDispatch(row)).length;
    const totalPagado = sumBy(bajas, ["importe_pagado", "Importe Pagado", "pagado"]);
    const totalDiff = sumBy(bajas, ["diff$", "Diff", "diff"]);

    return {
      totalError,
      expectedError: cfg.expectedTotals.pedidosError,
      pedidosPimItems: pedidosPim.length,
      pedidosPimUnicos: pimsUnicos,
      bajaItems: bajas.length,
      bajaPedidos,
      despachados,
      totalPagado,
      totalDiff,
      manual,
      automatico,
      paymentCounts,
      hourCounts
    };
  }

  function renderRiskStrip(metrics) {
    const hasPartialSheet = metrics.totalError > 0 && metrics.totalError < cfg.expectedTotals.pedidosError;
    const connectedParts = [
      metrics.totalError ? "pedidos con error" : null,
      metrics.pedidosPimItems ? "PIM" : null,
      metrics.bajaItems ? "bajas" : null
    ].filter(Boolean).join(", ");

    $("#riskStrip").innerHTML = hasPartialSheet
      ? `<strong>Base parcial conectada:</strong> se cargaron ${fmt(metrics.totalError)} pedidos (${connectedParts || "CSV publicado"}). El Excel de referencia indica ${fmt(cfg.expectedTotals.pedidosError)} pedidos con error. Para el tablero completo, publicar las pestañas por Apps Script.`
      : `<strong>Base conectada:</strong> ${connectedParts || "sin datos visibles todavia"}. Actualizar el Google Sheet refresca este tablero.`;
  }

  function renderSummaryKpis(metrics) {
    $("#summaryKpis").innerHTML = [
      kpi("Pedidos con error", fmt(metrics.totalError || metrics.expectedError), metrics.totalError ? "Cargados desde la base" : "Total esperado por Excel", "red"),
      kpi("Gestion manual", fmt(metrics.manual), "MercadoPago Pro + GoCuotas", "orange"),
      kpi("Gestion automatica", fmt(metrics.automatico), "Resto de medios de pago", "green"),
      kpi("Items PIM", fmt(metrics.pedidosPimItems || cfg.expectedTotals.pedidosPimItems), metrics.pedidosPimItems ? `${fmt(metrics.pedidosPimUnicos)} pedidos unicos` : "Pendiente Apps Script", "blue"),
      kpi("Items a dar de baja", fmt(metrics.bajaItems || cfg.expectedTotals.bajaItems), metrics.bajaItems ? `${fmt(metrics.bajaPedidos)} pedidos unicos` : "Pendiente Apps Script", "orange"),
      kpi("Despachados", fmt(metrics.despachados), "Accion logistica prioritaria", metrics.despachados ? "red" : "purple")
    ].join("");
  }

  function renderPaymentBreakdown(metrics) {
    const entries = Object.entries(metrics.paymentCounts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...entries.map(([, count]) => count), 1);
    $("#paymentBreakdown").innerHTML = entries.length ? entries.map(([name, count]) => {
      const manual = manualPayments.has(normalizeText(name));
      return `
        <div class="breakdown-row">
          <div>
            <strong>${escapeHtml(name || "Sin dato")}</strong><br>
            <span class="badge ${manual ? "badge-orange" : "badge-green"}">${manual ? "Manual" : "Automatico"}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(count / max * 100)}%;background:${manual ? "var(--orange)" : "var(--green)"}"></div></div>
          <div class="td-right td-mono">${fmt(count)}</div>
          <div class="td-right td-mono">${pct(count, metrics.totalError)}</div>
        </div>`;
    }).join("") : `<p class="section-note">Sin medios de pago cargados.</p>`;
  }

  function renderHourChart(metrics) {
    const entries = Object.entries(metrics.hourCounts)
      .filter(([hour]) => hour !== "")
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const max = Math.max(...entries.map(([, count]) => count), 1);

    $("#hourChart").innerHTML = entries.length ? entries.map(([hour, count]) => {
      const height = Math.max(5, Math.round(count / max * 126));
      const peak = count === max;
      return `
        <div class="hour-item" title="${hour}:00 - ${count} pedidos">
          <div class="hour-value">${count >= 10 ? fmt(count) : ""}</div>
          <div class="hour-bar" style="height:${height}px;background:${peak ? "var(--red)" : "var(--blue)"}"></div>
          <div class="hour-label">${String(hour).padStart(2, "0")}:00</div>
        </div>`;
    }).join("") : `<p class="section-note">La base actual no trae hora real suficiente para graficar.</p>`;
  }

  function renderPedidosError() {
    const filter = state.filters.errores;
    const rows = applyFilter(state.raw.pedidosError, filter);
    const page = paginate(rows, filter);

    $("#countErrores").textContent = `${fmt(rows.length)} pedidos`;
    $("#tbodyErrores").innerHTML = page.length ? page.map((row) => {
      const payment = getPayment(row);
      const manual = manualPayments.has(normalizeText(payment));
      return `
        <tr>
          <td class="td-mono">${escapeHtml(getValue(row, ["fecha_alta", "Fecha Alta", "fecha_alta.1"]).slice(0, 19))}</td>
          <td class="td-mono">${escapeHtml(getValue(row, ["nro_pedido_canal", "Nro Pedido", "Order"]))}</td>
          <td><span class="badge ${manual ? "badge-orange" : "badge-blue"}">${escapeHtml(payment || "Sin dato")}</span></td>
          <td class="td-mono">${formatHour(getRealHour(row))}</td>
          <td><span class="badge ${manual ? "badge-orange" : "badge-green"}">${manual ? "Manual" : "Automatica"}</span></td>
        </tr>`;
    }).join("") : emptyRow(5, "No hay pedidos con error para mostrar.");

    renderPager("#pagerErrores", rows.length, filter, renderPedidosError);
  }

  function renderTimeline() {
    const rows = state.raw.cronologia.length ? state.raw.cronologia : defaultTimeline();
    $("#timeline").innerHTML = rows.map((row) => `
      <article class="timeline-item">
        <div class="timeline-time">${escapeHtml(getValue(row, ["hora", "Hora"]) || "Pendiente")}</div>
        <div>
          <div class="timeline-title">${escapeHtml(getValue(row, ["titulo", "Titulo", "evento"]) || "Evento sin titulo")}</div>
          <p class="timeline-desc">${escapeHtml(getValue(row, ["descripcion", "Descripcion", "detalle"]) || "")}</p>
        </div>
      </article>
    `).join("");
  }

  function renderSku() {
    const rows = state.raw.skuResumen;
    $("#skuEmpty").classList.toggle("hidden", rows.length > 0);
    $("#skuTableWrap").classList.toggle("hidden", rows.length === 0);
    $("#tbodySku").innerHTML = rows.map((row) => `
      <tr>
        <td class="td-mono">${escapeHtml(getValue(row, ["sku", "SKU", "Reference Code"]))}</td>
        <td>${escapeHtml(getValue(row, ["producto", "Producto", "SKU Name"]))}</td>
        <td>${escapeHtml(getValue(row, ["sitios", "Sitios", "Tienda"]))}</td>
        <td class="td-right td-mono">${fmtNumberValue(getValue(row, ["pedidos", "Pedidos"]))}</td>
        <td class="td-right td-mono">${fmtNumberValue(getValue(row, ["unidades", "Unidades", "Cantidad"]))}</td>
        <td class="td-right td-mono">${fmtMoney(toNumber(getValue(row, ["monto", "Monto", "Total Value"])))}</td>
      </tr>
    `).join("");
  }

  function renderPimKpis(metrics) {
    $("#pimKpis").innerHTML = [
      kpi("Items PIM", fmt(metrics.pedidosPimItems || cfg.expectedTotals.pedidosPimItems), metrics.pedidosPimItems ? "Desde Apps Script" : "Referencia Excel", "blue"),
      kpi("Pedidos PIM", fmt(metrics.pedidosPimUnicos || cfg.expectedTotals.pedidosPimUnicos), "Pedidos unicos", "blue"),
      kpi("Bajas", fmt(metrics.bajaItems || cfg.expectedTotals.bajaItems), `${fmt(metrics.bajaPedidos || cfg.expectedTotals.bajaPedidos)} pedidos`, "orange"),
      kpi("Despachados", fmt(metrics.despachados), "Requiere seguimiento", metrics.despachados ? "red" : "purple"),
      kpi("Importe pagado", fmtMoney(metrics.totalPagado), "Base bajas", "red"),
      kpi("Diferencia", fmtMoney(Math.abs(metrics.totalDiff)), "Monto a gestionar", "red")
    ].join("");
  }

  function renderBajas() {
    const filter = state.filters.bajas;
    const rows = applyFilter(state.raw.darDeBaja, filter);
    const page = paginate(rows, filter);

    $("#countBajas").textContent = `${fmt(rows.length)} items`;
    $("#tbodyBajas").innerHTML = page.length ? page.map((row) => {
      const dispatch = hasDispatch(row);
      return `
        <tr class="${dispatch ? "flagged" : ""}">
          <td class="td-mono">${escapeHtml(getValue(row, ["nro_pedido_canal", "Nro Pedido"]))}</td>
          <td class="td-mono">${escapeHtml(getValue(row, ["sku", "SKU"]))}</td>
          <td>${escapeHtml(getValue(row, ["producto", "Producto"]))}</td>
          <td class="td-right td-mono">${fmtNumberValue(getValue(row, ["cantidad", "Cantidad"]))}</td>
          <td class="td-right td-mono">${fmtMoney(toNumber(getValue(row, ["importe_pagado", "Importe Pagado"])))}</td>
          <td class="td-right td-mono">${fmtMoney(toNumber(getValue(row, ["precio_actual", "Precio Actual"])))}</td>
          <td class="td-right td-mono">${fmtMoney(toNumber(getValue(row, ["diff$", "Diff", "diff"])))}</td>
          <td><span class="badge ${dispatch ? "badge-red" : "badge-green"}">${dispatch ? "Con envio" : "Sin envio"}</span></td>
          <td class="td-mono">${escapeHtml(getValue(row, ["nro_seguimiento", "Seguimiento"]) || "-")}</td>
        </tr>`;
    }).join("") : emptyRow(9, "Conectar hoja dar_de_baja para visualizar los items completos.");

    renderPager("#pagerBajas", rows.length, filter, renderBajas);
  }

  function handleFilterButton(btn) {
    const table = btn.dataset.filterTable;
    const filter = state.filters[table];
    if (!filter) return;

    if (btn.dataset.filterClear) {
      filter.field = null;
      filter.value = null;
      filter.page = 1;
      $$(`[data-filter-table="${table}"]`).forEach((el) => el.classList.remove("active"));
    } else {
      const same = filter.field === btn.dataset.filterField && filter.value === btn.dataset.filterValue;
      filter.field = same ? null : btn.dataset.filterField;
      filter.value = same ? null : btn.dataset.filterValue;
      filter.page = 1;
      $$(`[data-filter-table="${table}"]`).forEach((el) => el.classList.remove("active"));
      if (!same) btn.classList.add("active");
    }

    if (table === "errores") renderPedidosError();
    if (table === "bajas") renderBajas();
  }

  function applyFilter(rows, filter) {
    let result = rows;
    if (filter.field && filter.value) {
      result = result.filter((row) => normalizeText(row[filter.field]) === normalizeText(filter.value));
    }
    if (filter.search) {
      result = result.filter((row) => Object.values(row).some((value) => String(value || "").toLowerCase().includes(filter.search)));
    }
    return result;
  }

  function paginate(rows, filter) {
    const start = (filter.page - 1) * filter.perPage;
    return rows.slice(start, start + filter.perPage);
  }

  function renderPager(selector, total, filter, renderFn) {
    const pages = Math.ceil(total / filter.perPage);
    const el = $(selector);
    if (pages <= 1) {
      el.innerHTML = "";
      return;
    }

    const buttons = [];
    buttons.push(pageButton("‹", filter.page - 1, filter.page === 1));
    for (let page = 1; page <= pages; page += 1) {
      if (page === 1 || page === pages || Math.abs(page - filter.page) <= 2) {
        buttons.push(pageButton(page, page, false, page === filter.page));
      } else if (buttons[buttons.length - 1] !== "...") {
        buttons.push("...");
      }
    }
    buttons.push(pageButton("›", filter.page + 1, filter.page === pages));
    el.innerHTML = buttons.map((button) => typeof button === "string" ? `<span class="page-btn">${button}</span>` : button).join("");
    el.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        filter.page = Number(btn.dataset.page);
        renderFn();
      });
    });
  }

  function pageButton(label, page, disabled, active) {
    return `<button class="page-btn ${active ? "active" : ""}" type="button" ${disabled ? "disabled" : ""} data-page="${page}">${label}</button>`;
  }

  function showTab(tab) {
    $$(".nav-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "tab-" + tab));
  }

  function kpi(label, value, sub, color) {
    return `
      <article class="kpi-card ${color || "blue"}">
        <div class="kpi-label">${escapeHtml(label)}</div>
        <div class="kpi-value">${escapeHtml(String(value))}</div>
        <div class="kpi-sub">${escapeHtml(sub || "")}</div>
      </article>`;
  }

  function parseCsv(text) {
    const rows = [];
    const cells = [];
    let cell = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (char === '"' && inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cells.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") index += 1;
        cells.push(cell);
        if (cells.some((value) => value.trim() !== "")) rows.push(cells.splice(0));
        cell = "";
      } else {
        cell += char;
      }
    }
    cells.push(cell);
    if (cells.some((value) => value.trim() !== "")) rows.push(cells);

    const headers = (rows.shift() || []).map((header) => header.trim());
    return rows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = (row[index] || "").trim();
      });
      return obj;
    });
  }

  function normalizeRows(rows) {
    return (rows || []).filter((row) => row && Object.values(row).some((value) => String(value || "").trim() !== ""));
  }

  function groupCount(rows, getter) {
    return rows.reduce((acc, row) => {
      const key = String(getter(row) || "").trim();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }

  function uniqueCount(rows, fields) {
    const values = new Set();
    rows.forEach((row) => {
      const value = getValue(row, fields);
      if (value) values.add(value);
    });
    return values.size;
  }

  function sumBy(rows, fields) {
    return rows.reduce((total, row) => total + toNumber(getValue(row, fields)), 0);
  }

  function getPayment(row) {
    return getValue(row, ["tipo_pago", "Payment System Name", "Medio de Pago"]);
  }

  function getRealHour(row) {
    const explicit = getValue(row, ["Hora real", "hora_real", "Hora Real"]);
    if (explicit !== "") return String(explicit);
    const dateValue = getValue(row, ["fecha_alta", "Fecha Alta", "Creation Date"]);
    if (!dateValue) return "";
    const match = String(dateValue).match(/\s(\d{1,2}):/);
    if (!match) return "";
    return String((Number(match[1]) + 21) % 24);
  }

  function hasDispatch(row) {
    return Boolean(getValue(row, ["nro_seguimiento", "Seguimiento"])) || ["a", "d", "despachado"].includes(normalizeText(getValue(row, ["Estado envio", "estado_envio"])));
  }

  function getValue(row, fields) {
    for (const field of fields) {
      if (row[field] !== undefined && row[field] !== null && String(row[field]).trim() !== "") return String(row[field]).trim();
    }
    return "";
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function toNumber(value) {
    if (value === undefined || value === null || value === "") return 0;
    const normalized = String(value).replace(/\./g, "").replace(",", ".");
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }

  function fmt(value) {
    return Number(value || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function fmtNumberValue(value) {
    return fmt(toNumber(value));
  }

  function fmtMoney(value) {
    return "$" + Number(value || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function pct(value, total) {
    return total ? (value / total * 100).toFixed(1) + "%" : "0.0%";
  }

  function formatHour(hour) {
    if (hour === "") return "-";
    return String(hour).padStart(2, "0") + ":00";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function emptyRow(colspan, message) {
    return `<tr><td colspan="${colspan}" style="text-align:center;padding:34px;color:var(--muted);">${escapeHtml(message)}</td></tr>`;
  }

  function defaultTimeline() {
    return [
      { hora: "13:30", titulo: "Deteccion de precios incorrectos", descripcion: "Se detectaron publicaciones con precios por debajo de lo esperado y variantes con stock historico." },
      { hora: "15:40", titulo: "Pulso de stock y precio", descripcion: "Se envio actualizacion para depositos involucrados. Tiempo estimado de impacto: 6 horas." },
      { hora: "16:00", titulo: "Pico critico", descripcion: "La mayor concentracion de pedidos con error se observa alrededor de la hora 16." },
      { hora: "17:50", titulo: "Apagado de deposito afectado", descripcion: "Se apago el deposito 45 en ambas tiendas para contener la incidencia." }
    ];
  }

  function setLoading(active) {
    $("#loadingOverlay").style.display = active ? "flex" : "none";
  }

  function showError(message) {
    $("#errorBanner").textContent = message;
    $("#errorBanner").className = "notice error";
  }

  function clearError() {
    $("#errorBanner").textContent = "";
    $("#errorBanner").className = "notice hidden";
  }
})();
