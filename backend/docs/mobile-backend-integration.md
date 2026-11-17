# Integración móvil del backend

La corrección idempotente de la migración y el diagnóstico de la estructura
histórica están en [recuperación de migración](exercise-video-migration-recovery.md).

Implementado en `feature/mobile-backend-integration`, creada desde `origin/main` (`19a27f2`).
No se hicieron commit, push, merge, despliegues ni cambios en Neon/Render. Se conservó
el archivo local no versionado `backend/scripts/create-play-review-accounts.mjs`.
No se modificaron el repositorio móvil, las credenciales ni los archivos `.env`.

## Causas y correcciones

| Problema | Causa | Corrección |
| --- | --- | --- |
| Checkout móvil vuelve a la web | `client` se descartaba en la normalización y las tres `back_urls` usaban `FRONTEND_URL` | Persistir `client: "mobile"` y generar retornos HTTPS del backend a destinos fijos de la app |
| Preferencias incompatibles entre dispositivos | El canal de retorno no formaba parte de la operación idempotente | La misma clave con otro canal devuelve 409; conserva orden, pago y preferencia existentes |
| No hay videos por ejercicio | Faltaban campos y rutas | Migración opcional, tres endpoints y serialización compartida para entrenador, administrador y cliente |
| Cambian los UUID al editar | Destrucción completa y `bulkCreate`; además, el editor web descartaba `id` | Diff transaccional por UUID; se crean solo ejercicios sin ID y se eliminan solo los omitidos |
| Archivos borrados aunque la edición falle | Cloudinary se eliminaba antes del commit | Cola persistente, comprobación de referencias, staging de subidas y limpieza después del commit |
| Se evade la aprobación | POST/PUT aceptaban `published` directamente; aprobación sin bloqueo compartido | `published` solicita revisión; toda edición publicada requiere revisión o pasa a borrador/archivo explícitos; transiciones bajo bloqueo de la rutina |

## Evidencia del contrato móvil y Mercado Pago

Se inspeccionó en modo lectura el repositorio local `../pry-app-tsg`:

- `app.json`: esquema registrado `pryapptsg`.
- `src/services/mercado-pago-browser.ts`: apertura del navegador y destinos `cart/payment-result` / `memberships/payment-result`.
- `src/features/trainer/models/trainer-routine.ts`: `parseTrainerRoutine()` acepta `{ routine }`, UUID, ejercicios, `videoUrl`, `videoType`, `hasVideo` y orden por día.
- `src/features/trainer/api/trainer-api.ts`: campo multipart `video` y las tres rutas implementadas.
- Los flujos de compra consultan el resultado mediante `orderId`, incluso tras cierre/cancelación del navegador.

Se consultaron las fuentes oficiales de Mercado Pago antes de implementar:

- [URLs de retorno](https://www.mercadopago.com.mx/developers/es/docs/checkout-pro-preferences/configure-back-urls).
- [Referencia de preferencias: URLs HTTPS](https://www.mercadopago.com.mx/developers/es/reference/online-payments/checkout-pro-preferences/update-preference/put).

La solución entrega HTTPS a Checkout Pro y utiliza un redirect HTTP 302 al esquema
registrado. Se conserva `auto_return: "approved"`; la API de preferencias ofrece
`success`, `pending` y `failure`, sin un cuarto callback específico de cancelación.

## Checkout y retorno

Los contratos existentes mantienen su forma y sus reglas de cotización/entrega:

```http
POST /api/checkout/products/mercadopago
Authorization: Bearer <sesión-del-cliente>
Content-Type: application/json

{
  "idempotencyKey": "<clave-estable-por-compra>",
  "client": "mobile",
  "items": [{ "productId": 101, "quantity": 1 }],
  "fulfillment": { "method": "pickup", "recipientName": "Cliente", "phone": "5555555555" },
  "quoteToken": "<token-obtenido-de-la-cotización-del-backend>"
}
```

```http
POST /api/checkout/mercadopago
Authorization: Bearer <sesión-del-cliente>
Content-Type: application/json

{ "idempotencyKey": "<clave-estable-por-compra>", "membershipPlanId": "<uuid-plan>", "client": "mobile" }
```

Las membresías grupales conservan `memberEmails`; planes individuales, estudiantiles
y grupales conservan la activación y aprobación existentes. Una respuesta 201 sigue
incluyendo `{ ok, orderId, preferenceId, checkoutUrl, sandboxCheckoutUrl }`.

Sin `client`, con `null` o con `"web"`, los retornos siguen siendo:

```text
FRONTEND_URL/pago/resultado?orderId=<uuid>&result=success|pending|failure
```

Para móvil:

```text
BACKEND_PUBLIC_URL/api/checkout/mercadopago/mobile-return/cart/success?orderId=<uuid>
BACKEND_PUBLIC_URL/api/checkout/mercadopago/mobile-return/memberships/pending?orderId=<uuid>
```

El GET público acepta exclusivamente destinos `cart` / `memberships`, resultados
`success` / `pending` / `failure` / `cancelled` y un `orderId` UUID escalar. Devuelve:

```http
HTTP/1.1 302 Found
Location: pryapptsg://cart/payment-result?orderId=<uuid>
Cache-Control: no-store
Referrer-Policy: no-referrer
```

Se descartan todos los demás parámetros, incluidos `status`, `result`, tokens,
URLs de redirección, identificadores de Mercado Pago y datos del comprador.
El redirect no lee ni escribe pagos y no revela si existe una orden.
La app debe consultar con su sesión:

```http
GET /api/orders/<uuid>/payment-status
Authorization: Bearer <sesión-del-propietario>
```

Un retorno aprobado puede seguir mostrando `pending` hasta procesar el webhook.
Un rechazo/cancelación se refleja cuando el servidor recibe el estado validado.
El cierre manual del navegador no genera callback ni cancela el pago: la app
existente conserva `orderId` y consulta su estado. Nunca se debe cancelar o crear
otra compra únicamente porque se cerró el navegador.

Las preferencias anteriores se consideran web. Reintentarlas con la misma clave
desde móvil devuelve 409, sin cambiar su retorno y sin generar otro pago. No
rotar automáticamente la clave para superar ese conflicto: consultar la orden y
continuar/resolver la operación existente antes de iniciar otra compra explícita.
Las preferencias móviles de la misma operación se reutilizan incluso con concurrencia.

## Videos de ejercicios y edición

Los tres endpoints requieren sesión de entrenador y propiedad de la rutina:

```sh
curl -X POST "https://<backend>/api/trainer/routines/<uuid>/exercises/<uuid>/video" \
  -H "Authorization: Bearer <sesión-entrenador>" -F "video=@sentadilla.mp4;type=video/mp4"

curl -X PATCH "https://<backend>/api/trainer/routines/<uuid>/exercises/<uuid>/video-url" \
  -H "Authorization: Bearer <sesión-entrenador>" -H "Content-Type: application/json" \
  --data '{"videoUrl":"https://www.youtube.com/watch?v=<id>"}'

curl -X DELETE "https://<backend>/api/trainer/routines/<uuid>/exercises/<uuid>/video" \
  -H "Authorization: Bearer <sesión-entrenador>"
```

Respuesta 200 de los tres, compatible con `parseTrainerRoutine()`:

```json
{
  "routine": {
    "id": "<uuid-rutina>", "title": "Fuerza", "status": "draft",
    "exercises": [{
      "id": "<uuid-estable-ejercicio>", "name": "Sentadilla", "dayNumber": 1, "order": 0,
      "videoUrl": "https://<proveedor>/video.mp4", "videoType": "upload", "hasVideo": true
    }]
  }
}
```

El objeto real conserva los demás campos de rutina/ejercicios. Al eliminar:
`videoUrl: null`, `videoPublicId: null`, `videoType: "none"`, `hasVideo: false`.
Los enlaces se clasifican como `youtube`, `drive` o `external` por hostname exacto.

Se validan UUID, pertenencia del ejercicio, campo multipart, extensión/MIME
coincidentes, firma inicial del contenedor y límite de 100 MiB (100 × 1024² bytes).
Cloudinary valida el contenido decodificable y limita los formatos a MP4/WEBM/MOV.
URLs: HTTPS, máximo 2048 caracteres, dominio público, sin credenciales, IP literal,
puerto alternativo, controles o destino local. El backend nunca descarga enlaces externos.
Respuestas: 400 entrada inválida; 401 sin sesión; 403 rol; 404 propiedad/ejercicio;
409 rutina pendiente de revisión; 413 archivo excesivo; 5xx fallo de persistencia/proveedor.

PUT conserva ejercicios cuando se omite `exercises`. Cuando se envía el arreglo,
es la lista completa deseada: incluir `id` para conservar y editar, omitir `id`
solo para crear, y omitir de la lista un UUID existente para retirarlo. `[]` elimina
los ejercicios explícitamente. JSON inválido, IDs duplicados/ajenos o días inválidos
rechazan toda la transacción. Los campos de video enviados dentro de ese JSON no
sobrescriben asociaciones: se usan los endpoints específicos.

Una rutina `pending_review` no permite edición ni eliminación por su entrenador.
Crear con `published` solicita `pending_review`. Editar una publicada sin una
transición explícita a borrador/archivo vuelve a revisión. Los videos publicados
editados también requieren revisión. Solo el administrador aprueba una rutina
pendiente. Las rutas de cliente mantienen membresía activa y estado `published`.
Los videos generales de rutina siguen funcionando por separado.

## Persistencia y Cloudinary

La migración `20261116000100-exercise-videos-and-media-cleanup.js` agrega campos
nullable `videoUrl`, `videoPublicId` y `videoType` a `core.RoutineExercises`, y crea
`core.RoutineMediaCleanupJobs`. No reescribe ni elimina filas existentes.

Las subidas reservan un public ID generado por el servidor y un trabajo durable
antes de contactar al proveedor. El trabajo permanece bloqueado durante la
transacción. Su eliminación y la asociación del archivo se confirman juntas.
Ante rollback/caída queda pendiente para limpieza. Los archivos reemplazados se
encolan dentro de la transacción; el worker actúa después del commit, con
`FOR UPDATE SKIP LOCKED`, comprobación de referencias por public ID/URL y reintentos
entre 1 minuto y 1 hora. La respuesta no depende del éxito de esa eliminación.
El worker arranca con el backend y reintenta cada minuto; los avisos de cola deben
monitorizarse. Los enlaces externos no se borran en el proveedor.

`down` siempre rechaza la reversión, incluso con tablas vacías, para conservar
también estructura preexistente. Para retirar la funcionalidad se vuelve al código
anterior manteniendo la migración aditiva, o se corrige hacia adelante; no se fuerza
la eliminación de columnas ni de la cola.

## Archivos entregados

- Checkout: `services/mercadoPagoCheckoutService.js`, `routes/checkoutRoutes.js`, nuevo `controllers/mobilePaymentReturnController.js`.
- Rutinas: `controllers/trainerRoutineController.js`, nuevo `services/trainerRoutineMutationService.js`, `routes/trainer/routineRoutes.js`, nuevo `utils/routineValidation.js`.
- Medios: `middleware/uploadMemory.js`, `utils/cloudinaryUpload.js`, nuevo `services/routineMediaCleanupService.js`, `index.js`.
- Persistencia: `models/RoutineExercise.js`, nuevo `models/RoutineMediaCleanupJob.js`, `models/index.js` y la migración indicada.
- Web: una línea en `frontend/src/pages/trainer/TrainerRoutinesPage.tsx` para conservar `id` al abrir el editor; se informó antes del cambio.
- Pruebas: `tests/mobileCheckout.test.js`, `tests/trainerRoutineMobile.test.js`, `tests/mobilePostgresSafety.test.js`, helpers `routineFixture.js`, `checkoutPostgresFixture.js`, `mobilePostgresTarget.js`, integraciones `mobileBackendPostgres.test.js`, `mobileCheckoutPostgres.test.js` y comando en `package.json`.

## Pruebas ejecutadas

| Ejecución | Resultado |
| --- | --- |
| `cd backend; npm.cmd test` | 447/447 aprobadas, 0 omitidas; incluye todas las 444 anteriores y 3 nuevas de validación/reversión |
| `npm.cmd run test:mobile:postgres` | 36/36 aprobadas, 0 omitidas, PostgreSQL 16.10 real en loopback; incluye 23 nuevas de migración |
| Integraciones existentes `accessPostgres.test.js` y `privacyPostgres.test.js` | 17/17 aprobadas, 0 omitidas, bases locales separadas |
| `cd frontend; npm.cmd run build` | TypeScript + Vite correctos; aviso de tamaño de chunks |
| `git diff --check` | Sin errores de whitespace |

Se validaron `up/down rechazado/up`, preservación de filas anteriores a `up`, bloqueo seguro
de `down`, persistencia de staging antes de subir, exclusión de cleanup durante una
subida, rollback después de SQL real, contención de dos sesiones PostgreSQL y ocho
subidas simultáneas usando todo el pool sin necesitar una conexión adicional.
Se probaron preferencias concurrentes, conflicto de canal sin duplicados y webhooks
firmados concurrentes con un solo pago/recibo/suscripción/historial.

Los proveedores Mercado Pago y Cloudinary fueron sustituidos por adaptadores de
prueba; la firma de webhook usa el validador real del SDK. No se cobraron pagos ni
se subieron/borraron archivos reales. No se ejecutaron pruebas remotas, pruebas en
dispositivo o los arneses antiguos que requieren un destino Neon autorizado.
La confirmación de compatibilidad web y conservación de datos corresponde a estas
pruebas locales y a la migración aditiva. La inspección posterior de catálogo y
metadata en solo lectura se documenta en el informe de recuperación; no se cambió
producción.

Para repetir las integraciones, crear una base **vacía desechable** en loopback:

```powershell
cd backend
$env:MOBILE_TEST_DATABASE_URL = 'postgresql://<usuario-test>@127.0.0.1:<puerto>/titanium_mobile_test'
$env:MOBILE_TEST_ALLOW_LOCAL_DDL = 'true'
npm.cmd run test:mobile:postgres
```

El arnés rechaza host remoto, `localhost`, nombre de base distinto, query overrides
y cualquier esquema `core` preexistente. No carga `.env`. Crea y retira únicamente
el esquema que él mismo creó en la base de pruebas. Sin URL, la integración se
omite; para validación se deben comprobar contadores de omisión iguales a cero.

## Configuración y despliegue futuro, únicamente con autorización

No hay variables nuevas obligatorias. Confirmar en staging, conservando valores
de producción: `BACKEND_PUBLIC_URL` con el origen público HTTPS real del backend,
sin credenciales/query/fragmento; `FRONTEND_URL`; credenciales y webhook existentes
de Mercado Pago; credenciales actuales de Cloudinary. El backend requiere DML en
la cola nueva; el rol de migración necesita DDL en `core`. Si los grants no cubren
tablas futuras, conceder DML a la cola al rol runtime mediante el proceso habitual.

1. Revisar y autorizar el diff. Confirmar respaldo restaurable de `core.Routines`,
   `core.RoutineExercises` y configuración de proveedor. Registrar inventario de
   UUID y conteos antes de la migración. No activar `SEQUELIZE_SYNC_ON_START`.
2. Crear entorno staging aislado con su propia base, claves de prueba del vendedor
   y carpeta/cuenta Cloudinary de prueba. Revisar migraciones ya aplicadas y la
   existencia de las tablas históricas de rutinas, originalmente creadas fuera de
   estas migraciones. No intentar recrearlas ni sincronizar con `alter/force`.
3. En un proceso apuntando explícitamente a staging, ejecutar desde `backend`
   `npm.cmd run migrate:status`. Continuar con `npm.cmd run migrate:up` solo si
   la única migración pendiente es `20261116000100-exercise-videos-and-media-cleanup.js`.
   El runner aplica todas las pendientes: si aparecen otras, revisarlas antes de
   ejecutar. Verificar las tres columnas nullable, la tabla/índice nuevos y que los
   UUID/conteos de rutinas y ejercicios no cambiaron. Ejecutar las pruebas locales.
4. Desplegar backend en staging con la migración ya aplicada y el cambio mínimo
   del frontend web. Recargar el editor para evitar formularios antiguos que
   descartaban UUID. No editar una rutina desde una pestaña cargada antes del cambio.
5. Con cuentas de prueba, comprobar web/móvil, productos con recogida y envío,
   tipos de membresía, aprobado/pendiente/rechazado/cancelación/cierre manual,
   entrega del webhook firmado, reintentos con la misma clave, URLs del navegador,
   videos reales de los tres formatos, reemplazos y limpieza tras rollback.
   Comprobar el esquema registrado en una build instalada de la app; Expo Go
   puede usar `exp://` y no equivale a la build instalada con `pryapptsg://`.
6. Después de esas pruebas y de la autorización de producción: respaldo/verificación
   de inventario de UUID, `migrate:status`, `migrate:up` con la misma condición de
   única migración pendiente, revisión de grants y despliegue de backend + corrección
   del editor web. No cambiar tokens/secretos ni reglas financieras del proveedor.
7. Verificar salud, compra web y móvil controladas según autorización, consulta de
   estado con propietario, recibo único, membresía, inventario, cola sin errores
   repetidos y mismos UUID de los ejercicios conservados. Ante fallo, detener el
   rollout y volver al código anterior conservando las columnas/cola; no forzar `down`.

Riesgos restantes de validación: retorno del navegador en Android/iOS y callbacks
reales de Mercado Pago; tiempos, cuotas y disponibilidad de Cloudinary/Render para
subidas de 100 MiB en memoria. Los enlaces externos pueden dejar de estar disponibles.
La incompatibilidad controlada de preferencias web/móvil devuelve 409 para evitar
duplicados. Las correcciones de aprobación rechazan edición en revisión (409) y
evitan publicación directa desde el selector histórico de la web.
