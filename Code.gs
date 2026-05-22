const CACHE_KEY = "pim_incident_dashboard_v2";
const CACHE_TTL_SECONDS = 300;
const HIGH_DIFF_THRESHOLD = 100000;

const SHEETS = {
  pedidosError: ["pedidos_error", "Pedidos con Error", "1-Pedidos con Error"],
  pedidosPim: ["pedidos_pim", "Pedidos PIM"],
  pedidosVtex: ["pedidos_vtex", "Pedidos VTEX", "Vtex Woker", "Vtex Sporting"],
  darDeBaja: ["dar_de_baja", "Dar de baja"],
  cronologia: ["cronologia", "Cronologia", "Cronología"],
  skuResumen: ["sku_resumen", "SKU resumen", "2-Análisis por SKU", "2-Analisis por SKU"]
};

const REQUIRED_COLUMNS = {
  pedidosError: ["fecha_alta", "nro_pedido_canal", "tipo_pago", "Hora real"],
  pedidosPim: ["Nro Pedido", "Tienda", "Sku", "Producto", "Cantidad", "Estado Actual"],
  pedidosVtex: ["Order", "Reference Code", "SKU Name", "Quantity_SKU", "Seller Name"],
  darDeBaja: ["nro_pedido_canal", "sku", "producto", "cantidad", "importe_pagado", "precio_actual", "diff$", "Estado envio", "nro_seguimiento"]
};

const MANUAL_PAYMENT_METHODS = ["mercado_pago_pro", "gocuotas"];

function doGet(e) {
  try {
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

function buildPayload_() {
  var pedidosError = readSheet_(SHEETS.pedidosError, REQUIRED_COLUMNS.pedidosError);
  var pedidosPim = readSheet_(SHEETS.pedidosPim, REQUIRED_COLUMNS.pedidosPim);
  var pedidosVtex = readSheet_(SHEETS.pedidosVtex, REQUIRED_COLUMNS.pedidosVtex);
  var darDeBaja = readSheet_(SHEETS.darDeBaja, REQUIRED_COLUMNS.darDeBaja);
  var cronologia = readSheet_(SHEETS.cronologia, []);
  var skuResumen = readSheet_(SHEETS.skuResumen, []);

  var summary = buildSummary_(pedidosError.rows, pedidosPim.rows, pedidosVtex.rows, darDeBaja.rows);
  var health = buildHealth_([pedidosError, pedidosPim, pedidosVtex, darDeBaja]);

  return {
    updatedAt: new Date().toISOString(),
    health: health,
    summary: summary,
    paymentBreakdown: buildPaymentBreakdown_(pedidosError.rows),
    hourlyError: buildHourlyError_(pedidosError.rows),
    skuImpact: skuResumen.rows.length ? buildSkuImpactFromSummary_(skuResumen.rows) : buildSkuImpactFromVtex_(pedidosVtex.rows),
    bajasPrioritarias: buildBajasPrioritarias_(darDeBaja.rows),
    cronologia: buildCronologia_(cronologia.rows)
  };
}

function buildSummary_(pedidosError, pedidosPim, pedidosVtex, darDeBaja) {
  var manual = pedidosError.filter(function(row) {
    return MANUAL_PAYMENT_METHODS.indexOf(normalizeText_(getAny_(row, ["tipo_pago", "Payment System Name", "Medio de Pago"]))) >= 0;
  }).length;
  var despachados = darDeBaja.filter(hasDispatch_).length;
  var pedidoPimIds = uniqueValues_(pedidosPim, ["Nro Pedido", "nro_pedido_canal", "Nro pedido"]);
  var pedidoVtexIds = uniqueValues_(pedidosVtex, ["Order", "Nro Pedido", "nro_pedido_canal"]);
  var bajaPedidoIds = uniqueValues_(darDeBaja, ["nro_pedido_canal", "Nro Pedido", "pedido"]);

  return {
    pedidosError: pedidosError.length,
    gestionManual: manual,
    gestionAutomatica: Math.max(0, pedidosError.length - manual),
    pedidosPimItems: pedidosPim.length,
    pedidosPimUnicos: pedidoPimIds.length,
    pedidosVtexItems: pedidosVtex.length,
    pedidosVtexUnicos: pedidoVtexIds.length,
    bajaItems: darDeBaja.length,
    bajaPedidos: bajaPedidoIds.length,
    despachados: despachados,
    importePagado: sumRows_(darDeBaja, ["importe_pagado", "Importe Pagado", "pagado"]),
    diferenciaTotal: sumRows_(darDeBaja, ["diff$", "Diff", "diff"])
  };
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

function buildPaymentBreakdown_(rows) {
  var groups = {};
  rows.forEach(function(row) {
    var payment = getAny_(row, ["tipo_pago", "Payment System Name", "Medio de Pago"]) || "Sin dato";
    var key = String(payment);
    if (!groups[key]) {
      groups[key] = {
        tipo: key,
        pedidos: 0,
        gestion: MANUAL_PAYMENT_METHODS.indexOf(normalizeText_(key)) >= 0 ? "Manual" : "Automatica"
      };
    }
    groups[key].pedidos += 1;
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

function buildSkuImpactFromVtex_(rows) {
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
  }).slice(0, 200);
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

function buildBajasPrioritarias_(rows) {
  return rows.map(function(row) {
    var diff = toNumber_(getAny_(row, ["diff$", "Diff", "diff"]));
    var estadoEnvio = getAny_(row, ["Estado envio", "estado_envio"]);
    var seguimiento = getAny_(row, ["nro_seguimiento", "Seguimiento"]);
    var despachado = hasDispatch_(row);
    var prioridad = despachado ? "Urgente" : Math.abs(diff) >= HIGH_DIFF_THRESHOLD ? "Alta" : "Media";

    return {
      nro_pedido_canal: getAny_(row, ["nro_pedido_canal", "Nro Pedido"]),
      sku: getAny_(row, ["sku", "SKU"]),
      producto: getAny_(row, ["producto", "Producto"]),
      cantidad: toNumber_(getAny_(row, ["cantidad", "Cantidad"])),
      importe_pagado: toNumber_(getAny_(row, ["importe_pagado", "Importe Pagado"])),
      precio_actual: toNumber_(getAny_(row, ["precio_actual", "Precio Actual"])),
      diff: diff,
      estado_envio: estadoEnvio,
      nro_seguimiento: seguimiento,
      prioridad: prioridad,
      despachado: despachado
    };
  }).sort(function(a, b) {
    var order = { Urgente: 0, Alta: 1, Media: 2 };
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

function toNumber_(value) {
  if (value === undefined || value === null || value === "") return 0;
  var text = String(value).trim().replace(/\$/g, "").replace(/\s/g, "");
  if (!text) return 0;

  if (text.indexOf(",") >= 0 && text.indexOf(".") >= 0) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.indexOf(",") >= 0) {
    text = text.replace(",", ".");
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
