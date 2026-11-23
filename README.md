# Simulador de inventario — Bachué (Girardot)

Simulador interactivo (Monte Carlo) del modelo de inventario (Q,R) de un punto de venta de proteínas en Girardot, Cundinamarca. Proyecto académico.

Es una página estática (HTML/CSS/JS puro, sin frameworks ni backend) que reproduce en el navegador la misma simulación hecha en Python para poder mover parámetros en vivo durante la sustentación.

**Demo en vivo:** se publica con GitHub Pages desde este mismo repositorio.

## Correrlo en local

No requiere instalación. Solo necesita un servidor estático porque el navegador bloquea `fetch()` sobre `file://`:

```
python -m http.server 8000
```

y abrir `http://localhost:8000`.

## Qué contiene

- `index.html` / `css/` / `js/app.js`: el simulador.
- `data/datos_front.json`: parámetros y datos agregados (ventas diarias reales 2025, tablas de muestreo, menú) que alimentan la simulación. Son datos derivados/agregados para la demo, no las hojas originales de la empresa.

## Nota

Este repo contiene solo la parte web, pensada para que cualquiera con el link pueda abrir y probar el simulador. El análisis completo (Fases 1-5 en Python, Excel original de la empresa) vive en un repositorio privado separado.
