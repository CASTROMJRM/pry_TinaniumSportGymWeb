# Corrección segura de la migración de videos

## Diagnóstico confirmado

Se inspeccionaron la migración nueva, `models/RoutineExercise.js`, el runner y el
historial Git. Se consultó la base configurada en `DATABASE_URL_RUNTIME` mediante
una conexión con `default_transaction_read_only=on` y una transacción `READ ONLY`.
No se ejecutaron DDL, DML ni el runner contra Neon.
Se comprobó privadamente que las URLs runtime y admin directo configuradas apuntan
al mismo endpoint lógico (con/sin pooler) y a la misma base, sin publicar credenciales.

Resultado del catálogo de `core`:

| Objeto | Estado observado |
| --- | --- |
| `RoutineExercises.videoUrl` | `text`, nullable, sin default |
| `RoutineExercises.videoPublicId` | `varchar(255)`, nullable, sin default |
| `RoutineExercises.videoType` | `varchar(20) NOT NULL DEFAULT 'none'` |
| CHECK histórico de `videoType` | `none`, `upload`, `youtube`, `external` |
| `RoutineMediaCleanupJobs` | No existe |
| `SequelizeMeta` | `name varchar(255)` PK; `executedAt timestamptz NOT NULL DEFAULT now()` |
| `20260717002200-add-video-fields-to-routine-exercises.js` | Registrada como aplicada |
| `20261116000100-exercise-videos-and-media-cleanup.js` | Sin registrar |

También se comprobaron los UUID, PK, FK hacia `core.Routines`, restricciones de
días/series/descanso/orden e índices existentes mediante el catálogo, sin leer
los contenidos privados de los ejercicios o los videos.

La migración histórica 022 se encontró en el commit Git `e97e761` (`Rutinas`).
Agregaba exactamente esas tres columnas, el default y el CHECK observados.
No está en el árbol de este checkout. La migración nueva repetía `ADD COLUMN`
incondicionalmente, de ahí el error. No se debe borrar/restaurar datos ni retirar
el registro histórico para corregirlo.

El fallo comunicado ocurre al primer `ALTER TABLE`, dentro de la transacción
del runner: ese intento no explica las columnas antiguas ni implica que deban
eliminarse. `sequelize.sync()` sin `alter` solo crea tablas faltantes; no completa
las columnas de una tabla que ya existe. Una tabla creada previamente por sync
sí podría contener esos campos, pero aquí hay evidencia específica de la 022.

Se encontró además una debilidad independiente del runner: confirmaba el DDL y
después insertaba `SequelizeMeta`, en otra operación. Un corte entre ambos pasos
podía dejar DDL aplicado con metadata pendiente. Se corrigió para migraciones
transaccionales; las históricas con `useTransaction=false` conservan su mecanismo.

## Cambios

- `migrations/20261116000100-exercise-videos-and-media-cleanup.js`: inspección de
  `pg_catalog`, validación y creación exclusiva de columnas/tabla/índices faltantes.
  Todo en una transacción, con bloqueo compartido por invocaciones de esta migración,
  espera por locks limitada a 5 segundos y sentencias limitadas a 30 segundos.
- Se aceptan los campos opcionales originales y `videoType NOT NULL DEFAULT 'none'`
  histórico. Se conservan tipos compatibles, defaults, nullabilidad y datos.
  Se rechazan tipos estrechos/incorrectos, defaults inesperados, columnas generadas,
  restricciones no reconocidas e índices incompatibles. No se hacen conversiones
  automáticas, backfills, UPDATE, DELETE, TRUNCATE ni eliminación de columnas/tablas.
- El único CHECK histórico reconocido se amplía para incluir `drive`, valor que
  ya produce el backend. Primero se instala y valida el CHECK nuevo; después se
  retira el CHECK antiguo reconocido, en la misma transacción. Los valores anteriores
  siguen admitidos y valores arbitrarios siguen rechazados. Los otros CHECK/FK/PK
  de las rutinas y ejercicios se conservan.
- Una cola existente compatible conserva sus trabajos. Se completa estructura
  opcional faltante; si faltan campos obligatorios en una cola con datos se rechaza
  la operación en lugar de inventar sus identificadores o atributos.
- `down` **siempre rechaza la reversión**, incluso con tablas vacías: no puede inferir
  qué columnas eran preexistentes y no tiene autorización para borrarlas. El runner
  conserva también el registro de `SequelizeMeta` al fallar `down`.
- `scripts/migrate.js`: DDL y alta/baja automática de metadata comparten la misma
  transacción. No se alteró manualmente `SequelizeMeta`.
- Nuevo `scripts/inspectExerciseVideoMigration.js`: diagnóstico de catálogo y
  metadata exclusivamente de lectura. No importa la configuración normal de la
  aplicación, no activa sync y no crea `SequelizeMeta`.
- Pruebas nuevas de migración y del runner; ajuste del test móvil de reversión al
  contrato no destructivo; comandos en `package.json` y esta documentación.

El modelo se inspeccionó y se dejó intacto. No se cambiaron controladores, pagos,
servicios de negocio, credenciales, frontend ni repositorio móvil en esta corrección.
Los cambios locales previos de la rama se preservaron.

## Pruebas

Pruebas ejecutadas sin conectar el arnés a Neon; PostgreSQL 16.10 temporal escuchando
solo en `127.0.0.1`, con bases desechables y datos de prueba propios:

- `npm.cmd test`: 447 aprobadas, ninguna omitida; incluye las 444 anteriores y tres
  nuevas comprobaciones de validación/reversión.
- `npm.cmd run test:exercise-video-migration:postgres`: 23 aprobadas, ninguna omitida.
  Comprueba las ocho combinaciones de columnas preexistentes, tabla antigua,
  equivalencia del esquema histórico, campos nullable, defaults, CHECK, PK/UNIQUE e
  índice de limpieza. Cada caso ejecuta `up` dos veces y compara filas/UUID/videos
  y estructura. Se prueba también la llamada directa a `up` sin transacción externa.
- El runner real se carga con una conexión suministrada por el arnés: aplica y
  registra una vez, omite la segunda ejecución y rechaza `down` conservando metadata.
  Un fallo inyectado después de un INSERT real en metadata revierte conjuntamente
  el DDL y ese INSERT, y un reintento posterior funciona.
- `npm.cmd run test:mobile:postgres`: 36 aprobadas, ninguna omitida; incluye las 23
  anteriores y las 13 integraciones previas de rutinas/checkout, conservando permisos,
  UUID, concurrencia y webhooks.
- Integraciones existentes de QR y privacidad: 17 aprobadas en bases locales separadas.

Total PostgreSQL: 53 pruebas distintas aprobadas, contando las nuevas de migración
una sola vez. `git diff --check` y las verificaciones de sintaxis también pasaron.

El script de inspección corregido también se ejecutó contra el catálogo remoto en
solo lectura: estructura existente compatible, CHECK histórico reconocido, nueva
migración todavía pendiente y tabla de limpieza todavía ausente. Esto **no** es una
aplicación ni una prueba de escritura de la corrección en Neon.

Para repetir las pruebas de integración:

```powershell
cd backend
$env:MOBILE_TEST_DATABASE_URL = 'postgresql://<usuario-test>@127.0.0.1:<puerto>/titanium_mobile_test'
$env:MOBILE_TEST_ALLOW_LOCAL_DDL = 'true'
npm.cmd run test:exercise-video-migration:postgres
npm.cmd run test:mobile:postgres
```

El arnés rechaza hosts remotos, overrides de conexión y una base con un esquema
`core` ya existente. Solo retira el esquema que él creó en esa base desechable.

## Reintento futuro, únicamente cuando se autorice

1. Revisar y autorizar el diff; tener un respaldo restaurable o una rama de Neon
   aislada de validación. Evitar actividad de edición de rutinas y otras ejecuciones
   de migraciones durante la ventana elegida. No activar `sync({ alter: true })`,
   `sync({ force: true })` ni borrar campos para superar el error.
2. Desde `backend`, ejecutar primero este comando **de solo lectura** contra el
   entorno intencional. No imprime URLs de conexión, credenciales ni videos:

   ```powershell
   node --env-file=.env scripts/inspectExerciseVideoMigration.js
   ```

   Confirmar `readOnly: true`, `compatibility.compatible: true`, la 022 registrada,
   la nueva sin registrar y tipos/defaults/CHECK esperados. El inspector comprueba
   estructura existente; la migración también valida datos contra el contrato y
   comprueba o completa las estructuras faltantes dentro de la transacción.
3. Confirmar que `DATABASE_URL_ADMIN_DIRECT`, usado por el runner, y la URL runtime
   inspeccionada corresponden a **la misma base y rama** intencionales. Verificar
   estos destinos privadamente, sin pegar credenciales en terminales o reportes.
4. En la rama de validación aislada, con las variables apuntando explícitamente a
   ella y autorización para DDL: `npm run migrate:status`. La única migración de
   este checkout pendiente debe ser `20261116000100-exercise-videos-and-media-cleanup.js`.
   El comando `status` del runner puede crear `SequelizeMeta`; para auditoría
   estrictamente de lectura usar el inspector del paso 2.
5. Ejecutar `npm run migrate:up` en ese entorno aislado. El runner revisa todas las
   pendientes: si hay otras, detenerse y revisarlas antes. Verificar que se creó la
   cola, se conservó el CHECK/default compatible y el runner registró la migración.
   Repetir `npm run migrate:up`: debe informar que no hay migraciones pendientes.
   Comparar UUID, conteos y datos contra el respaldo/snapshot anterior y comprobar
   el flujo real de videos. No insertar casos de prueba en producción.
6. Solo después de esa validación y de la autorización expresa para producción,
   repetir los pasos 2–5 contra el destino productivo autorizado. El primer reintento
   encontrará las columnas antiguas y las validará; no las volverá a agregar.
7. Si aparece incompatibilidad, timeout o fallo de registro, no forzar ni modificar
   `SequelizeMeta`. Con esta migración, el runner revierte su transacción y deja
   pendiente la operación. Guardar el diagnóstico, revisar y reintentar con una
   corrección compatible. `down` no es una opción de borrado: para retirar la
   funcionalidad se revierte el código conservando la estructura y los datos.

No se realizaron cambios en Neon, commit, push, merge ni despliegues durante esta
corrección. La instancia temporal de PostgreSQL se detiene al terminar la validación.
