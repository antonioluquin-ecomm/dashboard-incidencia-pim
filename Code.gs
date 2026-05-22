const SHEETS = {
  pedidosError: ["pedidos_error", "Pedidos con Error", "1-Pedidos con Error"],
  pedidosPim: ["pedidos_pim", "Pedidos PIM"],
  pedidosVtex: ["pedidos_vtex", "Pedidos VTEX", "Vtex Woker", "Vtex Sporting"],
  darDeBaja: ["dar_de_baja", "Dar de baja"],
  cronologia: ["cronologia", "Cronologia", "Cronología"],
  skuResumen: ["sku_resumen", "SKU resumen", "2-Análisis por SKU", "2-Analisis por SKU"]
};

function doGet() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      pedidosError: readSheet_(SHEETS.pedidosError),
      pedidosPim: readSheet_(SHEETS.pedidosPim),
      pedidosVtex: readSheet_(SHEETS.pedidosVtex),
      darDeBaja: readSheet_(SHEETS.darDeBaja),
      cronologia: readSheet_(SHEETS.cronologia),
      skuResumen: readSheet_(SHEETS.skuResumen)
    };

    return json_(payload);
  } catch (error) {
    return json_({ error: error.message });
  }
}

function readSheet_(sheetNames) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = findSheet_(spreadsheet, sheetNames);
  if (!sheet) return [];

  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0].map(function(header) {
    return String(header || "").trim();
  });

  return values.slice(1).map(function(row) {
    const record = {};
    headers.forEach(function(header, index) {
      if (header) record[header] = row[index];
    });
    return record;
  }).filter(function(record) {
    return Object.keys(record).some(function(key) {
      return String(record[key] || "").trim() !== "";
    });
  });
}

function findSheet_(spreadsheet, sheetNames) {
  for (var index = 0; index < sheetNames.length; index += 1) {
    var sheet = spreadsheet.getSheetByName(sheetNames[index]);
    if (sheet) return sheet;
  }
  return null;
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
