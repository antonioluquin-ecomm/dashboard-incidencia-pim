(function () {
  const cfg = window.PIM_INCIDENT_CONFIG;
  const manualPayments = new Set((cfg.manualPaymentMethods || []).map(normalizeText));

  const state = {
    summary: {},
    health: null,
    paymentBreakdown: [],
    storeBreakdown: [],
    hourlyError: [],
    financialImpact: {},
    skuImpact: [],
    bajasPrioritarias: [],
    cronologia: [],
    pedidosError: [],
    pedidosErrorUnlocked: false,
    filters: {
      errores: { search: "", field: null, value: null, page: 1, perPage: 50 },
      bajas: { search: "", dispatchOnly: false, page: 1, perPage: 25 }
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", () => {
    bindUi();
    loadData();
  });

  function bindUi() {
    $("#refreshButton").addEventListener("click", () => loadData({ refresh: true }));
    $$(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.dataset.tab));
    });
    $("#unlockErrorsButton").addEventListener("click", unlockPedidosError);
    $("#errorPassword").addEventListener("keydown", (event) => {
      if (event.key === "Enter") unlockPedidosError();
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

  async function loadData(options = {}) {
    setLoading(true);
    clearError();

    try {
      const payload = cfg.dataMode === "appsScript" && cfg.appScriptUrl
        ? await fetchAppsScript(options)
        : await fetchPublishedCsv();

      applyPayload(payload);
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
    const pedidosError = parseCsv(await response.text());
    return normalizeLegacyPayload({
      sourceLabel: "CSV publicado",
      pedidosError,
      pedidosPim: [],
      pedidosVtex: [],
      darDeBaja: [],
      cronologia: [],
      skuResumen: []
    });
  }

  async function fetchAppsScript(options) {
    const url = cfg.appScriptUrl + cacheBust(cfg.appScriptUrl) + (options.refresh ? "&refresh=1" : "");
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);

    if (!payload.summary) {
      throw new Error("La API de Apps Script todavia usa el contrato anterior. Pegar y desplegar el Code.gs actualizado.");
    }

    return {
      sourceLabel: "Apps Script",
      updatedAt: payload.updatedAt,
      health: payload.health,
      summary: payload.summary,
      paymentBreakdown: payload.paymentBreakdown || [],
      storeBreakdown: payload.storeBreakdown || [],
      hourlyError: payload.hourlyError || [],
      financialImpact: payload.financialImpact || {},
      skuImpact: payload.skuImpact || [],
      bajasPrioritarias: payload.bajasPrioritarias || [],
      cronologia: payload.cronologia || []
    };
  }

  async function unlockPedidosError() {
    const passwordInput = $("#errorPassword");
    const status = $("#errorUnlockStatus");
    const password = passwordInput.value;

    if (!cfg.appScriptUrl) {
      status.textContent = "Falta configurar Apps Script";
      status.className = "unlock-status error";
      return;
    }
    if (!password) {
      status.textContent = "Ingresar clave";
      status.className = "unlock-status error";
      passwordInput.focus();
      return;
    }

    $("#unlockErrorsButton").disabled = true;
    status.textContent = "Validando...";
    status.className = "unlock-status";

    try {
      const url = cfg.appScriptUrl + cacheBust(cfg.appScriptUrl)
        + "&view=pedidos_error&password=" + encodeURIComponent(password);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);

      state.pedidosError = normalizeRows(payload.pedidosErrorDetalle || []);
      state.pedidosErrorUnlocked = true;
      state.filters.errores.page = 1;
      passwordInput.value = "";
      status.textContent = `${fmt(state.pedidosError.length)} pedidos visibles`;
      status.className = "unlock-status ok";
      renderPedidosError();
    } catch (error) {
      state.pedidosErrorUnlocked = false;
      state.pedidosError = [];
      status.textContent = error.message;
      status.className = "unlock-status error";
      renderPedidosError();
    } finally {
      $("#unlockErrorsButton").disabled = false;
    }
  }

  function applyPayload(payload) {
    state.summary = payload.summary || {};
    state.health = payload.health || null;
    state.paymentBreakdown = payload.paymentBreakdown || [];
    state.storeBreakdown = payload.storeBreakdown || [];
    state.hourlyError = payload.hourlyError || [];
    state.financialImpact = payload.financialImpact || {};
    state.skuImpact = payload.skuImpact || [];
    state.bajasPrioritarias = payload.bajasPrioritarias || [];
    state.cronologia = payload.cronologia || [];
    state.pedidosError = payload.pedidosError || [];
    state.pedidosErrorUnlocked = Boolean(state.pedidosError.length);
  }

  function normalizeLegacyPayload(payload) {
    const pedidosError = normalizeRows(payload.pedidosError || []);
    const pedidosPim = normalizeRows(payload.pedidosPim || []);
    const pedidosVtex = normalizeRows(payload.pedidosVtex || []);
    const darDeBaja = normalizeRows(payload.darDeBaja || []);
    const summary = buildLegacySummary(pedidosError, pedidosPim, pedidosVtex, darDeBaja);

    return {
      sourceLabel: payload.sourceLabel,
      summary,
      health: buildLegacyHealth(pedidosError, pedidosPim, pedidosVtex, darDeBaja),
      paymentBreakdown: buildPaymentBreakdown(pedidosError),
      storeBreakdown: buildStoreBreakdown(pedidosVtex),
      hourlyError: buildHourlyError(pedidosError),
      financialImpact: buildFinancialImpact(pedidosError, pedidosPim, pedidosVtex, darDeBaja, summary),
      skuImpact: normalizeRows(payload.skuResumen || []).length ? normalizeSkuRows(payload.skuResumen) : buildSkuFromVtex(pedidosVtex),
      bajasPrioritarias: buildBajasPrioritarias(darDeBaja),
      cronologia: normalizeCronologia(payload.cronologia || []),
      pedidosError
    };
  }

  function cacheBust(url) {
    return String(url || "").includes("?") ? "&t=" + Date.now() : "?t=" + Date.now();
  }

  function renderAll() {
    renderRiskStrip();
    renderExecutiveStory();
    renderHealth();
    renderSummaryKpis();
    renderFinancialKpis();
    renderFinancialExplanation();
    renderPaymentBreakdown();
    renderStoreBreakdown();
    renderHourChart();
    renderPedidosError();
    renderTimeline();
    renderSku();
    renderPimKpis();
    renderBajas();
  }

  function renderRiskStrip() {
    const health = state.health;
    const parts = health && health.sheets
      ? Object.entries(health.sheets).filter(([, info]) => info.found && info.rows).map(([key]) => sheetLabel(key))
      : [];
    const warning = health && health.status === "warning";

    $("#riskStrip").innerHTML = warning
      ? `<strong>Base con alertas:</strong> revisar columnas faltantes en Estado de datos. El tablero sigue mostrando lo disponible.`
      : `<strong>Base conectada:</strong> ${parts.join(", ") || "sin datos visibles todavia"}. Actualizar el Google Sheet refresca este tablero.`;
  }

  function renderExecutiveStory() {
    const s = state.summary || {};
    const f = state.financialImpact || {};
    $("#executiveStory").innerHTML = [
      {
        title: "Que paso",
        text: `El universo revisado combina <strong>${fmt(s.pedidosError)}</strong> pedidos que cayeron en error PIM y <strong>${fmt(s.pedidosPimUnicos)}</strong> pedidos que si ingresaron a PIM. En total son <strong>${fmt(s.pedidosTotalesIncidente)}</strong> pedidos bajo analisis.`
      },
      {
        title: "Donde impacta",
        text: `Dentro de PIM hay <strong>${fmt(s.pimConDiferenciaPedidos)}</strong> pedidos con diferencia de precio. De ellos, <strong>${fmt(s.bajaPorDiferenciaPedidos)}</strong> ya quedaron en baja y <strong>${fmt(s.expuestosConDiferenciaPedidos)}</strong> siguen expuestos o facturados.`
      },
      {
        title: "Que hacer primero",
        text: `Priorizar los <strong>${fmt(s.facturadosConDiferenciaPedidos)}</strong> pedidos facturados con diferencia y los <strong>${fmt(s.gestionManual)}</strong> pedidos de error que requieren gestion manual.`
      }
    ].map((item) => `
      <article class="story-card">
        <h3>${item.title}</h3>
        <p>${item.text}</p>
      </article>
    `).join("");
  }

  function renderHealth() {
    const health = state.health;
    const container = $("#dataHealth");
    if (!health || !health.sheets) {
      container.innerHTML = `<div class="empty-state"><h3>Estado de datos no disponible</h3><p>La API no envio informacion de salud de la base.</p></div>`;
      return;
    }

    const sheets = Object.entries(health.sheets).map(([key, info]) => {
      const missing = info.missingColumns || [];
      return `
        <div class="health-row">
          <div>
            <strong>${sheetLabel(key)}</strong>
            <span>${escapeHtml(info.name || key)}</span>
          </div>
          <div class="td-right td-mono">${fmt(info.rows || 0)}</div>
          <div><span class="badge ${info.found && !missing.length ? "badge-green" : "badge-orange"}">${info.found ? "Conectada" : "Faltante"}</span></div>
          <div class="health-missing">${missing.length ? escapeHtml(missing.join(", ")) : "OK"}</div>
        </div>`;
    }).join("");

    container.innerHTML = `
      <article class="panel health-panel">
        <div class="panel-header">
          <h3>Estado de datos</h3>
          <span>Cache ${escapeHtml(health.cacheStatus || "-")} · TTL ${fmt(health.ttlSeconds || 0)}s</span>
        </div>
        <div class="health-grid health-head">
          <span>Hoja</span><span>Filas</span><span>Estado</span><span>Columnas faltantes</span>
        </div>
        ${sheets}
      </article>`;
  }

  function renderSummaryKpis() {
    const s = state.summary;
    $("#summaryKpis").innerHTML = [
      kpi("Total pedidos", fmt(s.pedidosTotalesIncidente), "Error PIM + pedidos ingresados a PIM", "purple"),
      kpi("Pedidos con error", fmt(valueOr(s.pedidosError, cfg.expectedTotals.pedidosError)), "No ingresaron a PIM", "red"),
      kpi("Pedidos ingresados PIM", fmt(valueOr(s.pedidosPimUnicos, cfg.expectedTotals.pedidosPimUnicos)), `${fmt(valueOr(s.pedidosPimItems, cfg.expectedTotals.pedidosPimItems))} items`, "blue"),
      kpi("Ingresaron sin dif.", fmt(s.pedidosPimSinError), "Pedidos PIM sin diferencia de precio", "green"),
      kpi("Bajas PIM", fmt(valueOr(s.bajaPedidos, cfg.expectedTotals.bajaPedidos)), `${fmt(valueOr(s.bajaItems, cfg.expectedTotals.bajaItems))} items en estado Baja`, "orange"),
      kpi("Bajas por dif.", fmt(s.bajaPorDiferenciaPedidos), `${fmt(s.bajaPorDiferenciaItems)} items con precio incorrecto`, "orange"),
      kpi("Facturados con dif.", fmt(s.facturadosConDiferenciaPedidos), "Pedidos que avanzaron con precio incorrecto", "red"),
      kpi("Expuestos con dif.", fmt(s.expuestosConDiferenciaPedidos), "Activos, asignados, cola o facturados", "red"),
      kpi("Unidades rechazadas", fmt(s.unidadesRechazadas), "Unidades dentro de esos pedidos", "orange"),
      kpi("SKUs afectados", fmt(s.skusErrorUnicos), "Productos distintos involucrados", "orange"),
      kpi("Gestion manual", fmt(s.gestionManual), "Requieren accion humana", "orange"),
      kpi("Gestion automatica", fmt(s.gestionAutomatica), "Se reprocesan o cancelan por sistema", "green")
    ].join("");
  }

  function renderFinancialKpis() {
    const f = state.financialImpact || {};
    $("#financialKpis").innerHTML = [
      kpi("Monto rechazado", fmtMoney(f.montoRechazado), "Solo pedidos con error", "red"),
      kpi("Valor total PIM", fmtMoney(f.valorTotalPim), "Items ingresados a PIM", "blue"),
      kpi("Valor facturado", fmtMoney(f.valorFacturado), "Pedidos facturados", "green"),
      kpi("Importe con dif.", fmtMoney(f.importeCobradoError), "Items PIM con diferencia", "orange"),
      kpi("Diferencia detectada", fmtMoney(Math.abs(toNumber(f.diferenciaPrecioCorrecto))), "Precio PIM - precio WEB", "red"),
      kpi("Perdida expuesta", fmtMoney(f.perdidaReal), "Diferencia no contenida en Baja", "red"),
      kpi("Ticket normal ref.", fmtMoney(f.ticketPromedioActual), "Ticket promedio habitual usado como referencia", "blue"),
      kpi("Ticket del incidente", fmtMoney(f.ticketPromedioError), "Monto rechazado / pedidos con error", "purple"),
      kpi("Brecha de error", fmtMoney(f.brechaTicket), "Actual - error", "red"),
      kpi("Potencial perdida", fmtMoney(f.potencialPerdida), "Brecha x pedidos error", "red"),
      kpi("Precio prom. correcto", fmtMoney(f.precioPromedioCorrectoBaja), "Items de baja", "orange"),
      kpi("Precio prom. pagado", fmtMoney(f.precioPromedioPagadoBaja), "Items de baja", "red")
    ].join("");
  }

  function renderFinancialExplanation() {
    const f = state.financialImpact || {};
    $("#financialExplanation").innerHTML = `
      <strong>Lectura financiera:</strong>
      los pedidos que cayeron en error representan ${fmtMoney(f.montoRechazado)} de venta rechazada.
      El ticket del incidente fue de ${fmtMoney(f.ticketPromedioError)}, contra un ticket normal de referencia de ${fmtMoney(f.ticketPromedioActual)}.
      Esa brecha explica un potencial de perdida estimado de ${fmtMoney(f.potencialPerdida)}.
      En los pedidos que si ingresaron a PIM, la diferencia detectada suma ${fmtMoney(Math.abs(toNumber(f.diferenciaPrecioCorrecto)))} y la perdida expuesta fuera de estado Baja es ${fmtMoney(f.perdidaReal)}.`;
  }

  function renderPaymentBreakdown() {
    const entries = state.paymentBreakdown || [];
    const total = state.summary.pedidosError || entries.reduce((sum, row) => sum + toNumber(row.pedidos), 0);
    const max = Math.max(...entries.map((row) => toNumber(row.pedidos)), 1);

    $("#paymentBreakdown").innerHTML = entries.length ? entries.map((row) => {
      const count = toNumber(row.pedidos);
      const manual = normalizeText(row.gestion) === "manual" || manualPayments.has(normalizeText(row.tipo));
      return `
        <div class="breakdown-row">
          <div>
            <strong>${escapeHtml(row.tipo || "Sin dato")}</strong><br>
            <span class="badge ${manual ? "badge-orange" : "badge-green"}">${manual ? "Manual" : "Automatica"}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(count / max * 100)}%;background:${manual ? "var(--orange)" : "var(--green)"}"></div></div>
          <div class="td-right td-mono">${fmt(count)}</div>
          <div class="td-right td-mono">${pct(count, total)}</div>
        </div>`;
    }).join("") : `<p class="section-note">Sin medios de pago cargados.</p>`;
  }

  function renderStoreBreakdown() {
    const rows = state.storeBreakdown || [];
    const max = Math.max(...rows.map((row) => toNumber(row.monto)), 1);
    $("#storeBreakdown").innerHTML = rows.length ? rows.map((row) => `
      <div class="store-row">
        <div>
          <strong>${escapeHtml(row.tienda || "Sin dato")}</strong>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(toNumber(row.monto) / max * 100)}%"></div></div>
        </div>
        <div class="td-right td-mono">${fmt(row.pedidos)}</div>
        <div class="td-right td-mono">${fmt(row.unidades)}</div>
        <div class="td-right td-mono">${fmtMoney(row.monto)}</div>
      </div>
    `).join("") : `<p class="section-note">Sin datos de tienda disponibles.</p>`;
  }

  function renderHourChart() {
    const entries = (state.hourlyError || []).filter((row) => row.hora !== "");
    const max = Math.max(...entries.map((row) => toNumber(row.pedidos)), 1);

    $("#hourChart").innerHTML = entries.length ? entries.map((row) => {
      const count = toNumber(row.pedidos);
      const height = Math.max(5, Math.round(count / max * 126));
      const peak = count === max;
      return `
        <div class="hour-item" title="${escapeHtml(formatHour(row.hora))} - ${fmt(count)} pedidos">
          <div class="hour-value">${count >= 10 ? fmt(count) : ""}</div>
          <div class="hour-bar" style="height:${height}px;background:${peak ? "var(--red)" : "var(--blue)"}"></div>
          <div class="hour-label">${formatHour(row.hora)}</div>
        </div>`;
    }).join("") : `<p class="section-note">La base actual no trae hora real suficiente para graficar.</p>`;
  }

  function renderPedidosError() {
    const filter = state.filters.errores;
    const rows = applyFilter(state.pedidosError || [], filter);
    const page = paginate(rows, filter);
    const unlocked = state.pedidosErrorUnlocked;

    $("#errorsToolbar").classList.toggle("locked", !unlocked);
    $("#countErrores").textContent = unlocked
      ? `${fmt(rows.length)} pedidos`
      : `${fmt(state.summary.pedidosError || 0)} pedidos protegidos`;
    $("#tbodyErrores").innerHTML = page.length ? page.map((row) => {
      const payment = getPayment(row);
      const gestion = getValue(row, ["tipo_gestion", "Gestion", "Gestion sugerida"]);
      const manual = normalizeText(gestion) === "manual" || manualPayments.has(normalizeText(payment));
      return `
        <tr>
          <td class="td-mono">${escapeHtml(getValue(row, ["fecha_alta", "Fecha Alta", "fecha_alta.1"]).slice(0, 19))}</td>
          <td class="td-mono">${escapeHtml(getValue(row, ["nro_pedido_canal", "Nro Pedido", "Order"]))}</td>
          <td><span class="badge ${manual ? "badge-orange" : "badge-blue"}">${escapeHtml(payment || "Sin dato")}</span></td>
          <td class="td-mono">${formatHour(getRealHour(row))}</td>
          <td><span class="badge ${manual ? "badge-orange" : "badge-green"}">${manual ? "Manual" : "Automatica"}</span></td>
          <td>${escapeHtml(getValue(row, ["sitio", "Tienda", "Seller Name"]) || "Sin dato")}</td>
          <td class="td-right td-mono">${fmt(toNumber(getValue(row, ["unidades", "Cantidad", "Quantity_SKU"])))}</td>
          <td class="td-right td-mono">${fmtMoney(toNumber(getValue(row, ["monto", "Monto", "SKU Total Price"])))}</td>
        </tr>`;
    }).join("") : emptyRow(8, unlocked
      ? "No hay pedidos para el filtro aplicado."
      : "Detalle bloqueado. Ingresar la clave para ver la tabla saneada de pedidos con error.");

    renderPager("#pagerErrores", unlocked ? rows.length : 0, filter, renderPedidosError);
  }

  function renderTimeline() {
    const rows = state.cronologia.length ? state.cronologia : defaultTimeline();
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
    const rows = state.skuImpact || [];
    $("#skuEmpty").classList.toggle("hidden", rows.length > 0);
    $("#skuTableWrap").classList.toggle("hidden", rows.length === 0);
    $("#tbodySku").innerHTML = rows.map((row) => `
      <tr>
        <td class="td-mono">${escapeHtml(row.sku)}</td>
        <td>${escapeHtml(row.producto)}</td>
        <td>${escapeHtml(row.sitios)}</td>
        <td class="td-right td-mono">${fmt(row.pedidos)}</td>
        <td class="td-right td-mono">${fmt(row.unidades)}</td>
        <td class="td-right td-mono">${fmtMoney(row.monto)}</td>
      </tr>
    `).join("");
  }

  function renderPimKpis() {
    const s = state.summary;
    $("#pimKpis").innerHTML = [
      kpi("Items PIM", fmt(valueOr(s.pedidosPimItems, cfg.expectedTotals.pedidosPimItems)), s.pedidosPimItems ? "Desde Apps Script" : "Referencia esperada", "blue"),
      kpi("Pedidos PIM", fmt(valueOr(s.pedidosPimUnicos, cfg.expectedTotals.pedidosPimUnicos)), "Pedidos unicos", "blue"),
      kpi("Pedidos sin dif.", fmt(s.pedidosPimSinError), "Ingresaron sin diferencia de precio", "green"),
      kpi("Pedidos con dif.", fmt(s.pimConDiferenciaPedidos), `${fmt(s.pimConDiferenciaItems)} items`, "red"),
      kpi("Bajas PIM", fmt(valueOr(s.bajaPedidos, cfg.expectedTotals.bajaPedidos)), `${fmt(valueOr(s.bajaItems, cfg.expectedTotals.bajaItems))} items`, "orange"),
      kpi("Baja por dif.", fmt(s.bajaPorDiferenciaPedidos), `${fmt(s.bajaPorDiferenciaItems)} items`, "orange"),
      kpi("Baja normal", fmt(s.bajaNormalPedidos), `${fmt(s.bajaNormalItems)} items`, "blue"),
      kpi("Facturados con dif.", fmt(s.facturadosConDiferenciaPedidos), "Perdida confirmada/expuesta", "red"),
      kpi("Perdida expuesta", fmtMoney(s.perdidaReal), "Diferencia fuera de Baja", "red")
    ].join("");
  }

  function renderBajas() {
    const filter = state.filters.bajas;
    const rows = applyBajaFilter(state.bajasPrioritarias || [], filter);
    const page = paginate(rows, filter);

    $("#countBajas").textContent = `${fmt(rows.length)} items`;
    $("#tbodyBajas").innerHTML = page.length ? page.map((row) => {
      const dispatch = isDispatch(row);
      return `
        <tr class="${dispatch ? "flagged" : ""}">
          <td class="td-mono">${escapeHtml(row.nro_pedido_canal)}</td>
          <td class="td-mono">${escapeHtml(row.sku)}</td>
          <td>${escapeHtml(row.producto)}</td>
          <td class="td-right td-mono">${fmt(row.cantidad)}</td>
          <td class="td-right td-mono">${fmtMoney(row.importe_pagado)}</td>
          <td class="td-right td-mono">${fmtMoney(row.precio_actual)}</td>
          <td class="td-right td-mono">${fmtMoney(row.diff)}</td>
          <td><span class="badge ${dispatch ? "badge-red" : normalizeText(row.estado_pim) === "baja" ? "badge-green" : "badge-orange"}">${escapeHtml(row.estado_pim || row.estado_envio || "-")}</span></td>
          <td>${escapeHtml(row.tipo_baja || "-")}</td>
          <td><span class="badge ${priorityClass(row.prioridad)}">${escapeHtml(row.prioridad || "Media")}</span></td>
        </tr>`;
    }).join("") : emptyRow(10, "No hay bajas para mostrar con los filtros actuales.");

    renderPager("#pagerBajas", rows.length, filter, renderBajas);
  }

  function handleFilterButton(btn) {
    const table = btn.dataset.filterTable;
    const filter = state.filters[table];
    if (!filter) return;

    if (btn.dataset.filterClear) {
      filter.field = null;
      filter.value = null;
      filter.dispatchOnly = false;
      filter.page = 1;
      $$(`[data-filter-table="${table}"]`).forEach((el) => el.classList.remove("active"));
    } else if (btn.dataset.filterDispatch) {
      filter.dispatchOnly = !filter.dispatchOnly;
      filter.page = 1;
      btn.classList.toggle("active", filter.dispatchOnly);
    } else {
      const same = filter.field === btn.dataset.filterField && filter.value === btn.dataset.filterValue;
      filter.field = same ? null : btn.dataset.filterField;
      filter.value = same ? null : btn.dataset.filterValue;
      filter.page = 1;
      $$(`[data-filter-table="${table}"]`).forEach((el) => {
        if (!el.dataset.filterDispatch) el.classList.remove("active");
      });
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

  function applyBajaFilter(rows, filter) {
    let result = rows;
    if (filter.dispatchOnly) result = result.filter(isDispatch);
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
    buttons.push(pageButton("<", filter.page - 1, filter.page === 1));
    for (let page = 1; page <= pages; page += 1) {
      if (page === 1 || page === pages || Math.abs(page - filter.page) <= 2) {
        buttons.push(pageButton(page, page, false, page === filter.page));
      } else if (buttons[buttons.length - 1] !== "...") {
        buttons.push("...");
      }
    }
    buttons.push(pageButton(">", filter.page + 1, filter.page === pages));
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

  function buildLegacySummary(pedidosError, pedidosPim, pedidosVtex, darDeBaja) {
    const manual = pedidosError.filter((row) => manualPayments.has(normalizeText(getPayment(row)))).length;
    const pedidosPimUnicos = uniqueCount(pedidosPim, ["Nro Pedido", "nro_pedido_canal", "Nro pedido"]);
    const bajasPedidos = uniqueCount(darDeBaja, ["nro_pedido_canal", "Nro Pedido", "pedido"]);
    return {
      pedidosTotalesIncidente: pedidosError.length + pedidosPimUnicos,
      pedidosError: pedidosError.length,
      gestionManual: manual,
      gestionAutomatica: Math.max(0, pedidosError.length - manual),
      pedidosPimItems: pedidosPim.length,
      pedidosPimUnicos,
      pedidosPimSinError: pedidosPimUnicos,
      pedidosVtexItems: pedidosVtex.length,
      pedidosVtexUnicos: uniqueCount(pedidosVtex, ["Order", "Nro Pedido", "nro_pedido_canal"]),
      unidadesRechazadas: sumBy(pedidosVtex, ["Quantity_SKU", "Cantidad", "cantidad"]),
      skusErrorUnicos: uniqueCount(pedidosVtex, ["Reference Code", "SKU", "Sku", "sku", "ID_SKU"]),
      montoRechazado: sumBy(pedidosVtex, ["SKU Total Price", "Total Value", "Payment Value", "monto"]),
      bajaItems: darDeBaja.length,
      bajaPedidos: bajasPedidos,
      bajaPorDiferenciaItems: darDeBaja.length,
      bajaPorDiferenciaPedidos: bajasPedidos,
      bajaNormalItems: 0,
      bajaNormalPedidos: 0,
      pimConDiferenciaItems: darDeBaja.length,
      pimConDiferenciaPedidos: bajasPedidos,
      facturadosConDiferenciaItems: darDeBaja.filter(isDispatch).length,
      facturadosConDiferenciaPedidos: 0,
      expuestosConDiferenciaItems: darDeBaja.filter(isDispatch).length,
      expuestosConDiferenciaPedidos: 0,
      despachados: darDeBaja.filter(isDispatch).length,
      importePagado: sumBy(darDeBaja, ["importe_pagado", "Importe Pagado", "pagado"]),
      diferenciaTotal: sumBy(darDeBaja, ["diff$", "Diff", "diff"]),
      perdidaReal: Math.abs(sumBy(darDeBaja.filter(isDispatch), ["diff$", "Diff", "diff"]))
    };
  }

  function buildFinancialImpact(pedidosError, pedidosPim, pedidosVtex, darDeBaja, summary) {
    const montoRechazado = sumBy(pedidosVtex, ["SKU Total Price", "Total Value", "Payment Value", "monto"]);
    const valorTotalPim = sumBy(pedidosPim, ["PrecioWEB", "Precio Web", "Valor", "PrecioPIM"]);
    const valorFacturado = pedidosPim
      .filter((row) => normalizeText(getValue(row, ["Estado Actual", "estado"])) === "facturado")
      .reduce((total, row) => total + toNumber(getValue(row, ["PrecioWEB", "Precio Web", "Valor", "PrecioPIM"])), 0);
    const ticketActual = cfg.referenceMetrics && cfg.referenceMetrics.ticketPromedioActual;
    const ticketError = summary.pedidosError ? montoRechazado / summary.pedidosError : 0;
    const brecha = ticketActual - ticketError;

    return {
      montoRechazado,
      valorTotalPim,
      valorFacturado,
      importeCobradoError: summary.importePagado,
      diferenciaPrecioCorrecto: summary.diferenciaTotal,
      ticketPromedioActual: ticketActual,
      ticketPromedioError: ticketError,
      brechaTicket: brecha,
      potencialPerdida: Math.abs(brecha) * summary.pedidosError,
      perdidaReal: summary.perdidaReal || 0,
      precioPromedioCorrectoBaja: summary.pimConDiferenciaItems ? (summary.importePagado + Math.abs(summary.diferenciaTotal)) / summary.pimConDiferenciaItems : 0,
      precioPromedioPagadoBaja: summary.pimConDiferenciaItems ? summary.importePagado / summary.pimConDiferenciaItems : 0
    };
  }

  function buildLegacyHealth(pedidosError, pedidosPim, pedidosVtex, darDeBaja) {
    return {
      status: "ok",
      cacheStatus: "legacy",
      ttlSeconds: 0,
      sheets: {
        pedidos_error: { name: "pedidos_error", found: pedidosError.length > 0, rows: pedidosError.length, missingColumns: [] },
        pedidos_pim: { name: "pedidos_pim", found: pedidosPim.length > 0, rows: pedidosPim.length, missingColumns: [] },
        pedidos_vtex: { name: "pedidos_vtex", found: pedidosVtex.length > 0, rows: pedidosVtex.length, missingColumns: [] }
      }
    };
  }

  function buildPaymentBreakdown(rows) {
    const groups = {};
    rows.forEach((row) => {
      const tipo = getPayment(row) || "Sin dato";
      if (!groups[tipo]) groups[tipo] = { tipo, pedidos: 0, gestion: manualPayments.has(normalizeText(tipo)) ? "Manual" : "Automatica" };
      groups[tipo].pedidos += 1;
    });
    return Object.values(groups).sort((a, b) => b.pedidos - a.pedidos);
  }

  function buildStoreBreakdown(rows) {
    const grouped = {};
    rows.forEach((row) => {
      const tienda = normalizeStore(getValue(row, ["Seller Name", "Tienda", "Host"]));
      const order = getValue(row, ["Order", "Nro Pedido", "nro_pedido_canal"]);
      if (!grouped[tienda]) grouped[tienda] = { tienda, pedidos: new Set(), unidades: 0, monto: 0 };
      if (order) grouped[tienda].pedidos.add(order);
      grouped[tienda].unidades += toNumber(getValue(row, ["Quantity_SKU", "Cantidad", "cantidad"])) || 1;
      grouped[tienda].monto += toNumber(getValue(row, ["SKU Total Price", "Total Value", "Payment Value", "monto"]));
    });
    return Object.values(grouped).map((item) => ({
      tienda: item.tienda,
      pedidos: item.pedidos.size,
      unidades: item.unidades,
      monto: item.monto
    })).sort((a, b) => b.monto - a.monto);
  }

  function buildHourlyError(rows) {
    const groups = {};
    rows.forEach((row) => {
      const hora = getRealHour(row);
      if (hora === "") return;
      if (!groups[hora]) groups[hora] = { hora, pedidos: 0 };
      groups[hora].pedidos += 1;
    });
    return Object.values(groups).sort((a, b) => Number(a.hora) - Number(b.hora));
  }

  function buildSkuFromVtex(rows) {
    const grouped = new Map();
    rows.forEach((row) => {
      const sku = getValue(row, ["Reference Code", "SKU", "Sku", "sku", "ID_SKU"]);
      if (!sku) return;
      const order = getValue(row, ["Order", "Nro Pedido", "nro_pedido_canal"]);
      const current = grouped.get(sku) || { sku, producto: getValue(row, ["SKU Name", "Producto", "producto"]), sitios: new Set(), pedidos: new Set(), unidades: 0, monto: 0 };
      const seller = getValue(row, ["Seller Name", "Tienda", "Host"]);
      if (seller) current.sitios.add(seller);
      if (order) current.pedidos.add(order);
      current.unidades += toNumber(getValue(row, ["Quantity_SKU", "Cantidad", "cantidad"])) || 1;
      current.monto += toNumber(getValue(row, ["SKU Total Price", "Total Value", "Payment Value", "monto"]));
      grouped.set(sku, current);
    });
    return Array.from(grouped.values()).map((item) => ({
      sku: item.sku,
      producto: item.producto,
      sitios: Array.from(item.sitios).join(", "),
      pedidos: item.pedidos.size,
      unidades: item.unidades,
      monto: item.monto
    })).sort((a, b) => b.pedidos - a.pedidos).slice(0, 200);
  }

  function normalizeSkuRows(rows) {
    return normalizeRows(rows).map((row) => ({
      sku: getValue(row, ["sku", "SKU", "Reference Code"]),
      producto: getValue(row, ["producto", "Producto", "SKU Name"]),
      sitios: getValue(row, ["sitios", "Sitios", "Tienda"]),
      pedidos: toNumber(getValue(row, ["pedidos", "Pedidos"])),
      unidades: toNumber(getValue(row, ["unidades", "Unidades", "Cantidad"])),
      monto: toNumber(getValue(row, ["monto", "Monto", "Total Value"]))
    })).filter((row) => row.sku);
  }

  function buildBajasPrioritarias(rows) {
    return normalizeRows(rows).map((row) => {
      const diff = toNumber(getValue(row, ["diff$", "Diff", "diff"]));
      const dispatch = isDispatch(row);
      return {
        nro_pedido_canal: getValue(row, ["nro_pedido_canal", "Nro Pedido"]),
        sku: getValue(row, ["sku", "SKU"]),
        producto: getValue(row, ["producto", "Producto"]),
        cantidad: toNumber(getValue(row, ["cantidad", "Cantidad"])),
        importe_pagado: toNumber(getValue(row, ["importe_pagado", "Importe Pagado"])),
        precio_actual: toNumber(getValue(row, ["precio_actual", "Precio Actual"])),
        diff,
        estado_envio: getValue(row, ["Estado envio", "estado_envio"]),
        nro_seguimiento: getValue(row, ["nro_seguimiento", "Seguimiento"]),
        prioridad: dispatch ? "Urgente" : Math.abs(diff) >= 100000 ? "Alta" : "Media",
        despachado: dispatch
      };
    }).sort((a, b) => priorityOrder(a.prioridad) - priorityOrder(b.prioridad) || Math.abs(b.diff) - Math.abs(a.diff));
  }

  function normalizeCronologia(rows) {
    return normalizeRows(rows).map((row) => ({
      hora: getValue(row, ["hora", "Hora"]),
      titulo: getValue(row, ["titulo", "Titulo", "evento"]),
      descripcion: getValue(row, ["descripcion", "Descripcion", "detalle"])
    })).filter((row) => row.hora || row.titulo || row.descripcion);
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

  function isDispatch(row) {
    if (row.despachado === true) return true;
    const seguimiento = getValue(row, ["nro_seguimiento", "Seguimiento"]);
    const estado = normalizeText(getValue(row, ["estado_pim", "estado_envio", "Estado envio", "Estado"]));
    return Boolean(seguimiento) || ["a", "d", "despachado", "facturado"].includes(estado);
  }

  function getValue(row, fields) {
    for (const field of fields) {
      if (row[field] !== undefined && row[field] !== null && String(row[field]).trim() !== "") return String(row[field]).trim();
      const normalizedField = normalizeHeader(field);
      const key = Object.keys(row).find((candidate) => normalizeHeader(candidate) === normalizedField);
      if (key && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return String(row[key]).trim();
    }
    return "";
  }

  function toNumber(value) {
    if (value === undefined || value === null || value === "") return 0;
    let text = String(value).trim().replace(/\$/g, "").replace(/\s/g, "");
    if (!text) return 0;
    if (text.includes(",") && text.includes(".")) text = text.replace(/\./g, "").replace(",", ".");
    else if (text.includes(",")) text = text.replace(",", ".");
    else if ((text.match(/\./g) || []).length > 1) text = text.replace(/\./g, "");
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function valueOr(value, fallback) {
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function fmt(value) {
    return Number(value || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function fmtMoney(value) {
    return "$" + Number(value || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function pct(value, total) {
    return total ? (value / total * 100).toFixed(1) + "%" : "0.0%";
  }

  function formatHour(hour) {
    if (hour === "" || hour === undefined || hour === null) return "-";
    return String(hour).padStart(2, "0") + ":00";
  }

  function priorityClass(priority) {
    if (priority === "Urgente") return "badge-red";
    if (priority === "Alta") return "badge-orange";
    return "badge-blue";
  }

  function priorityOrder(priority) {
    return { Urgente: 0, Alta: 1, Media: 2 }[priority] ?? 3;
  }

  function sheetLabel(key) {
    return {
      pedidos_error: "Pedidos error",
      pedidos_pim: "PIM",
      pedidos_vtex: "VTEX",
    }[key] || key;
  }

  function normalizeHeader(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function normalizeStore(value) {
    const text = String(value || "Sin dato").trim();
    const normalized = normalizeText(text);
    if (normalized.includes("sporting")) return "Sporting";
    if (normalized.includes("woker")) return "Woker";
    if (normalized.includes("adidas")) return "Adidas Producteca";
    if (normalized.includes("b2b")) return "Ventas B2B";
    return text || "Sin dato";
  }

  function splitSites(value) {
    return String(value || "").split(",").map(normalizeStore).filter((site, index, array) => site && array.indexOf(site) === index);
  }

  function normalizeText(value) {
    return normalizeHeader(value);
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
