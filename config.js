window.PIM_INCIDENT_CONFIG = {
  dataMode: "appsScript",
  csvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRRg0yx7VtbM_hKnvETRpa3FgE81WKoxbyD68X19_fx_0G6IpywZ6pC_tVxfaST1GlWHiSzD-zlpotW/pub?output=csv",
  appScriptUrl: "https://script.google.com/macros/s/AKfycbyR1tDcfjmpAyeUxWGMfl-B0EETo97udiqkYRXM4xEazW296w75AVtVFjIeESH5iJE/exec",
  expectedTotals: {
    pedidosError: 2266,
    pedidosPimItems: 2390,
    pedidosPimUnicos: 1394,
    bajaItems: 55,
    bajaPedidos: 36
  },
  // Solo usado en modo CSV. En modo appsScript el valor viene de la API (REFERENCE_TICKET_ACTUAL en Code.gs).
  referenceMetrics: {
    ticketPromedioActual: 135000
  },
  manualPaymentMethods: ["mercado_pago_pro", "gocuotas"]
};
