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

La version actual consume el CSV publicado en `config.js`.

Para usar Apps Script:

1. Crear o abrir el Google Sheet.
2. Agregar estas pestanas, respetando encabezados en la primera fila:
   - `pedidos_error`
   - `pedidos_pim`
   - `dar_de_baja`
   - `cronologia`
   - `sku_resumen`

El Apps Script tambien acepta algunos nombres alternativos del Excel, como `Pedidos con Error`, `Pedidos PIM` y `Dar de baja`.
3. Abrir Extensiones > Apps Script.
4. Pegar el contenido de `Code.gs`.
5. Implementar como aplicacion web con acceso de lectura.
6. Copiar la URL de implementacion.
7. En `config.js`, cambiar:

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
