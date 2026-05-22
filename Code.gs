const CACHE_KEY = "pim_incident_dashboard_v3";
const CACHE_TTL_SECONDS = 300;
const HIGH_DIFF_THRESHOLD = 100000;
const SKU_IMPACT_LIMIT = 120;
const REFERENCE_TICKET_ACTUAL = 135000;

const SHEETS = {
  pedidosError: ["pedidos_error", "Pedidos con Error", "1-Pedidos con Error"],
  pedidosPim: ["pedidos_pim", "Pedidos PIM"],
  pedidosVtex: ["pedidos_vtex", "Pedidos VTEX", "Vtex Woker", "Vtex Sporting"],
  cronologia: ["cronologia", "Cronologia", "Cronología"],
  skuResumen: ["sku_resumen", "SKU resumen", "2-Análisis por SKU", "2-Analisis por SKU"]
};

const REQUIRED_COLUMNS = {
  pedidosError: ["fecha_alta", "nro_pedido_canal", "tipo_pago", "Hora real"],
  pedidosPim: ["Nro Pedido", "Tienda", "Sku", "Producto", "Cantidad", "Estado Actual"],
  pedidosVtex: ["Order", "Reference Code", "SKU Name", "Quantity_SKU", "Seller Name"]
};

const MANUAL_PAYMENT_METHODS = ["mercado_pago_pro", "gocuotas"];

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.view === "pedidos_error") {
      return json_(buildProtectedPedidosError_(e.parameter.password || ""));
    }

    var shouldRefresh = e && e.parameter && e.parameter.refresh === "1";
    var cache = CacheService.getScriptCache();

    if (!shouldRefresh) {
      var cached = cache.get(CACHE_KEY);
      if (cached) {
        var cachedPayload = JSON.parse(cached);
        cachedPayload.health.cacheStatus = "hit";
        return json_(cachedPayload);
      }
    }

    var payload = buildPayload_();
    payload.health.cacheStatus = "miss";
    try {
      cache.put(CACHE_KEY, JSON.stringify(payload), CACHE_TTL_SECONDS);
    } catch (cacheError) {
      payload.health.cacheStatus = "disabled";
      payload.health.cacheError = cacheError.message;
    }
    return json_(payload);
  } catch (error) {
    return json_({
      updatedAt: new Date().toISOString(),
      error: error.message
    });
  }
}

function buildProtectedPedidosError_(password) {
  var expectedPassword = PropertiesService.getScriptProperties().getProperty("ERROR_TABLE_PASSWORD");
  if (!expectedPassword) {
    return {
      error: "ERROR_TABLE_PASSWORD no esta configurada en Propiedades del script."
    };
  }
  if (String(password || "") !== expectedPassword) {
    return {
      error: "Contrasena incorrecta."
    };
  }

  var pedidosError = readSheet_(SHEETS.pedidosError, REQUIRED_COLUMNS.pedidosError);
  var pedidosVtex = readSheet_(SHEETS.pedidosVtex, REQUIRED_COLUMNS.pedidosVtex);
  var pedidosVtexError = filterVtexByPedidosError_(pedidosVtex.rows, pedidosError.rows);
  var vtexByOrder = buildVtexMetaByOrder_(pedidosVtexError);

  return {
    updatedAt: new Date().toISOString(),
    pedidosErrorDetalle: pedidosError.rows.map(function(row) {
      var order = getAny_(row, ["nro_pedido_canal", "Order", "Nro Pedido"]);
      var core = getOrderCore_(order);
      var meta = vtexByOrder[core] || {};
      var payment = getAny_(row, ["tipo_pago", "Payment System Name", "Medio de Pago"]);

      return {
        fecha_alta: getAny_(row, ["fecha_alta", "Fecha Alta", "fecha_alta.1"]),
        nro_pedido_canal: order,
        tipo_pago: payment,
        hora_real: getRealHour_(row),
        tipo_gestion: MANUAL_PAYMENT_METHODS.indexOf(normalizeText_(payment)) >= 0 ? "Manual" : "Automatica",
        sitio: meta.sitio || "",
        unidades: meta.unidades || 0,
        monto: meta.monto || 0
      };
    })
  };
}

function buildPayload_() {
  var pedidosError = readSheet_(SHEETS.pedidosError, REQUIRED_COLUMNS.pedidosError);
  var pedidosPim = readSheet_(SHEETS.pedidosPim, REQUIRED_COLUMNS.pedidosPim);
  var pedidosVtex = readSheet_(SHEETS.pedidosVtex, REQUIRED_COLUMNS.pedidosVtex);
  var cronologia = readSheet_(SHEETS.cronologia, []);
  var skuResumen = readSheet_(SHEETS.skuResumen, []);
  var pedidosVtexError = filterVtexByPedidosError_(pedidosVtex.rows, pedidosError.rows);

  var summary = buildSummary_(pedidosError.rows, pedidosPim.rows, pedidosVtex.rows, pedidosVtexError);
  var health = buildHealth_([pedidosError, pedidosPim, pedidosVtex]);

  // Validate price columns needed for financial calculations (multi-alias, not coverable by REQUIRED_COLUMNS)
  validateAliasColumns_(health, "pedidosPim", pedidosPim.headers, [
    { label: "precio pagado (PrecioWEB / Imp. Pagado)", aliases: ["PrecioWEB", "Precio WEB", "Precio Web", "Imp. Pagado", "Importe Pagado", "importe_pagado"] },
    { label: "precio correcto (PrecioPIM / Precio Correcto)", aliases: ["PrecioPIM", "Precio PIM", "Precio Correcto", "precio_actual", "Precio Actual"] }
  ]);
  validateAliasColumns_(health, "pedidosVtex", pedidosVtex.headers, [
    { label: "monto por pedido (SKU Total Price / Payment Value)", aliases: ["SKU Total Price", "Total Value", "Payment Value", "monto"] }
  ]);

  return {
    updatedAt: new Date().toISOString(),
    health: health,
    summary: summary,
    paymentBreakdown: buildPaymentBreakdown_(pedidosError.rows, pedidosVtexError),
    storeBreakdown: buildStoreBreakdown_(pedidosVtexError),
    hourlyError: buildHourlyError_(pedidosError.rows),
    financialImpact: buildFinancialImpact_(pedidosError.rows, pedidosPim.rows, pedidosVtexError, summary),
    skuImpact: skuResumen.rows.length ? buildSkuImpactFromSummary_(skuResumen.rows) : buildSkuImpactFromVtex_(pedidosVtexError),
    bajasPrioritarias: buildBajasPrioritariasFromPim_(pedidosPim.rows),
    cronologia: buildCronologia_(cronologia.rows)
  };
}

function buildSummary_(pedidosError, pedidosPim, pedidosVtex, pedidosVtexError) {
  var manual = pedidosError.filter(function(row) {
    return MANUAL_PAYMENT_METHODS.indexOf(normalizeText_(getAny_(row, ["tipo_pago", "Payment System Name", "Medio de Pago"]))) >= 0;
  }).length;
  var pedidoPimIds = uniqueValues_(pedidosPim, ["Nro Pedido", "nro_pedido_canal", "Nro pedido"]);
  var pedidoVtexIds = uniqueValues_(pedidosVtex, ["Order", "Nro Pedido", "nro_pedido_canal"]);
  var errorSkuIds = uniqueValues_(pedidosVtexError, ["Reference Code", "SKU", "Sku", "sku", "ID_SKU"]);
  var pimMetrics = buildPimPriceMetrics_(pedidosPim);

  return {
    pedidosTotalesIncidente: pedidosError.length + pedidoPimIds.length,
    pedidosError: pedidosError.length,
    gestionManual: manual,
    gestionAutomatica: Math.max(0, pedidosError.length - manual),
    pedidosPimItems: pedidosPim.length,
    pedidosPimUnicos: pedidoPimIds.length,
    pedidosPimSinError: Math.max(0, pedidoPimIds.length - pimMetrics.pedidosConDiferencia),
    pedidosVtexItems: pedidosVtex.length,
    pedidosVtexUnicos: pedidoVtexIds.length,
    unidadesRechazadas: sumRows_(pedidosVtexError, ["Quantity_SKU", "Cantidad", "cantidad"]),
    skusErrorUnicos: errorSkuIds.length,
    montoRechazado: sumRows_(pedidosVtexError, ["SKU Total Price", "Total Value", "Payment Value", "monto"]),
    bajaItems: pimMetrics.bajaItems,
    bajaPedidos: pimMetrics.bajaPedidos,
    bajaPorDiferenciaItems: pimMetrics.bajaPorDiferenciaItems,
    bajaPorDiferenciaPedidos: pimMetrics.bajaPorDiferenciaPedidos,
    bajaNormalItems: pimMetrics.bajaNormalItems,
    bajaNormalPedidos: pimMetrics.bajaNormalPedidos,
    pimConDiferenciaItems: pimMetrics.itemsConDiferencia,
    pimConDiferenciaPedidos: pimMetrics.pedidosConDiferencia,
    facturadosConDiferenciaItems: pimMetrics.facturadosConDiferenciaItems,
    facturadosConDiferenciaPedidos: pimMetrics.facturadosConDiferenciaPedidos,
    expuestosConDiferenciaItems: pimMetrics.expuestosConDiferenciaItems,
    expuestosConDiferenciaPedidos: pimMetrics.expuestosConDiferenciaPedidos,
    importePagado: pimMetrics.importePagadoDiferencia,
    diferenciaTotal: pimMetrics.diferenciaTotal,
    perdidaReal: pimMetrics.perdidaReal,
    despachados: pimMetrics.facturadosConDiferenciaItems
  };
}

function buildFinancialImpact_(pedidosError, pedidosPim, pedidosVtexError, summary) {
  var errorAmount = summary.montoRechazado || sumRows_(pedidosVtexError, ["SKU Total Price", "Total Value", "Payment Value", "monto"]);
  var pimValue = sumRows_(pedidosPim, ["PrecioWEB", "Precio WEB", "Precio Web", "Valor", "PrecioPIM", "Precio PIM"]);
  var facturadoValue = pedidosPim.filter(function(row) {
    return normalizeText_(getAny_(row, ["Estado Actual", "Estado", "estado"])) === "facturado";
  }).reduce(function(total, row) {
    return total + toNumber_(getAny_(row, ["PrecioWEB", "Precio WEB", "Precio Web", "Valor", "PrecioPIM", "Precio PIM"]));
  }, 0);
  var ticketActual = REFERENCE_TICKET_ACTUAL;
  var ticketError = summary.pedidosError ? errorAmount / summary.pedidosError : 0;
  var brecha = ticketActual - ticketError;

  return {
    montoRechazado: errorAmount,
    valorTotalPim: pimValue,
    valorFacturado: facturadoValue,
    importeCobradoError: summary.importePagado,
    diferenciaPrecioCorrecto: summary.diferenciaTotal,
    perdidaReal: summary.perdidaReal,
    ticketPromedioActual: ticketActual,
    ticketPromedioError: ticketError,
    brechaTicket: brecha,
    potencialPerdida: Math.abs(brecha) * summary.pedidosError,
    precioPromedioCorrectoBaja: summary.pimConDiferenciaItems ? (summary.importePagado + Math.abs(summary.diferenciaTotal)) / summary.pimConDiferenciaItems : 0,
    precioPromedioPagadoBaja: summary.pimConDiferenciaItems ? summary.importePagado / summary.pimConDiferenciaItems : 0
  };
}

function buildStoreBreakdown_(rows) {
  var grouped = {};
  rows.forEach(function(row) {
    var store = normalizeStore_(getAny_(row, ["Seller Name", "Tienda", "Host"]));
    var order = getAny_(row, ["Order", "Nro Pedido", "nro_pedido_canal"]);
    if (!grouped[store]) {
      grouped[store] = {
        tienda: store,
        pedidosMap: {},
        unidades: 0,
        monto: 0
      };
    }
    if (order) grouped[store].pedidosMap[order] = true;
    grouped[store].unidades += toNumber_(getAny_(row, ["Quantity_SKU", "Cantidad", "cantidad"])) || 1;
    grouped[store].monto += toNumber_(getAny_(row, ["SKU Total Price", "Total Value", "Payment Value", "monto"]));
  });

  return Object.keys(grouped).map(function(store) {
    var item = grouped[store];
    return {
      tienda: item.tienda,
      pedidos: Object.keys(item.pedidosMap).length,
      unidades: item.unidades,
      monto: item.monto
    };
  }).sort(function(a, b) {
    return b.monto - a.monto;
  });
}

function buildHealth_(sheetResults) {
  var sheets = {};
  var hasMissingRequired = false;

  sheetResults.forEach(function(result) {
    sheets[result.key] = {
      name: result.name,
      found: result.found,
      rows: result.rows.length,
      missingColumns: result.missingColumns
    };
    if (!result.found || result.missingColumns.length) hasMissingRequired = true;
  });

  return {
    status: hasMissingRequired ? "warning" : "ok",
    cacheStatus: "miss",
    ttlSeconds: CACHE_TTL_SECONDS,
    sheets: sheets
  };
}

function buildPaymentBreakdown_(rows, pedidosVtexError) {
  var groups = {};
  var amountByOrder = buildAmountByOrder_(pedidosVtexError);
  rows.forEach(function(row) {
    var payment = getAny_(row, ["tipo_pago", "Payment System Name", "Medio de Pago"]) || "Sin dato";
    var orderCore = getOrderCore_(getAny_(row, ["nro_pedido_canal", "Order", "Nro Pedido"]));
    var key = String(payment);
    if (!groups[key]) {
      groups[key] = {
        tipo: key,
        pedidos: 0,
        monto: 0,
        gestion: MANUAL_PAYMENT_METHODS.indexOf(normalizeText_(key)) >= 0 ? "Manual" : "Automatica"
      };
    }
    groups[key].pedidos += 1;
    groups[key].monto += amountByOrder[orderCore] || 0;
  });

  return Object.keys(groups).map(function(key) {
    return groups[key];
  }).sort(function(a, b) {
    return b.pedidos - a.pedidos;
  });
}

function buildHourlyError_(rows) {
  var groups = {};
  rows.forEach(function(row) {
    var hour = getRealHour_(row);
    if (hour === "") return;
    if (!groups[hour]) groups[hour] = { hora: hour, pedidos: 0 };
    groups[hour].pedidos += 1;
  });

  return Object.keys(groups).map(function(hour) {
    return groups[hour];
  }).sort(function(a, b) {
    return Number(a.hora) - Number(b.hora);
  });
}

function filterVtexByPedidosError_(pedidosVtex, pedidosError) {
  var errorOrders = {};
  pedidosError.forEach(function(row) {
    var core = getOrderCore_(getAny_(row, ["nro_pedido_canal", "Order", "Nro Pedido"]));
    if (core) errorOrders[core] = true;
  });

  return pedidosVtex.filter(function(row) {
    var core = getOrderCore_(getAny_(row, ["Order", "Nro Pedido", "nro_pedido_canal"]));
    return !!errorOrders[core];
  });
}

function buildAmountByOrder_(rows) {
  var totals = {};
  rows.forEach(function(row) {
    var core = getOrderCore_(getAny_(row, ["Order", "Nro Pedido", "nro_pedido_canal"]));
    if (!core) return;
    totals[core] = (totals[core] || 0) + toNumber_(getAny_(row, ["SKU Total Price", "Total Value", "Payment Value", "monto"]));
  });
  return totals;
}

function buildVtexMetaByOrder_(rows) {
  var meta = {};
  rows.forEach(function(row) {
    var core = getOrderCore_(getAny_(row, ["Order", "Nro Pedido", "nro_pedido_canal"]));
    if (!core) return;
    if (!meta[core]) {
      meta[core] = {
        sitio: "",
        sitios: {},
        unidades: 0,
        monto: 0
      };
    }
    var sitio = normalizeStore_(getAny_(row, ["Seller Name", "Tienda", "Host"]));
    if (sitio) meta[core].sitios[sitio] = true;
    meta[core].sitio = Object.keys(meta[core].sitios).join(", ");
    meta[core].unidades += toNumber_(getAny_(row, ["Quantity_SKU", "Cantidad", "cantidad"])) || 1;
    meta[core].monto += toNumber_(getAny_(row, ["SKU Total Price", "Total Value", "Payment Value", "monto"]));
  });
  return meta;
}

function buildSkuImpactFromVtex_(rows, limit) {
  var grouped = {};
  rows.forEach(function(row) {
    var sku = getAny_(row, ["Reference Code", "SKU", "Sku", "sku", "ID_SKU"]);
    if (!sku) return;

    if (!grouped[sku]) {
      grouped[sku] = {
        sku: sku,
        producto: getAny_(row, ["SKU Name", "Producto", "producto"]),
        sitiosMap: {},
        pedidosMap: {},
        unidades: 0,
        monto: 0
      };
    }

    var seller = getAny_(row, ["Seller Name", "Tienda", "Host"]);
    var order = getAny_(row, ["Order", "Nro Pedido", "nro_pedido_canal"]);
    if (seller) grouped[sku].sitiosMap[seller] = true;
    if (order) grouped[sku].pedidosMap[order] = true;
    grouped[sku].unidades += toNumber_(getAny_(row, ["Quantity_SKU", "Cantidad", "cantidad"])) || 1;
    grouped[sku].monto += toNumber_(getAny_(row, ["SKU Total Price", "Total Value", "Payment Value", "monto"]));
  });

  return Object.keys(grouped).map(function(sku) {
    var item = grouped[sku];
    return {
      sku: item.sku,
      producto: item.producto,
      sitios: Object.keys(item.sitiosMap).join(", "),
      pedidos: Object.keys(item.pedidosMap).length,
      unidades: item.unidades,
      monto: item.monto
    };
  }).sort(function(a, b) {
    return b.pedidos - a.pedidos;
  }).slice(0, limit || SKU_IMPACT_LIMIT);
}

function buildSkuImpactFromSummary_(rows) {
  return rows.map(function(row) {
    return {
      sku: getAny_(row, ["sku", "SKU", "Reference Code"]),
      producto: getAny_(row, ["producto", "Producto", "SKU Name"]),
      sitios: getAny_(row, ["sitios", "Sitios", "Tienda"]),
      pedidos: toNumber_(getAny_(row, ["pedidos", "Pedidos"])),
      unidades: toNumber_(getAny_(row, ["unidades", "Unidades", "Cantidad"])),
      monto: toNumber_(getAny_(row, ["monto", "Monto", "Total Value"]))
    };
  }).filter(function(row) {
    return row.sku;
  }).sort(function(a, b) {
    return b.pedidos - a.pedidos;
  }).slice(0, 200);
}

function buildPimPriceMetrics_(rows) {
  var orderSets = {
    baja: {},
    bajaDiff: {},
    bajaNormal: {},
    conDiff: {},
    factDiff: {},
    expuestoDiff: {}
  };
  var metrics = {
    bajaItems: 0,
    bajaPedidos: 0,
    bajaPorDiferenciaItems: 0,
    bajaPorDiferenciaPedidos: 0,
    bajaNormalItems: 0,
    bajaNormalPedidos: 0,
    itemsConDiferencia: 0,
    pedidosConDiferencia: 0,
    facturadosConDiferenciaItems: 0,
    facturadosConDiferenciaPedidos: 0,
    expuestosConDiferenciaItems: 0,
    expuestosConDiferenciaPedidos: 0,
    importePagadoDiferencia: 0,
    diferenciaTotal: 0,
    perdidaReal: 0
  };

  rows.forEach(function(row) {
    var order = getPimOrder_(row);
    var estado = getPimEstado_(row);
    var diff = getPimPriceDiff_(row);
    var hasDiff = hasPimPriceDiff_(row);
    var baja = isBajaEstado_(estado);
    var facturado = isFacturadoEstado_(estado);

    if (baja) {
      metrics.bajaItems += 1;
      if (order) orderSets.baja[order] = true;
    }

    if (hasDiff) {
      metrics.itemsConDiferencia += 1;
      metrics.importePagadoDiferencia += getPimPaidPrice_(row);
      metrics.diferenciaTotal += diff;
      if (order) orderSets.conDiff[order] = true;

      if (baja) {
        metrics.bajaPorDiferenciaItems += 1;
        if (order) orderSets.bajaDiff[order] = true;
      } else {
        metrics.expuestosConDiferenciaItems += 1;
        metrics.perdidaReal += Math.abs(diff);
        if (order) orderSets.expuestoDiff[order] = true;
      }

      if (facturado) {
        metrics.facturadosConDiferenciaItems += 1;
        if (order) orderSets.factDiff[order] = true;
      }
    } else if (baja) {
      metrics.bajaNormalItems += 1;
      if (order) orderSets.bajaNormal[order] = true;
    }
  });

  metrics.bajaPedidos = Object.keys(orderSets.baja).length;
  metrics.bajaPorDiferenciaPedidos = Object.keys(orderSets.bajaDiff).length;
  metrics.bajaNormalPedidos = Object.keys(orderSets.bajaNormal).length;
  metrics.pedidosConDiferencia = Object.keys(orderSets.conDiff).length;
  metrics.facturadosConDiferenciaPedidos = Object.keys(orderSets.factDiff).length;
  metrics.expuestosConDiferenciaPedidos = Object.keys(orderSets.expuestoDiff).length;
  return metrics;
}

function buildBajasPrioritariasFromPim_(rows) {
  return rows.filter(function(row) {
    return isBajaEstado_(getPimEstado_(row)) || hasPimPriceDiff_(row);
  }).map(function(row) {
    var diff = getPimPriceDiff_(row);
    var estado = getPimEstado_(row);
    var baja = isBajaEstado_(estado);
    var facturado = isFacturadoEstado_(estado);
    var prioridad = facturado ? "Urgente" : Math.abs(diff) >= HIGH_DIFF_THRESHOLD ? "Alta" : baja ? "Media" : "Baja";

    return {
      nro_pedido_canal: getPimOrder_(row),
      sku: getAny_(row, ["sku", "SKU", "Sku", "Reference Code"]),
      producto: getAny_(row, ["producto", "Producto", "SKU Name"]),
      cantidad: toNumber_(getAny_(row, ["cantidad", "Cantidad", "Cant.", "Cant", "Quantity_SKU"])) || 1,
      importe_pagado: getPimPaidPrice_(row),
      precio_actual: getPimCorrectPrice_(row),
      diff: diff,
      estado_envio: estado,
      nro_seguimiento: "",
      prioridad: prioridad,
      despachado: facturado,
      estado_pim: estado,
      tipo_baja: baja && hasPimPriceDiff_(row) ? "Baja por diferencia" : baja ? "Baja normal" : "Diferencia activa"
    };
  }).sort(function(a, b) {
    var order = { Urgente: 0, Alta: 1, Media: 2, Baja: 3 };
    return order[a.prioridad] - order[b.prioridad] || Math.abs(b.diff) - Math.abs(a.diff);
  });
}

function buildCronologia_(rows) {
  return rows.map(function(row) {
    return {
      hora: getAny_(row, ["hora", "Hora"]),
      titulo: getAny_(row, ["titulo", "Titulo", "evento"]),
      descripcion: getAny_(row, ["descripcion", "Descripcion", "detalle"])
    };
  }).filter(function(row) {
    return row.hora || row.titulo || row.descripcion;
  });
}

function getPimOrder_(row) {
  return getAny_(row, ["Nro Pedido", "nro_pedido_canal", "Nro pedido", "Order"]);
}

function getPimEstado_(row) {
  return getAny_(row, ["Estado Actual", "Estado", "estado"]);
}

function getPimPaidPrice_(row) {
  return toNumber_(getAny_(row, ["PrecioWEB", "Precio WEB", "Precio Web", "Imp. Pagado", "Importe Pagado", "importe_pagado"]));
}

function getPimCorrectPrice_(row) {
  return toNumber_(getAny_(row, ["PrecioPIM", "Precio PIM", "Precio Correcto", "precio_actual", "Precio Actual"]));
}

function getPimPriceDiff_(row) {
  var explicit = getAny_(row, ["diff$", "Diff $", "Diff", "diff"]);
  if (explicit !== "") return toNumber_(explicit);
  var paid = getPimPaidPrice_(row);
  var correct = getPimCorrectPrice_(row);
  if (!paid || !correct) return 0;
  return paid - correct;
}

function hasPimPriceDiff_(row) {
  var paid = getPimPaidPrice_(row);
  var correct = getPimCorrectPrice_(row);
  var diff = getPimPriceDiff_(row);
  return paid > 0 && correct > 0 && Math.abs(diff) > 0.01;
}

function isBajaEstado_(estado) {
  return normalizeText_(estado) === "baja";
}

function isFacturadoEstado_(estado) {
  var value = normalizeText_(estado);
  return value === "facturado" || value.indexOf("despach") >= 0;
}

function readSheet_(sheetNames, requiredColumns) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = findSheet_(spreadsheet, sheetNames);
  var result = {
    key: sheetNames[0],
    name: sheet ? sheet.getName() : sheetNames[0],
    found: !!sheet,
    headers: [],
    rows: [],
    missingColumns: requiredColumns ? requiredColumns.slice() : []
  };

  if (!sheet) return result;

  var values = sheet.getDataRange().getDisplayValues();
  if (values.length < 1) return result;

  result.headers = values[0].map(function(header) {
    return String(header || "").trim();
  });
  result.missingColumns = findMissingColumns_(result.headers, requiredColumns || []);

  if (values.length < 2) return result;

  result.rows = values.slice(1).map(function(row) {
    var record = {};
    result.headers.forEach(function(header, index) {
      if (header) record[header] = row[index];
    });
    return record;
  }).filter(function(record) {
    return Object.keys(record).some(function(key) {
      return String(record[key] || "").trim() !== "";
    });
  });

  return result;
}

function findSheet_(spreadsheet, sheetNames) {
  for (var index = 0; index < sheetNames.length; index += 1) {
    var sheet = spreadsheet.getSheetByName(sheetNames[index]);
    if (sheet) return sheet;
  }
  return null;
}

function findMissingColumns_(headers, requiredColumns) {
  var normalizedHeaders = headers.map(normalizeHeader_);
  return requiredColumns.filter(function(column) {
    return normalizedHeaders.indexOf(normalizeHeader_(column)) < 0;
  });
}

// Checks alias groups: marks a column as missing only if NONE of its aliases appear in headers.
function validateAliasColumns_(health, sheetKey, headers, checks) {
  var normalizedHeaders = headers.map(normalizeHeader_);
  var sheetHealth = health.sheets[sheetKey];
  if (!sheetHealth) return;
  checks.forEach(function(check) {
    var found = check.aliases.some(function(alias) {
      return normalizedHeaders.indexOf(normalizeHeader_(alias)) >= 0;
    });
    if (!found) {
      sheetHealth.missingColumns.push(check.label);
      health.status = "warning";
    }
  });
}

function uniqueValues_(rows, fields) {
  var values = {};
  rows.forEach(function(row) {
    var value = getAny_(row, fields);
    if (value) values[value] = true;
  });
  return Object.keys(values);
}

function sumRows_(rows, fields) {
  return rows.reduce(function(total, row) {
    return total + toNumber_(getAny_(row, fields));
  }, 0);
}

function hasDispatch_(row) {
  var seguimiento = getAny_(row, ["nro_seguimiento", "Seguimiento"]);
  var estado = normalizeText_(getAny_(row, ["Estado envio", "estado_envio"]));
  return !!seguimiento || estado === "a" || estado === "d" || estado === "despachado";
}

function getRealHour_(row) {
  var explicit = getAny_(row, ["Hora real", "hora_real", "Hora Real"]);
  if (explicit !== "") return String(explicit);

  var dateValue = getAny_(row, ["fecha_alta", "Fecha Alta", "Creation Date"]);
  if (!dateValue) return "";

  var match = String(dateValue).match(/\s(\d{1,2}):/);
  if (!match) return "";

  return String((Number(match[1]) + 21) % 24);
}

function getAny_(row, fields) {
  for (var index = 0; index < fields.length; index += 1) {
    var exact = fields[index];
    if (row[exact] !== undefined && row[exact] !== null && String(row[exact]).trim() !== "") return String(row[exact]).trim();

    var normalizedField = normalizeHeader_(exact);
    var keys = Object.keys(row);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      var key = keys[keyIndex];
      if (normalizeHeader_(key) === normalizedField && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
        return String(row[key]).trim();
      }
    }
  }
  return "";
}

function getOrderCore_(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  // Strip trailing split-order suffix: -01, -02, etc.
  return text.replace(/-\d{1,2}$/, "");
}

function normalizeStore_(value) {
  var text = String(value || "Sin dato").trim();
  var normalized = normalizeText_(text);
  if (normalized.indexOf("sporting") >= 0) return "Sporting";
  if (normalized.indexOf("woker") >= 0) return "Woker";
  if (normalized.indexOf("adidas") >= 0) return "Adidas Producteca";
  if (normalized.indexOf("b2b") >= 0) return "Ventas B2B";
  return text || "Sin dato";
}

function toNumber_(value) {
  if (value === undefined || value === null || value === "") return 0;
  var text = String(value).trim().replace(/\$/g, "").replace(/\s/g, "");
  if (!text) return 0;

  if (text.indexOf(",") >= 0 && text.indexOf(".") >= 0) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.indexOf(",") >= 0) {
    text = text.replace(",", ".");
  } else if ((text.match(/\./g) || []).length > 1) {
    text = text.replace(/\./g, "");
  }

  var number = Number(text);
  return isFinite(number) ? number : 0;
}

function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText_(value) {
  return normalizeHeader_(value);
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
