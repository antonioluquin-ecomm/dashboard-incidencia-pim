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
| **Resumen** | Panel compacto del incidente + KPIs divididos en "Acción requerida" y "Volumen" + gráficos de medio de pago y pico horario + resumen por tienda + estado de datos (al fondo) |
| **Pedidos con error** | Tabla protegida con contraseña — 2,266 pedidos rechazados |
| **Cronología** | 18 eventos del 21–22 mayo clasificados por tipo (Detección / Acción / Escalado / Resolución) con colores |
| **SKU** | Ranking de productos afectados con buscador |
| **PIM y bajas** | Pedidos que ingresaron a PIM, tabla de bajas con diferencia de precio |

### Métricas clave hardcodeadas en `config.js`

```js
expectedTotals: {
  pedidosError: 2266,
  pedidosPimItems: 2390,
  pedidosPimUnicos: 1394,
  bajaItems: 55,
  bajaPedidos: 36
}
manualPaymentMethods: ["mercado_pago_pro", "gocuotas"]
```

Estos valores se usan como fallback cuando la API no devuelve datos.

---

## Decisiones técnicas tomadas

### Seguridad
- La tabla de "Pedidos con error" requiere contraseña operativa.
- La contraseña se valida en Apps Script (`ERROR_TABLE_PASSWORD` como propiedad de script), **nunca en el HTML ni en `config.js`**.
- Máximo 5 intentos fallidos → bloqueo de 5 minutos (localStorage).
- El endpoint protegido devuelve solo 8 campos operativos, sin emails ni documentos.

### Normalización de datos
- `app.js` tiene un `FIELDS` constant implícito en `getValue()` que acepta múltiples nombres de columna para el mismo campo (soporta variantes del Excel original y del Google Sheet).
- Las tiendas se normalizan con `normalizeStore()`: acepta variantes de "sporting", "woker", "b2b", "adidas".
- Los montos soportan formato argentino (punto como separador de miles, coma como decimal).

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
- Las filas "urgentes" en la tabla de bajas son las que `isDispatch()` devuelve `true` (tienen nro de seguimiento o estado facturado/despachado).

---

## Historial de cambios relevantes

| Commit | Cambio |
|---|---|
| `02eb109` | Auditoría de claridad: panel compacto, KPIs de 24 a 10, timeline con tipos, diff en rojo, búsqueda SKU |
| `c990f9a` | Timeline y resumen ejecutivo actualizados con datos del incidente real |
| `9af3b3b` | Exportar CSV para pedidos-error y bajas-prioritarias |
| `ad3aae8` | Filtros bookmarkeables vía URL hash |
| `4295918` | Centralizar aliases de campos en constante FIELDS |
| Anterior | Mejora de mensajes de error de carga con guías accionables |

---

## Zonas críticas — no modificar sin auditoría

- `Code.gs` — lógica del Apps Script, contrato JSON, validación de contraseña
- `config.js` — URLs y totales esperados
- `isDispatch()` en `app.js` — determina qué filas son "urgentes"; afecta prioridad y badge rojo
- `normalizeText()` / `getValue()` — columna flexible; cambios pueden romper mapeo de datos

---

## Pendientes conocidos / próximos pasos posibles

- [ ] Filtro por tienda (Sporting / Woker) en tab SKU y tab Errores
- [ ] Indicador de "incidente cerrado" configurable desde `config.js`
- [ ] Exportar resumen ejecutivo completo (o PDF)
- [ ] Agregar tab o sección de "acciones tomadas" con estado en tiempo real (requiere hoja `acciones` en Google Sheets)
- [ ] Test de conectividad al arrancar con mensaje más claro si Apps Script está caído

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
- `Add CSV export for pedidos-error and bajas-prioritarias tables`
- `Audit dashboard: improve clarity, reduce noise, add visual hierarchy`
- `Add bookmarkable filters via URL hash`
