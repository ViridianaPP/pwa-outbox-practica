/*
  app.js (Hilo Principal / UI)
  ------------------------------------------------------------
  Aquí vive la lógica de la interfaz y el flujo "Outbox":
  - CREATE: guardar reporte (sincronizado si hay red, pendiente si falla)
  - READ:   listar la cola desde IndexedDB
  - UPDATE: reenviar pendientes y marcarlos como sincronizados
  - DELETE: purgar los ya sincronizados

  NOTA: usa las funciones de db-helper.js (cargado antes en index.html).

  Tema 5.3 añade:
  - Registrar etiqueta Background Sync ('sync-reportes') al encolar
  - Escuchar postMessage del Service Worker para repintar la UI
  - Degradación elegante: evento 'online' solo como fallback si NO hay SyncManager
*/

// -----------------------------
// Utilidades de interfaz
// -----------------------------
function actualizarIndicadorRed() {
  var badge = document.getElementById('badge-red');
  if (!badge) return;

  if (navigator.onLine) {
    badge.textContent = 'En Línea';
    badge.classList.remove('offline');
    badge.classList.add('online');
  } else {
    badge.textContent = 'Sin Conexión';
    badge.classList.remove('online');
    badge.classList.add('offline');
  }
}

// Formatea un timestamp (ms) a una hora/fecha legible
function formatearFecha(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

// -----------------------------
// READ: renderizarColaOutbox()
// - Lee TODOS los registros de IndexedDB y los pinta en <ul id="lista-outbox">
// - Se llama al cargar la página y después de cada operación (create/update/delete)
// -----------------------------
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then(function (registros) {
      var lista = document.getElementById('lista-outbox');
      lista.innerHTML = '';

      if (!registros || registros.length === 0) {
        var vacio = document.createElement('li');
        vacio.textContent = 'No hay registros en la bandeja.';
        lista.appendChild(vacio);
        return;
      }

      // Mostrar más recientes primero
      registros.sort(function (a, b) {
        return (b.fechaCreacion || 0) - (a.fechaCreacion || 0);
      });

      registros.forEach(function (item) {
        var li = document.createElement('li');

        var izquierda = document.createElement('div');
        var titulo = document.createElement('div');
        titulo.textContent = item.titulo || '(sin título)';
        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = formatearFecha(item.fechaCreacion);
        izquierda.appendChild(titulo);
        izquierda.appendChild(meta);

        var estado = document.createElement('span');
        estado.className = 'estado ' + (item.estado || '');
        estado.textContent = item.estado || 'desconocido';

        li.appendChild(izquierda);
        li.appendChild(estado);
        lista.appendChild(li);
      });
    })
    .catch(function (error) {
      console.error('[UI] Error al leer la bandeja:', error);
    });
}

// -----------------------------
// CREATE: procesarEnvioReporte(datosFormulario)
// Patrón Outbox:
// 1) Intentar enviar el POST al servidor con fetch()
// 2) Si funciona -> guardar en IndexedDB como 'sincronizado' (bitácora local)
// 3) Si falla (sin red) -> .catch() guarda en IndexedDB como 'pendiente'
// 4) Si es pendiente y hay SyncManager -> registrar etiqueta 'sync-reportes'
//    para que el Service Worker lo envíe en segundo plano (incluso con pestaña cerrada)
// 5) Al final -> repintar la cola
// -----------------------------
function procesarEnvioReporte(datosFormulario) {
  var endpoint = 'https://jsonplaceholder.typicode.com/posts';

  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datosFormulario)
  })
    .then(function (respuesta) {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(function () {
      // Éxito en vivo: guardamos una copia local como ya sincronizada
      return guardarRegistro({
        titulo: datosFormulario.titulo,
        descripcion: datosFormulario.descripcion,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(function () {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      // Falla de red: guardamos como 'pendiente' para reintentar después
      return guardarRegistro({
        titulo: datosFormulario.titulo,
        descripcion: datosFormulario.descripcion,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(function () {
          // Tema 5.3: si el navegador soporta Background Sync, delegamos
          // el reenvío al Service Worker registrando una etiqueta (tag).
          // El SW escuchará el evento 'sync' con tag 'sync-reportes'.
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready.then(function (registro) {
              console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
              return registro.sync.register('sync-reportes');
            });
          }
          // Si no hay SyncManager (Safari/iOS), el fallback del evento 'online'
          // se encargará de sincronizar (ver más abajo).
        });
    })
    .then(function () {
      // Actualizar la lista visual en ambos escenarios (éxito o pendiente)
      return renderizarColaOutbox();
    });
}

// -----------------------------
// UPDATE (fallback): sincronizarPendientesFallback()
// - Se usa SOLO en navegadores SIN SyncManager (ej. Safari/iOS).
// - Lee todos los registros, filtra los 'pendiente', los envía con fetch
//   y actualiza su estado a 'sincronizado' en IndexedDB.
// - Promise.all: convierte cada pendiente en una promesa de (envío + update)
//   y espera a que TODAS terminen antes de repintar.
// -----------------------------
function sincronizarPendientesFallback() {
  console.log('[Outbox] Fallback: buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then(function (registros) {
      var pendientes = registros.filter(function (item) {
        return item.estado === 'pendiente';
      });

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Mapear cada pendiente -> una promesa de envío HTTP + actualización local
      var promesasDeEnvio = pendientes.map(function (item) {
        return fetch('https://jsonplaceholder.typicode.com/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            // Marcar como sincronizado en IndexedDB (UPDATE)
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Esperar a que todos los reenvíos concluyan en paralelo
      return Promise.all(promesasDeEnvio);
    })
    .then(function () {
      return renderizarColaOutbox();
    })
    .catch(function (error) {
      console.error('[Outbox] Error durante la sincronización (fallback):', error);
    });
}

// -----------------------------
// DELETE: purgar registros ya sincronizados
// - Lee todos, filtra los 'sincronizado', elimina cada uno con Promise.all
//   y repinta la cola.
// -----------------------------
function purgarSincronizados() {
  return obtenerTodosLosRegistros()
    .then(function (registros) {
      var sincronizados = registros.filter(function (item) {
        return item.estado === 'sincronizado';
      });

      // Eliminar cada sincronizado -> arreglo de promesas
      var promesasDelete = sincronizados.map(function (item) {
        return eliminarRegistro(item.id);
      });

      return Promise.all(promesasDelete);
    })
    .then(function () {
      return renderizarColaOutbox();
    })
    .catch(function (error) {
      console.error('[UI] Error al purgar sincronizados:', error);
    });
}

// -----------------------------
// Inicialización al cargar el DOM
// -----------------------------
document.addEventListener('DOMContentLoaded', function () {
  // Mostrar estado de red inicial
  actualizarIndicadorRed();

  // READ: pintar la bandeja al cargar (recupera pendientes aunque estuviera offline)
  renderizarColaOutbox();

  // Conexión del formulario (submit)
  var form = document.getElementById('form-incidencia');
  form.addEventListener('submit', function (e) {
    e.preventDefault(); // evitar recarga de la página

    var datosFormulario = {
      titulo: document.getElementById('titulo').value.trim(),
      descripcion: document.getElementById('descripcion').value.trim()
    };

    procesarEnvioReporte(datosFormulario).then(function () {
      form.reset(); // limpiar el formulario después de procesar
    });
  });

  // Botón de purga (DELETE)
  var btnPurgar = document.getElementById('btn-purgar');
  btnPurgar.addEventListener('click', function () {
    purgarSincronizados();
  });
});

// -----------------------------
// Eventos de red
// - 'offline': solo actualiza el indicador visual
// - 'online': actualiza indicador y, SOLO si NO hay SyncManager,
//   ejecuta el fallback. Si hay SyncManager, el Service Worker se
//   encarga (evita condición de carrera / envíos duplicados).
// -----------------------------
window.addEventListener('offline', actualizarIndicadorRed);

window.addEventListener('online', function () {
  actualizarIndicadorRed();

  // Degradación elegante: solo sincronizar desde UI si el navegador
  // NO soporta Background Sync (ej. Safari/iOS)
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

// -----------------------------
// Service Worker: registro + escucha de mensajes (Tema 5.3)
// - message: el SW avisa con postMessage cuando termina de sincronizar
//   en segundo plano; aquí repintamos la tabla.
// - RUTA RELATIVA './sw.js' para que funcione en GitHub Pages (subdirectorio).
// -----------------------------
if ('serviceWorker' in navigator) {
  // Recibir avisos del Service Worker (sw.js no puede tocar el DOM)
  navigator.serviceWorker.addEventListener('message', function (event) {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });

  // Registrar el Service Worker
  navigator.serviceWorker.register('./sw.js')
    .then(function (reg) {
      console.log('[SW] Registrado con scope:', reg.scope);
    })
    .catch(function (err) {
      console.error('[SW] Error al registrar:', err);
    });
}
