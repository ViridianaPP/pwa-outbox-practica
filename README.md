# PWA Outbox - Práctica (Temas 5.1, 5.2 y 5.3)

Aplicación PWA que implementa persistencia local con **IndexedDB**, el **patrón Outbox** (CRUD offline) y **Background Sync API** con comunicación `postMessage` y degradación elegante.

## Restricciones cumplidas
- 100% JavaScript Vanilla (sin librerías externas).
- Sin `async/await`: asincronía con `new Promise()`, `.then()`, `.catch()` y `Promise.all()`.
- Rutas relativas (`./`) para despliegue en GitHub Pages (subdirectorio).

## Estructura
- `index.html` – Interfaz (formulario y bandeja de salida).
- `styles.css` – Estilos.
- `db-helper.js` – Mini-wrapper promisificado de IndexedDB (abrir, guardar, leer, actualizar, eliminar).
- `app.js` – Lógica de UI, envío resiliente (Outbox), fallback por `online`, escucha `postMessage`.
- `sw.js` – Service Worker: App Shell (cache), `importScripts` del helper, evento `sync`, `postMessage`.
- `manifest.json` – Manifiesto PWA.

## Temas cubiertos
- **5.1:** `indexedDB.open`, `onupgradeneeded`, transacciones `readonly/readwrite`, `tx.oncomplete`, promisificación.
- **5.2:** Patrón Outbox (CREATE pendiente/sincronizado, READ, UPDATE de estado, DELETE/purga), evento `online`, `Promise.all`.
- **5.3:** Background Sync (`sync-reportes`) en `sw.js`, `event.waitUntil`, `self.clients` + `postMessage`, fallback si no hay `SyncManager`.

## Probar
1. Abrir la app (GitHub Pages o servidor local).
2. DevTools → Application: verificar Service Worker y IndexedDB.
3. DevTools → Network: modo Offline, enviar reportes, ver pendientes en IndexedDB.
4. Volver Online (o cerrar pestaña y reabrir) y verificar sincronización.
