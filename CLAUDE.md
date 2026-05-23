# CLAUDE.md — Contexto del proyecto para IA

Este archivo se carga automáticamente al abrir el proyecto con Claude Code.
Su propósito es que cualquier IA pueda entender el proyecto, sus decisiones y su estado sin necesidad de re-explicar desde cero.

---

## Qué es este proyecto

Dashboard HTML estático para analizar un incidente de precios y stock en PIM (Product Information Management) que afectó las tiendas **Sporting** y **Woker** el 21–22 de mayo de 2026.

El dashboard consume datos de un Google Apps Script que devuelve agregados JSON seguros (sin datos personales). Se abre directamente como archivo HTML o se sirve con un servidor estático simple.

**No es una app React ni tiene build step.** Es HTML + CSS + JS puro.

---

## Causa del incidente (contexto)

Credenciales de API de **producción** quedaron configuradas en ambiente QA durante el desarrollo del proyecto de multidepósitos. Al actualizar precio y stock, se enviaron datos ficticios a Sporting y Woker. Impactó ~3,660 pedidos (2,266 rechazados + 1,394 en PIM). Fue contenido el 22-05 con cancelación automática masiva y reactivación de depósitos.

---

## Archivos del proyecto

| Archivo | Rol |
|---|---|
| `index.html` | Estructura del dashboard (5 tabs) |
| `styles.css` | Estilos — tema dark, variables CSS |
| `app.js` | Toda la lógica: fetch, cálculos, render, filtros |
| `config.js` | URL de Apps Script, modo de datos, totales esperados |
| `Code.gs` | Apps Script (Google Sheets) — publica JSON seguro |
| `incidente_dashboard.html` | Versión original de referencia — NO modificar |
| `README.md` | Setup técnico (cómo conectar Google Sheets) |
| `PROJECT_WORKFLOW.md` | Metodología general de trabajo con IA — NO es de este proyecto |

---

## Arquitectura de datos

```
Google Sheets
  └── pedidos_error    → rechazados, no entraron a PIM
  └── pedidos_pim      → entraron a PIM (items con estado)
  └── pedidos_vtex     → detalle VTEX (SKU, precio, tienda)
  └── cronologia       → opcional, eventos del incidente
  └── sku_resumen      → opcional, ranking pre-calculado

Code.gs (Apps Script)
  └── GET /            → JSON agregado seguro (summary, KPIs, breakdowns)
  └── GET /?view=pedidos_error&password=X → detalle saneado (protegido)

index.html + app.js
  └── Fetch → applyPayload → renderAll
  └── Fallback CSV si Apps Script no está configurado
```

El contrato seguro de Apps Script devuelve: `summary`, `health`, `paymentBreakdown`, `storeBreakdown`, `hourlyError`, `financialImpact`, `skuImpact`, `bajasPrioritarias`, `cronologia`. **Nunca devuelve datos personales.**

---

## Estado actual del dashboard (mayo 2026)

### Tabs y su contenido

| Tab | Qué muestra |
|---|---|
| **Resumen** | Contexto del incidente + flujo de pedidos (rechazados vs PIM) + dos cards de impacto económico + gráficos de medio de pago y pico horario + resumen por tienda + estado de datos |
| **Pedidos con error** | Tabla protegida con contraseña — 2,266 pedidos rechazados |
| **Cronología** | 19 eventos del 21–22 mayo clasificados por tipo (Detección / Acción / Escalado / Resolución) con colores |
| **SKU** | Ranking de productos afectados con buscador |
| **PIM y bajas** | Pedidos que ingresaron a PIM, tabla de bajas con diferencia de precio |

### Tab Resumen — estructura detallada

El Resumen está organizado en capas narrativas, no en KPIs sueltos:

1. **Contexto del incidente** — 1 párrafo explicando qué pasó, con los totales clave en negrita.
2. **Flujo de pedidos** (`renderOrderFlow`) — barra de totales con proporción visual, dos buckets lado a lado:
   - *Rechazados* (rojo): no llegaron a PIM por falta de stock. Breakdown: automático + manual (620 MP/GoCuotas).
   - *Procesados en PIM* (azul): tenían stock. Breakdown: sin error de precio / dados de baja / facturados con error.
3. **Impacto económico** (`renderFinancialImpactSection`) — dos cards:
   - *Card 1 — Pérdida real confirmada*: pedidos facturados con precio incorrecto × diferencia.
   - *Card 2 — Riesgo de compensación (supuesto)*: si los 2,266 clientes reclamaran compensación con el producto al precio correcto, cuánto costaría. Ticket correcto ($135K) − ticket error ($45K) × pedidos rechazados.
4. **Gráficos**: medios de pago y pico horario.
5. **Resumen por tienda** y **Estado de datos** al fondo.

### Métricas clave hardcodeadas en `config.js`

```js
expectedTotals: {
  pedidosError: 2266,
  pedidosPimItems: 2390,
  pedidosPimUnicos: 1394,
  bajaItems: 55,
  bajaPedidos: 36
}
referenceMetrics: {
  ticketPromedioActual: 135000  // solo usado en modo CSV; en appsScript viene de la API
}
manualPaymentMethods: ["mercado_pago_pro", "gocuotas"]
```

Estos valores se usan como fallback cuando la API no devuelve datos.

---

## Decisiones técnicas tomadas

### Columna "Error Precio" — fuente de verdad para pedidos del incidente

La hoja `pedidos_pim` tiene una columna `Error Precio` con valor `"Si"` en los ítems que **efectivamente salieron con precio incorrecto por el incidente**. Solo esos se consideran como "facturados con diferencia" y se usan para calcular `perdidaReal`, `facturadosConDiferenciaPedidos` y la prioridad "Urgente" en la tabla de bajas.

**Por qué:** antes se calculaba la diferencia comparando `PrecioWEB != PrecioPIM`, pero eso incluía pedidos con descuentos, cupones y otras razones válidas de diferencia de precio. La columna `Error Precio` es la fuente de verdad manual revisada por el equipo.

**Comportamiento cuando la columna no existe en el sheet:**
`hasErrorPrecioColumnInRows_()` detecta si la columna está presente como header en las filas. Si no está, `buildPimPriceMetrics_()` y `buildBajasPrioritariasFromPim_()` hacen fallback a `hasPimPriceDiff_()` (comportamiento original). Esto evita que `perdidaReal` muestre `$0` y que pedidos `facturado` sean bajados de prioridad `Urgente` cuando la columna simplemente no fue agregada todavía al sheet.

| Escenario | Comportamiento |
|---|---|
| Columna ausente del sheet | Fallback a `hasPimPriceDiff_()` — comportamiento pre-incidente |
| Columna presente, bien anotada | Usa `hasErrorPrecio_()` — fuente de verdad exacta |
| Columna presente pero incompleta | Usa `hasErrorPrecio_()` — filas sin 'Si' se excluyen; el equipo debe completar la anotación |

El summary expone `errorPrecioColumnPresente: true/false` para que el frontend pueda mostrar un aviso si hace falta.

Aliases reconocidos: `"Error Precio"`, `"error_precio"`, `"Error precio"`, `"ErrorPrecio"`.

### Pedidos rechazados — causa del rechazo

Los pedidos pasan a error **por falta de stock**, no por precio incorrecto. Los que sí tenían stock ingresaron a PIM (aunque con precio incorrecto). Esto es relevante para los textos del dashboard: no decir "el sistema los rechazó por precio inválido".

### Seguridad
- La tabla de "Pedidos con error" requiere contraseña operativa.
- La contraseña se valida en Apps Script (`ERROR_TABLE_PASSWORD` como propiedad de script), **nunca en el HTML ni en `config.js`**.
- Máximo 5 intentos fallidos → bloqueo de 5 minutos (localStorage).
- El endpoint protegido devuelve solo 8 campos operativos, sin emails ni documentos.

### Normalización de datos
- `app.js` tiene un `FIELDS` constant que acepta múltiples nombres de columna para el mismo campo (soporta variantes del Excel original y del Google Sheet).
- Las tiendas se normalizan con `normalizeStore()`: acepta variantes de "sporting", "woker", "b2b", "adidas".
- Los montos soportan formato argentino (punto como separador de miles, coma como decimal).

### Cálculo de `pimSinError` — fuentes homogéneas

`pimSinError = pedidosPim - bajaPedidos - facturadosDiff` solo se calcula si `pedidosPim` y `bajaPedidos` vienen de la **misma fuente** (ambos live desde la API, o ambos desde `expectedTotals`). Si hay mezcla (uno live, el otro fallback), se muestra `—` en lugar de un número fabricado. El flag se detecta comparando si los campos están presentes en el objeto `summary` de la API.

### `ticketActual` — null-check explícito

Se usa `!= null` en lugar de `||` para el fallback de `ticketPromedioActual`. Esto evita que un valor `0` legítimo de la API sea tratado como falsy y reemplazado por el `135000` del config.

### URL hash / bookmarks
- Los filtros activos se serializan en el hash de la URL (`#tab=errores&es=búsqueda`).
- Permite compartir vistas filtradas directamente.

### Modo de datos
- `config.js` tiene `dataMode: "appsScript"` (principal) o `"csv"` (fallback).
- En modo CSV, solo carga `pedidos_error` y calcula todo localmente (menos datos disponibles).

---

## Convenciones del código

- Todo en un único IIFE en `app.js` — sin módulos, sin bundler.
- Funciones de render: `renderNombreCosa()` — cada una escribe en su `#id` en el HTML.
- Helpers: `fmt()` (número), `fmtMoney()` ($ + número), `escapeHtml()`, `normalizeText()`.
- Clasificación de eventos del timeline: `classifyTimelineEvent(titulo, descripcion)` — detecta tipo por palabras clave normalizadas.
- Las filas "urgentes" en la tabla de bajas son las que tienen `prioridad = "Urgente"` (calculado en `Code.gs`) o `isDispatch()` devuelve `true` en el fallback CSV.

---

## Historial de cambios relevantes

| Commit | Cambio |
|---|---|
| `73510b8` | Fix descripciones flujo rechazados/PIM; card 2 renombrada a "Riesgo de compensación" |
| `86a79cd` | Rediseño completo tab Resumen: flujo de pedidos + cards de impacto económico |
| `ca83ea1` | Cronología: evento 22-05 17:00 (620 reembolsos manuales completados), alineado en evento 09:30 |
| `053fa66` | Columna "Error Precio" como fuente de verdad; `hasErrorPrecioColumnInRows_()` con fallback |
| `02eb109` | Auditoría de claridad: timeline con tipos, diff en rojo, búsqueda SKU |
| `c990f9a` | Timeline y resumen ejecutivo actualizados con datos del incidente real |
| `9af3b3b` | Exportar CSV para pedidos-error y bajas-prioritarias |
| `ad3aae8` | Filtros bookmarkeables vía URL hash |
| `4295918` | Centralizar aliases de campos en constante FIELDS |

---

## Zonas críticas — no modificar sin auditoría

- `Code.gs` — lógica del Apps Script, contrato JSON, validación de contraseña
- `config.js` — URLs y totales esperados
- `hasErrorPrecioColumnInRows_()` en `Code.gs` — determina si se usa la columna o el fallback; afecta `perdidaReal`, prioridades y conteos de diferencia
- `isDispatch()` en `app.js` — determina qué filas son "urgentes" en modo CSV; afecta prioridad y badge rojo
- `normalizeText()` / `getValue()` — columna flexible; cambios pueden romper mapeo de datos
- `renderOrderFlow()` / `renderFinancialImpactSection()` en `app.js` — lógica del Resumen; tienen dependencias cruzadas con `state.summary` y `state.financialImpact`

---

## Pendientes conocidos / próximos pasos posibles

- [ ] Filtro por tienda (Sporting / Woker) en tab SKU y tab Errores
- [ ] Indicador de "incidente cerrado" configurable desde `config.js`
- [ ] Exportar resumen ejecutivo completo (o PDF)
- [ ] Agregar tab o sección de "acciones tomadas" con estado en tiempo real (requiere hoja `acciones` en Google Sheets)
- [ ] Test de conectividad al arrancar con mensaje más claro si Apps Script está caído
- [ ] Mostrar aviso en el dashboard cuando `errorPrecioColumnPresente = false` (la columna no existe en el sheet)

---

## Cómo correr el proyecto localmente

```powershell
npx serve -l 3000 .
# Abrir http://localhost:3000
```

O simplemente abrir `index.html` en el navegador (algunos browsers bloquean fetch local; usar servidor).

Para que los datos carguen, configurar en `config.js`:
```js
dataMode: "appsScript",
appScriptUrl: "URL_DEL_DEPLOY"
```

Sin URL configurada, el dashboard muestra los `expectedTotals` hardcodeados y gráficos vacíos.

---

## Convención de commits

Mensajes en inglés, descriptivos. Ejemplos del historial:
- `Fix: fallback to hasPimPriceDiff_ when Error Precio column is absent`
- `Redesign Resumen tab: order flow + financial impact cards`
- `Add bookmarkable filters via URL hash`
