# Dashboard incidente PIM

Este proyecto muestra un tablero HTML para analizar el incidente de precio y stock en PIM.

## Archivos

- `index.html`: estructura del tablero.
- `styles.css`: estilos visuales.
- `app.js`: carga de datos, calculos, filtros y renderizado.
- `config.js`: origen de datos y totales esperados.
- `Code.gs`: Apps Script para publicar varias pestanas del Google Sheet como JSON.
- `incidente_dashboard.html`: archivo original de referencia.

## Uso rapido

La version actual consume Apps Script en `config.js`. La API debe devolver datos agregados seguros; no debe publicar filas crudas de VTEX ni datos personales.

Para usar Apps Script:

1. Crear o abrir el Google Sheet.
2. Agregar estas cuatro pestanas base, respetando encabezados en la primera fila:
   - `pedidos_error`
   - `pedidos_pim`
   - `pedidos_vtex`
   - `dar_de_baja`

El Apps Script tambien acepta algunos nombres alternativos del Excel, como `Pedidos con Error`, `Pedidos PIM`, `Pedidos VTEX`, `Vtex Woker`, `Vtex Sporting` y `Dar de baja`.
3. Abrir Extensiones > Apps Script.
4. Pegar el contenido de `Code.gs`.
5. Configurar la clave para la vista protegida:
   - Ir a Configuracion del proyecto > Propiedades del script.
   - Agregar la propiedad `ERROR_TABLE_PASSWORD`.
   - Guardar como valor la clave que usara el equipo para ver "Pedidos con error".
6. Implementar como aplicacion web con acceso de lectura.
7. Copiar la URL de implementacion.
8. En `config.js`, cambiar:

```js
dataMode: "appsScript",
appScriptUrl: "URL_DE_APPS_SCRIPT"
```

## Columnas recomendadas

`pedidos_error`:

- `fecha_alta`
- `nro_pedido_canal`
- `tipo_pago`
- `Hora real`

`pedidos_pim`:

- `Nro Pedido`
- `Tienda`
- `Fecha Alta`
- `Sku`
- `Producto`
- `Cantidad`
- `PrecioPIM`
- `PrecioWEB`
- `Estado Actual`

`pedidos_vtex`:

- `Order`
- `Creation Date`
- `Payment System Name`
- `Quantity_SKU`
- `Reference Code`
- `SKU Name`
- `SKU Selling Price`
- `SKU Total Price`
- `Total Value`
- `Seller Name`
- `Status`

`dar_de_baja`:

- `nro_pedido_canal`
- `sku`
- `producto`
- `cantidad`
- `importe_pagado`
- `precio_actual`
- `diff$`
- `Estado envio`
- `nro_seguimiento`

## Contrato seguro de Apps Script

`Code.gs` devuelve:

- `health`: estado de hojas, conteos, columnas faltantes y cache.
- `summary`: KPIs principales.
- `paymentBreakdown`: pedidos por medio de pago.
- `storeBreakdown`: resumen por tienda.
- `hourlyError`: pedidos con error por hora real.
- `financialImpact`: montos, tickets promedio y diferencias.
- `skuImpact`: ranking SKU calculado sin datos personales.
- `skuAmbosSitios`: SKUs detectados en mas de un sitio.
- `bajasPrioritarias`: columnas operativas seguras para gestionar bajas.

No se exponen emails, telefonos, documentos, direcciones ni nombres de clientes.

### Vista protegida de pedidos con error

La pestana "Pedidos con error" pide una clave antes de mostrar detalle. La clave no debe guardarse en el HTML ni en `config.js`; se valida en Apps Script con `ERROR_TABLE_PASSWORD`.

El endpoint protegido devuelve solo:

- `fecha_alta`
- `nro_pedido_canal`
- `tipo_pago`
- `hora_real`
- `tipo_gestion`
- `sitio`
- `unidades`
- `monto`

Aunque alguien inspeccione el dashboard, no podra recuperar datos personales desde esta vista.

## Hojas opcionales

No son obligatorias para iniciar. Se pueden agregar despues si queremos editar la narrativa sin tocar codigo.

`cronologia`:

- `hora`
- `titulo`
- `descripcion`

`sku_resumen`:

- `sku`
- `producto`
- `sitios`
- `pedidos`
- `unidades`
- `monto`
