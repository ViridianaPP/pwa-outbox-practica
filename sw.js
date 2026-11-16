/*
  sw.js (Service Worker)
  ------------------------------------------------------------
  Corre en un HILO separado (segundo plano). No tiene acceso al DOM:
  no existen window, document, ni funciones de app.js como renderizarColaOutbox().

  Responsabilidades:
  - (Tema 5.2) Cachear el "App Shell" con rutas relativas para GitHub Pages.
  - (Tema 5.3) Sincronizar la cola Outbox cuando vuelve la red, incluso si
    la pestaña está cerrada (Background Sync API), y avisar a la UI con postMessage.

  REGLAS: Vanilla JS, sin async/await, promesas con .then/.catch/Promise.all.
*/

// Tema 5.3: importar el mini-wrapper de IndexedDB en el contexto del SW.
// importScripts carga scripts de forma síncrona en el worker.
// Ruta relativa './' para que funcione dentro del subdirectorio de GitHub Pages.
importScripts('./db-helper.js');

// v2 para forzar actualización del Service Worker al subir cambios (Tema 5.3)
var CACHE_STATIC_NAME = 'static-outbox-v2';

// App Shell: archivos mínimos para que la app abra offline.
// Incluimos db-helper.js porque la app lo necesita para leer/escribir IndexedDB.
var STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json'
];

// -----------------------------
// INSTALL: precachear el App Shell
// waitUntil espera a que la promesa termine antes de marcar la instalación como exitosa.
// -----------------------------
self.addEventListener('install', function (event) {
  console.log('[SW] Instalando y cacheando App Shell...');
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME).then(function (cache) {
      return cache.addAll(STATIC_FILES);
    })
  );
});

// -----------------------------
// ACTIVATE: limpiar cachés viejas
// Así evitamos que el navegador siga usando archivos de versiones anteriores.
// -----------------------------
self.addEventListener('activate', function (event) {
  console.log('[SW] Activando y limpiando cachés antiguas...');
  event.waitUntil(
    caches.keys().then(function (keys) {
      var promesas = keys.map(function (key) {
        if (key !== CACHE_STATIC_NAME) {
          return caches.delete(key);
        }
      });
      return Promise.all(promesas);
    })
  );
});

// -----------------------------
// FETCH: estrategia "Cache First" simple para el App Shell
// - Si el recurso está en caché, lo devolvemos.
// - Si no, intentamos la red.
// (Las peticiones POST a la API no se cachean aquí; las maneja app.js/Outbox)
// -----------------------------
self.addEventListener('fetch', function (event) {
  // Solo manejamos GET; dejamos pasar otros métodos (POST, etc.)
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(event.request);
    })
  );
});

// -----------------------------
// Tema 5.3: notificar a las pestañas abiertas que ya se sincronizó.
// El SW no puede tocar el DOM, así que envía un mensaje y app.js lo escucha.
// -----------------------------
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientes) {
      clientes.forEach(function (cliente) {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

// -----------------------------
// Tema 5.3: motor de sincronización en segundo plano (dentro del SW)
// - Lee registros de IndexedDB (gracias a importScripts del db-helper).
// - Filtra los 'pendiente'.
// - Reenvía cada uno con fetch (POST) y los marca 'sincronizado'.
// - Promise.all espera a que TODOS terminen.
// - Al final notifica a la UI con postMessage.
// IMPORTANTE: devolvemos toda la cadena de promesas para que event.waitUntil
// sepa cuándo terminó el trabajo.
// -----------------------------
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then(function (registros) {
      var pendientes = registros.filter(function (item) {
        return item.estado === 'pendiente';
      });

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      var promesasDeEnvio = pendientes.map(function (item) {
        return fetch('https://jsonplaceholder.typicode.com/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        })
          .then(function (respuesta) {
            if (!respuesta.ok) {
              throw new Error('Error HTTP ' + respuesta.status + ' al sincronizar ID ' + item.id);
            }
            // UPDATE: marcar como sincronizado en IndexedDB
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio)
        .then(function () {
          return notificarClientesActualizacion();
        });
    });
}

// -----------------------------
// Tema 5.3: evento 'sync' (Background Sync API)
// - El navegador dispara este evento cuando detecta conectividad estable,
//   incluso si la pestaña se cerró después de registrar la etiqueta.
// - event.tag identifica qué tarea es ('sync-reportes').
// - event.waitUntil: le dice al navegador "mantén vivo el SW hasta que
//   esta promesa termine".
// - Si relanzamos el error (throw), el navegador entiende que falló y
//   programará un reintento automático más tarde.
// -----------------------------
self.addEventListener('sync', function (event) {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW()
        .catch(function (error) {
          console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
          // Relanzar el error -> el navegador reintentará el sync automáticamente
          throw error;
        })
    );
  }
});
