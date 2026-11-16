/*
  db-helper.js
  ------------------------------------------------------------
  "Mini-wrapper" (envoltorio pequeño) para usar IndexedDB con Promesas.
  Reglas de la práctica:
  - 100% JavaScript Vanilla
  - SIN async/await
  - Solo Promesas: new Promise(), .then(), .catch(), Promise.all()

  IMPORTANTE (para que lo entiendas y lo puedas defender):
  - IndexedDB es una base de datos del navegador (guarda objetos/JSON).
  - Sus operaciones son ASÍNCRONAS y funcionan con "eventos"
    (onsuccess, onerror, onupgradeneeded, oncomplete).
  - Nosotros "promisificamos" esas operaciones para poder usarlas
    igual que fetch(): devolviendo Promesas y encadenando con .then().
*/

// Nombre y versión de la base de datos.
// DB_VERSION es CLAVE: si cambias la estructura (ej. crear otro objectStore)
// y NO subes la versión, onupgradeneeded NO se ejecuta y tu cambio no aparece.
var DB_NAME = 'pwa-outbox-db';
var DB_VERSION = 1;

// Nombre del "almacén" (object store) donde guardaremos los reportes.
// Piensa en un objectStore como una "tabla" simple.
var STORE_NAME = 'transacciones_pendientes';

/*
  abrirDB()
  - Abre (o crea) la base de datos.
  - Devuelve una Promesa que se resuelve con el objeto "db".
  - onupgradeneeded: se ejecuta SOLO cuando la BD no existe o cuando subes DB_VERSION.
    Aquí es donde se crean los objectStore e índices.
*/
function abrirDB() {
  return new Promise(function (resolve, reject) {
    // indexedDB.open pide abrir la BD con nombre y versión
    var request = indexedDB.open(DB_NAME, DB_VERSION);

    // Se dispara si es la primera vez o si aumentaste DB_VERSION
    request.onupgradeneeded = function (event) {
      var db = event.target.result;

      // Creamos el almacén solo si no existe
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // keyPath: 'id' -> la propiedad "id" de cada objeto será la llave primaria
        // autoIncrement: true -> IndexedDB genera el id (1,2,3...) automáticamente
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };

    // Si la apertura fue exitosa, resolvemos la promesa con la conexión (db)
    request.onsuccess = function (event) {
      var db = event.target.result;
      resolve(db);
    };

    // Si algo falla al abrir, rechazamos la promesa con el error
    request.onerror = function (event) {
      reject(event.target.error);
    };
  });
}

/*
  guardarRegistro(datos)  -> CREATE
  - Guarda un objeto en IndexedDB.
  - Devuelve una Promesa que se resuelve con el ID generado.

  DETALLE IMPORTANTE (defensa oral):
  - store.add(...) tiene su propio onsuccess donde obtenemos el id generado.
  - PERO el dato no está garantizado en disco hasta que la TRANSACCIÓN termina.
  - Por eso resolvemos en tx.oncomplete (no en req.onsuccess).
*/
function guardarRegistro(datos) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      // Transacción de escritura porque vamos a agregar datos
      var tx = db.transaction([STORE_NAME], 'readwrite');
      var store = tx.objectStore(STORE_NAME);

      var req = store.add(datos);
      var idGenerado;

      // Aquí solo capturamos el id que generó IndexedDB
      req.onsuccess = function (event) {
        idGenerado = event.target.result;
      };

      // Aquí sí: la transacción terminó y el dato quedó escrito en disco
      tx.oncomplete = function () {
        resolve(idGenerado);
      };

      // Si la transacción falla, rechazamos
      tx.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}

/*
  obtenerTodosLosRegistros()  -> READ
  - Lee todos los registros del almacén.
  - Usa transacción 'readonly' porque solo leemos (no modificamos).
  - store.getAll() devuelve un arreglo con todos los objetos guardados.
*/
function obtenerTodosLosRegistros() {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction([STORE_NAME], 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var req = store.getAll();

      req.onsuccess = function (event) {
        // event.target.result es el arreglo completo de registros
        resolve(event.target.result);
      };

      req.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}

/*
  eliminarRegistro(id)  -> DELETE
  - Elimina un registro por su llave primaria (id).
  - Útil para "purgar" los que ya se sincronizaron.
*/
function eliminarRegistro(id) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction([STORE_NAME], 'readwrite');
      var store = tx.objectStore(STORE_NAME);

      // Pedimos borrar el registro con ese id
      store.delete(id);

      tx.oncomplete = function () {
        resolve(true);
      };

      tx.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}

/*
  actualizarEstadoRegistro(id, nuevoEstado)  -> UPDATE
  - Cambia el estado de un registro: 'pendiente' -> 'sincronizado'.
  - Se hace en UNA sola transacción 'readwrite':
      1) store.get(id)  -> leer el objeto actual
      2) store.put(...) -> sobrescribirlo ya modificado
  - Ambas operaciones van dentro de la misma transacción para que sea atómico.
    Si pusiéramos 'readonly' no podríamos hacer put() (y fallaría).
*/
function actualizarEstadoRegistro(id, nuevoEstado) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction([STORE_NAME], 'readwrite');
      var store = tx.objectStore(STORE_NAME);

      // 1. Obtener el registro actual por su llave primaria
      var reqGet = store.get(id);

      reqGet.onsuccess = function (event) {
        var registro = event.target.result;

        // Si no existe un registro con ese id, rechazamos con un error claro
        if (!registro) {
          reject(new Error('No se encontró el registro con ID: ' + id));
          return;
        }

        // 2. Modificar propiedades y sobrescribir con put()
        registro.estado = nuevoEstado;
        registro.fechaSincronizacion = Date.now();
        store.put(registro);
      };

      // 3. Resolver cuando la transacción completa la escritura en disco
      tx.oncomplete = function () {
        resolve(true);
      };

      tx.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}
