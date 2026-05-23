(function () {
  const cfg = window.PIM_INCIDENT_CONFIG;
  const manualPayments = new Set((cfg.manualPaymentMethods || []).map(normalizeText));

  const UNLOCK_MAX_ATTEMPTS = 5;
  const UNLOCK_LOCKOUT_MS = 5 * 60 * 1000;

  function getUnlockLockState() {
    try {
      const raw = localStorage.getItem("pim_unlock_lock");
      return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
    } catch (e) {
      return { attempts: 0, lockedUntil: 0 };
    }
  }
  function setUnlockLockState(s) {
    try { localStorage.setItem("pim_unlock_lock", JSON.stringify(s)); } catch (e) {}
  }
  function resetUnlockLockState() {
    try { localStorage.removeItem("pim_unlock_lock"); } catch (e) {}
  }

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
      bajas: { search: "", dispatchOnly: false, page: 1, perPage: 25 },
      sku: { search: "" }
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
      btn.addEventListener("click", () => { showTab(btn.dataset.tab); pushHash(); });
    });
    $("#unlockErrorsButton").addEventListener("click", unlockPedidosError);
    $("#errorPassword").addEventListener("keydown", (event) => {
      if (event.key === "Enter") unlockPedidosError();
    });
    $("#searchErrores").addEventListener("input", (event) => {
      state.filters.errores.search = event.target.value.trim().toLowerCase();
      state.filters.errores.page = 1;
      renderPedidosError();
      pushHash();
    });
    $("#searchBajas").addEventListener("input", (event) => {
      state.filters.bajas.search = event.target.value.trim().toLowerCase();
      state.filters.bajas.page = 1;
      renderBajas();
      pushHash();
    });
    $$("[data-filter-table]").forEach((btn) => {
      btn.addEventListener("click", () => { handleFilterButton(btn); pushHash(); });
    });
    $("#exportErroresBtn").addEventListener("click", exportErrores);
    $("#exportBajasBtn").addEventListener("click", exportBajas);
    const skuSearch = $("#searchSku");
    if (skuSearch) {
      skuSearch.addEventListener("input", (event) => {
        state.filters.sku.search = event.target.value.trim().toLowerCase();
        renderSku();
      });
    }
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
      readHash();
    } catch (error) {
      $("#sourceStatus").textContent = "Sin conexion";
      $("#sourceStatus").className = "status-pill error";
      showError(classifyLoadError(error));
      renderAll();
    } finally {
      setLoading(false);
    }
  }

  function classifyLoadError(error) {
    const msg = error.message || "";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("net::")) {
      return "Sin conexión a internet o bloqueo CORS. Verificar red e intentar nuevamente.";
    }
    if (msg.startsWith("HTTP ")) {
      const code = parseInt(msg.replace("HTTP ", ""), 10);
      if (code === 401 || code === 403) {
        return "Acceso denegado (HTTP " + code + "). Verificar que el Apps Script esté desplegado como 'Cualquier usuario'.";
      }
      if (code === 404) {
        return "URL no encontrada (HTTP 404). Verificar appScriptUrl en config.js.";
      }
      if (code === 429 || code === 503) {
        return "Apps Script temporalmente no disponible (HTTP " + code + "). Reintentar en unos minutos.";
      }
      if (code >= 500) {
        return "Error interno en Apps Script (HTTP " + code + "). Revisar registros en el editor de Google Apps Script.";
      }
      return "Error HTTP " + code + ". " + msg;
    }
    if (msg.toLowerCase().includes("json") || msg.toLowerCase().includes("unexpected token")) {
      return "La respuesta de Apps Script no es JSON válido. Verificar que el deploy esté activo y la URL sea correcta.";
    }
    return msg || "No se pudieron cargar los datos.";
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

    const lockState = getUnlockLockState();
    if (lockState.lockedUntil > Date.now()) {
      const mins = Math.ceil((lockState.lockedUntil - Date.now()) / 60000);
      status.textContent = `Demasiados intentos. Esperar ${mins} min.`;
      status.className = "unlock-status error";
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

      resetUnlockLockState();
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

      const ls = getUnlockLockState();
      ls.attempts = (ls.attempts || 0) + 1;
      if (ls.attempts >= UNLOCK_MAX_ATTEMPTS) {
        ls.lockedUntil = Date.now() + UNLOCK_LOCKOUT_MS;
        ls.attempts = 0;
        status.textContent = "Demasiados intentos. Bloqueado 5 min.";
      } else {
        const left = UNLOCK_MAX_ATTEMPTS - ls.attempts;
        status.textContent = `${error.message} (${left} intento${left !== 1 ? "s" : ""} restante${left !== 1 ? "s" : ""})`;
      }
      setUnlockLockState(ls);
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
    renderIncidentContext();
    renderOrderFlow();
    renderFinancialImpactSection();
    renderPaymentBreakdown();
    renderStoreBreakdown();
    renderHourChart();
    renderHealth();
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

  function renderIncidentContext() {
    const s = state.summary || {};
    const pedidosError = valueOr(s.pedidosError, cfg.expectedTotals.pedidosError);
    const pedidosPim = valueOr(s.pedidosPimUnicos, cfg.expectedTotals.pedidosPimUnicos);
    const total = pedidosError + pedidosPim;
    $("#incidentContext").innerHTML = `
      <div class="incident-context">
        <span class="badge badge-orange">Contenido · 22-05-2026</span>
        <p class="incident-context-text">
          El 21 de mayo, credenciales de API de <strong>producción</strong> quedaron activas en ambiente QA durante el proyecto de multidepósitos.
          Esto hizo que se enviaran precios y stock ficticios a <strong>Sporting y Woker</strong>.
          En total, <strong>${fmt(total)} pedidos</strong> recibieron precios incorrectos:
          <strong>${fmt(pedidosError)}</strong> fueron rechazados antes de procesar y
          <strong>${fmt(pedidosPim)}</strong> llegaron a ingresar a PIM.
          El incidente fue contenido el 22-05 con cancelación automática masiva y reactivación de depósitos.
        </p>
      </div>`;
  }

  function renderOrderFlow() {
    const s = state.summary || {};
    const f = state.financialImpact || {};
    const pedidosError = valueOr(s.pedidosError, cfg.expectedTotals.pedidosError);
    const pedidosPim = valueOr(s.pedidosPimUnicos, cfg.expectedTotals.pedidosPimUnicos);
    const total = pedidosError + pedidosPim;
    const gestionAuto = toNumber(s.gestionAutomatica);
    const gestionManual = toNumber(s.gestionManual);
    const facturadosDiff = toNumber(s.facturadosConDiferenciaPedidos);
    const bajaPedidos = valueOr(s.bajaPedidos, cfg.expectedTotals.bajaPedidos);
    const montoRechazado = toNumber(f.montoRechazado);
    const valorTotalPim = toNumber(f.valorTotalPim);
    const pctError = total > 0 ? Math.round(pedidosError / total * 100) : 0;
    const pctPim = total > 0 ? 100 - pctError : 0;
    // pedidos PIM sin error de precio = total PIM menos los que sí tuvieron problema
    const pimSinError = Math.max(0, pedidosPim - bajaPedidos - facturadosDiff);

    const flowRow = (label, val, cls = "") =>
      `<div class="flow-row ${cls}">
        <span class="flow-row-label">${escapeHtml(label)}</span>
        <span class="flow-row-val">${val}</span>
      </div>`;

    $("#orderFlow").innerHTML = `
      <div class="order-flow">
        <div class="flow-summary-bar">
          <div class="flow-summary-left">
            <span class="flow-summary-number">${fmt(total)}</span>
            <span class="flow-summary-label">pedidos afectados en total · 21–22 mayo 2026 · Sporting y Woker</span>
          </div>
          <div class="flow-split-bar">
            <div class="flow-split-seg flow-split-red" style="width:${pctError}%">
              <span>${pctError}% rechazados</span>
            </div>
            <div class="flow-split-seg flow-split-blue" style="width:${pctPim}%">
              <span>${pctPim}% a PIM</span>
            </div>
          </div>
        </div>
        <div class="flow-buckets">
          <div class="flow-bucket bucket-rejected">
            <div class="flow-bucket-eyebrow">Rechazados · No llegaron a PIM</div>
            <div class="flow-bucket-number red">${fmt(pedidosError)}</div>
            <div class="flow-bucket-title">Pedidos rechazados</div>
            <div class="flow-bucket-desc">
              Pasaron a error por <strong>falta de stock</strong>. El sistema los rechazó antes de ingresar a PIM.
              No generan pérdida directa, pero el dinero cobrado fue devuelto a los clientes.
            </div>
            ${montoRechazado > 0 ? `<div class="flow-monto">Monto total reembolsado: <strong>${fmtMoney(montoRechazado)}</strong></div>` : ""}
            <div class="flow-rows">
              ${flowRow("Cancelación automática — reembolso por PayWay/VTEX", fmt(gestionAuto), "green")}
              ${flowRow("Reembolso manual completado el 22-05 — MercadoPago / GoCuotas", fmt(gestionManual), "orange")}
            </div>
          </div>
          <div class="flow-bucket bucket-pim">
            <div class="flow-bucket-eyebrow">Ingresaron a PIM · Había stock disponible</div>
            <div class="flow-bucket-number blue">${fmt(pedidosPim)}</div>
            <div class="flow-bucket-title">Procesados en PIM</div>
            <div class="flow-bucket-desc">
              Tenían stock real y avanzaron normalmente.
              <strong>La mayoría ingresó sin error de precio</strong> — solo un subconjunto tenía el precio incorrecto
              y fue dado de baja o facturado con diferencia.
            </div>
            ${valorTotalPim > 0 ? `<div class="flow-monto">Valor total en PIM: <strong>${fmtMoney(valorTotalPim)}</strong></div>` : ""}
            <div class="flow-rows">
              ${flowRow("Sin error de precio — operaron con normalidad", fmt(pimSinError))}
              ${flowRow("Dados de baja por precio incorrecto — corregidos", fmt(bajaPedidos), "green")}
              ${flowRow("Facturados con precio incorrecto — ver pestaña PIM y bajas", fmt(facturadosDiff), facturadosDiff > 0 ? "red" : "")}
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderFinancialImpactSection() {
    const s = state.summary || {};
    const f = state.financialImpact || {};
    const perdidaReal = f.perdidaReal != null ? toNumber(f.perdidaReal) : toNumber(s.perdidaReal);
    const potencialPerdida = toNumber(f.potencialPerdida);
    const ticketActual = toNumber(f.ticketPromedioActual || (cfg.referenceMetrics && cfg.referenceMetrics.ticketPromedioActual));
    const ticketError = toNumber(f.ticketPromedioError);
    const brecha = toNumber(f.brechaTicket);
    const pedidosError = valueOr(s.pedidosError, cfg.expectedTotals.pedidosError);
    const facturadosDiff = toNumber(s.facturadosConDiferenciaPedidos);

    const detailRow = (label, val, highlight = false) =>
      `<div class="loss-detail-row${highlight ? " highlight" : ""}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(val))}</strong>
      </div>`;

    const realCard = `
      <div class="loss-card loss-real">
        <div class="loss-card-eyebrow">1. Pérdida real confirmada</div>
        <div class="loss-card-amount">${fmtMoney(perdidaReal)}</div>
        <p class="loss-card-explain">
          Son los pedidos que <strong>ya se facturaron</strong> con el precio incorrecto.
          El cliente pagó menos de lo que correspondía según el precio real del producto.
          Si el pedido ya salió despachado, la diferencia <strong>no se puede recuperar</strong>.
        </p>
        <div class="loss-detail-rows">
          ${detailRow("Pedidos facturados con precio incorrecto", fmt(facturadosDiff))}
          ${detailRow("Diferencia entre precio cobrado y precio correcto", fmtMoney(perdidaReal), true)}
        </div>
      </div>`;

    const hasPotencial = potencialPerdida > 0 && ticketActual > 0;
    const potentialCard = `
      <div class="loss-card loss-potential">
        <div class="loss-card-eyebrow">2. Riesgo de compensación — supuesto</div>
        <div class="loss-card-amount">${hasPotencial ? fmtMoney(potencialPerdida) : "—"}</div>
        <p class="loss-card-explain">
          <strong>Escenario hipotético:</strong> si los clientes con pedidos rechazados reclamaran y hubiera que
          compensarlos entregando un producto similar al precio correcto de mercado,
          la pérdida por pedido sería la diferencia entre el ticket promedio real y el precio con error.
          No es una pérdida ocurrida — es el <strong>techo máximo de exposición</strong> ante reclamos masivos.
        </p>
        <div class="loss-detail-rows">
          ${detailRow("Ticket promedio precio correcto (mercado)", fmtMoney(ticketActual))}
          ${detailRow("Ticket promedio precio del incidente (lo que el cliente esperaba pagar)", fmtMoney(ticketError))}
          ${detailRow("Diferencia por pedido a compensar", fmtMoney(brecha))}
          ${detailRow(fmt(pedidosError) + " pedidos rechazados × diferencia", fmtMoney(potencialPerdida), true)}
        </div>
      </div>`;

    $("#financialImpactSection").innerHTML = `<div class="loss-cards">${realCard}${potentialCard}</div>`;
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
    const s = state.summary || {};
    const f = state.financialImpact || {};
    const perdida = f.perdidaReal != null ? f.perdidaReal : s.perdidaReal;
    $("#summaryKpis").innerHTML = [
      kpi("Gestión manual pendiente", fmt(s.gestionManual), "MercadoPago Pro y GoCuotas — reembolso por servicio al cliente", "orange"),
      kpi("Facturados con diferencia", fmt(s.facturadosConDiferenciaPedidos), "Avanzaron con precio incorrecto — revisar en pestaña PIM y bajas", "red"),
      kpi("Pérdida expuesta", fmtMoney(perdida), "Diferencia de precio fuera del estado Baja", "red"),
      kpi("Bajas por diferencia", fmt(s.bajaPorDiferenciaPedidos), `${fmt(s.bajaPorDiferenciaItems)} ítems dados de baja por precio incorrecto`, "orange"),
    ].join("");
  }

  function renderFinancialKpis() {
    const s = state.summary || {};
    const f = state.financialImpact || {};
    $("#financialKpis").innerHTML = [
      kpi("Pedidos rechazados", fmt(valueOr(s.pedidosError, cfg.expectedTotals.pedidosError)), `${fmt(s.gestionAutomatica)} automática · ${fmt(s.gestionManual)} manual`, "red"),
      kpi("Ingresaron a PIM", fmt(valueOr(s.pedidosPimUnicos, cfg.expectedTotals.pedidosPimUnicos)), `${fmt(valueOr(s.pedidosPimItems, cfg.expectedTotals.pedidosPimItems))} ítems registrados en sistema`, "blue"),
      kpi("Bajas PIM", fmt(valueOr(s.bajaPedidos, cfg.expectedTotals.bajaPedidos)), `${fmt(valueOr(s.bajaItems, cfg.expectedTotals.bajaItems))} ítems dados de baja`, "orange"),
      kpi("Monto rechazado", fmtMoney(f.montoRechazado), "Suma total de pedidos con error", "red"),
      kpi("Valor total en PIM", fmtMoney(f.valorTotalPim), "Ítems que ingresaron a PIM", "blue"),
      kpi("SKUs únicos afectados", fmt(s.skusErrorUnicos), "Productos distintos involucrados en pedidos de error", "purple"),
    ].join("");
  }

  function classifyTimelineEvent(titulo, descripcion) {
    const t = normalizeText(titulo + " " + descripcion);
    if (t.includes("deteccion") || t.includes("detecta") || t.includes("alerta")) return "detection";
    if (t.includes("escalad") || t.includes("escalo") || t.includes("b2b")) return "escalation";
    if (t.includes("completad") || t.includes("normalizacion") || t.includes("reactivacion") || t.includes("reunion")) return "resolution";
    return "action";
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
    const typeLabel = { detection: "Detección", action: "Acción", escalation: "Escalado", resolution: "Resolución" };
    const typeBadge = { detection: "badge-blue", action: "badge-orange", escalation: "badge-purple", resolution: "badge-green" };

    let lastDay = "";
    const html = rows.map((row) => {
      const hora = getValue(row, ["hora", "Hora"]) || "";
      const titulo = getValue(row, ["titulo", "Titulo", "evento"]) || "Evento sin título";
      const descripcion = getValue(row, ["descripcion", "Descripcion", "detalle"]) || "";
      const type = classifyTimelineEvent(titulo, descripcion);
      const dayPart = hora.split("·")[0].trim();
      let dayHeader = "";
      if (dayPart && dayPart !== lastDay) {
        lastDay = dayPart;
        dayHeader = `<div class="timeline-day-sep"><span>${escapeHtml(dayPart)}</span></div>`;
      }
      return `${dayHeader}<article class="timeline-item tl-${type}">
        <div class="timeline-time">${escapeHtml(hora || "Pendiente")}</div>
        <div>
          <div class="timeline-title-row">
            <div class="timeline-title">${escapeHtml(titulo)}</div>
            <span class="badge ${typeBadge[type]}">${typeLabel[type]}</span>
          </div>
          <p class="timeline-desc">${escapeHtml(descripcion)}</p>
        </div>
      </article>`;
    }).join("");

    $("#timeline").innerHTML = html;
  }

  function renderSku() {
    const allRows = state.skuImpact || [];
    const search = normalizeText(state.filters.sku.search || "");
    const rows = search
      ? allRows.filter((row) => normalizeText(row.sku + " " + row.producto).includes(search))
      : allRows;

    const countEl = $("#countSku");
    if (countEl) countEl.textContent = `${fmt(rows.length)} SKUs`;

    $("#skuEmpty").classList.toggle("hidden", allRows.length > 0);
    $("#skuTableWrap").classList.toggle("hidden", allRows.length === 0);
    $("#tbodySku").innerHTML = rows.length ? rows.map((row) => `
      <tr>
        <td class="td-mono">${escapeHtml(row.sku)}</td>
        <td>${escapeHtml(row.producto)}</td>
        <td>${escapeHtml(row.sitios)}</td>
        <td class="td-right td-mono">${fmt(row.pedidos)}</td>
        <td class="td-right td-mono">${fmt(row.unidades)}</td>
        <td class="td-right td-mono">${fmtMoney(row.monto)}</td>
      </tr>
    `).join("") : (allRows.length ? emptyRow(6, "Sin resultados para la búsqueda.") : "");
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
      const diffVal = toNumber(row.diff);
      const diffClass = diffVal < -100 ? "td-diff-neg" : "";
      return `
        <tr class="${dispatch ? "flagged" : ""}">
          <td class="td-mono">${escapeHtml(row.nro_pedido_canal)}</td>
          <td class="td-mono">${escapeHtml(row.sku)}</td>
          <td>${escapeHtml(row.producto)}</td>
          <td class="td-right td-mono">${fmt(row.cantidad)}</td>
          <td class="td-right td-mono">${fmtMoney(row.importe_pagado)}</td>
          <td class="td-right td-mono">${fmtMoney(row.precio_actual)}</td>
          <td class="td-right td-mono ${diffClass}">${fmtMoney(diffVal)}</td>
          <td><span class="badge ${dispatch ? "badge-red" : normalizeText(row.estado_pim) === "baja" ? "badge-green" : "badge-orange"}">${escapeHtml(row.estado_pim || row.estado_envio || "-")}</span></td>
          <td><span class="badge ${priorityClass(row.prioridad)}">${escapeHtml(row.prioridad || "Media")}</span></td>
        </tr>`;
    }).join("") : emptyRow(9, "No hay bajas para mostrar con los filtros actuales.");

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

  function exportCsv(rows, filename, columns) {
    const lines = [
      columns.map((c) => c.label),
      ...rows.map((row) => columns.map((c) => {
        const val = row[c.key] != null ? row[c.key] : "";
        const str = String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? '"' + str.replace(/"/g, '""') + '"'
          : str;
      }))
    ];
    const csv = "﻿" + lines.map((l) => l.join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportErrores() {
    if (!state.pedidosErrorUnlocked) return;
    const rows = applyFilter(state.pedidosError || [], state.filters.errores);
    const date = new Date().toISOString().slice(0, 10);
    exportCsv(rows, `pedidos-error-${date}.csv`, [
      { label: "Fecha alta",       key: "fecha_alta" },
      { label: "Nro pedido",       key: "nro_pedido_canal" },
      { label: "Medio de pago",    key: "tipo_pago" },
      { label: "Hora real",        key: "hora_real" },
      { label: "Gestion",          key: "tipo_gestion" },
      { label: "Sitio",            key: "sitio" },
      { label: "Unidades",         key: "unidades" },
      { label: "Monto",            key: "monto" }
    ]);
  }

  function exportBajas() {
    const rows = applyBajaFilter(state.bajasPrioritarias || [], state.filters.bajas);
    const date = new Date().toISOString().slice(0, 10);
    exportCsv(rows, `bajas-prioritarias-${date}.csv`, [
      { label: "Nro pedido",       key: "nro_pedido_canal" },
      { label: "SKU",              key: "sku" },
      { label: "Producto",         key: "producto" },
      { label: "Cantidad",         key: "cantidad" },
      { label: "Importe pagado",   key: "importe_pagado" },
      { label: "Precio correcto",  key: "precio_actual" },
      { label: "Diferencia",       key: "diff" },
      { label: "Estado PIM",       key: "estado_pim" },
      { label: "Prioridad",        key: "prioridad" }
    ]);
  }

  function pushHash() {
    const params = new URLSearchParams();
    const activeTabEl = document.querySelector(".nav-tab.active");
    if (activeTabEl && activeTabEl.dataset.tab) params.set("tab", activeTabEl.dataset.tab);
    const ef = state.filters.errores;
    if (ef.search)       params.set("es", ef.search);
    if (ef.field)        params.set("ef", ef.field);
    if (ef.value)        params.set("ev", ef.value);
    const bf = state.filters.bajas;
    if (bf.search)       params.set("bs", bf.search);
    if (bf.dispatchOnly) params.set("bd", "1");
    const hash = params.toString();
    history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
  }

  function readHash() {
    if (!location.hash) return;
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("tab")) showTab(params.get("tab"));
    const ef = state.filters.errores;
    if (params.has("es")) { ef.search = params.get("es"); const el = $("#searchErrores"); if (el) el.value = ef.search; }
    if (params.has("ef")) ef.field = params.get("ef");
    if (params.has("ev")) ef.value = params.get("ev");
    const bf = state.filters.bajas;
    if (params.has("bs")) { bf.search = params.get("bs"); const el = $("#searchBajas"); if (el) el.value = bf.search; }
    if (params.has("bd")) bf.dispatchOnly = true;
    $$("[data-filter-table='bajas']").forEach((btn) => {
      if (btn.dataset.filterDispatch) btn.classList.toggle("active", bf.dispatchOnly);
      else if (btn.dataset.filterField) btn.classList.toggle("active", bf.field === btn.dataset.filterField && bf.value === btn.dataset.filterValue);
    });
    renderPedidosError();
    renderBajas();
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
      const errorPrecio = normalizeText(getValue(row, ["Error Precio", "error_precio", "Error precio"])) === "si";
      // If the sheet has "Error Precio" column, use it to confirm incident errors.
      // Otherwise fall back to dispatch status (old behavior).
      const esIncidente = errorPrecio || (!row["Error Precio"] && !row["error_precio"] && !row["Error precio"] && dispatch);
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
        prioridad: esIncidente ? "Urgente" : Math.abs(diff) >= 100000 ? "Alta" : "Media",
        despachado: esIncidente
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
      { hora: "21-05 · 13:30", titulo: "Deteccion de precios incorrectos", descripcion: "Se detectaron productos ofreciendo precios por debajo de lo normal. Prueba de compra confirmo que algunos no permitían finalizar la compra. Se detecto stock fantasma: articulos viejos levantando stock y precio historico inicial." },
      { hora: "21-05 · 13:30", titulo: "Inicio de pausa manual de publicaciones", descripcion: "Se comenzaron a pausar manualmente las publicaciones donde se detectaban precios inusuales." },
      { hora: "21-05 · 13:50", titulo: "Alerta a equipos de soporte", descripcion: "Se informo a los equipos de soporte de PIM e Infracommerce. Se compartieron productos de ejemplo y referencias visuales para evaluar la problematica." },
      { hora: "21-05 · 14:00", titulo: "Nueva problematica detectada", descripcion: "Se detecto que ciertas variantes de talles levantaban stock y precios incorrectos. Esto complejizo la identificacion de productos afectados. Se continuo pausando publicaciones y realizando revision mas exhaustiva." },
      { hora: "21-05 · 15:00", titulo: "Relacion con stock fantasma de depositos 01 y 17", descripcion: "Se detecto relacion con depositos 01 y 17 de Sporting. Articulos activos pasaron de 4507 a 4713 (+206) en pocas horas. Se apagaron depositos 01 y 17 tambien para Woker." },
      { hora: "21-05 · 15:30", titulo: "Deposito 45 comprometido", descripcion: "Se detecto que el deposito 45 tambien estaba enviando informacion incorrecta para ciertos articulos." },
      { hora: "21-05 · 15:40", titulo: "Pulso de stock y precio", descripcion: "Se envio actualizacion para depositos involucrados. Tiempo estimado de impacto: 6 horas." },
      { hora: "21-05 · 15:45", titulo: "Escalado a B2B", descripcion: "Se detecto que la problematica tambien escalo al canal B2B." },
      { hora: "21-05 · 17:50", titulo: "Apagado deposito 45", descripcion: "Se apago el deposito 45 en ambas tiendas (Sporting y Woker) para contener la incidencia." },
      { hora: "21-05 · 19:00", titulo: "Notificacion a sucursales y automatizacion PIM", descripcion: "Se notifico a sucursales para no despachar. Agentes PIM crearon automatizacion masiva para cancelar pedidos con error en PIM, evitando trabajo manual. La automatizacion cancela en VTEX y VTEX genera reembolso en PayWay." },
      { hora: "22-05 · 08:30", titulo: "Pulso de cancelacion automatica hacia VTEX", descripcion: "Se envio el pulso de cancelacion. Se excluyeron pedidos abonados con MercadoPago y GoCuotas, que requieren gestion manual." },
      { hora: "22-05 · 09:30", titulo: "Inicio reembolsos manuales MP y GoCuotas", descripcion: "Se paso el archivo con los 620 pedidos de error de MercadoPago y GoCuotas a la jefa de servicio al cliente para comenzar el proceso de reembolso manual." },
      { hora: "22-05 · 10:00", titulo: "Reunion con PIM", descripcion: "Reunion para aclarar el error, definir causa raiz y acordar proximos pasos." },
      { hora: "22-05 · 10:50", titulo: "Normalizacion B2B completada", descripcion: "Termino de impactar el push para B2B, normalizando precio y stock en ese canal." },
      { hora: "22-05 · 11:30", titulo: "Reactivacion deposito 45", descripcion: "Se activo nuevamente el deposito 45 una vez confirmada la normalizacion de datos." },
      { hora: "22-05 · 12:30", titulo: "Automatizacion de cancelacion completada", descripcion: "Termino de correr la automatizacion de cancelacion de pedidos con error hacia VTEX." },
      { hora: "22-05 · 13:00", titulo: "Baja manual de pedidos activos en PIM", descripcion: "Se avanzo con la baja de pedidos que ingresaron a PIM pero tenian items con diferencia de precios y aun no estaban despachados. Se realizo de forma manual desde PIM." },
      { hora: "22-05 · 13:45", titulo: "Reactivacion depositos 17 y 01", descripcion: "Se reactivaron los depositos 17 y 01 confirmando la normalizacion completa del incidente." },
      { hora: "22-05 · 17:00", titulo: "Finalizacion de reembolsos manuales", descripcion: "Los agentes de servicio al cliente completaron la gestion de los 620 reembolsos manuales correspondientes a pedidos abonados con MercadoPago y GoCuotas." }
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
