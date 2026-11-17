export const migrationName = "20261116000100-exercise-videos-and-media-cleanup.js";
const exerciseTable = "RoutineExercises", cleanupTable = "RoutineMediaCleanupJobs";
const videoTypes = ["none", "upload", "youtube", "external", "drive"];
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const qualified = (table) => `"core".${identifier(table)}`;
const incompatible = (detail) => { throw new Error(`Esquema incompatible: ${detail}. No se modificaron datos; revisar antes de reintentar.`); };
const sameColumns = (actual, expected) => actual.length === expected.length && expected.every((name) => actual.includes(name));
const plainIndex = (index) => index.valid && index.ready && index.immediate && !index.predicate && !index.expression && index.method === "btree";

// Catalog only: no application configuration or exercise/video contents.
export async function inspectSchema({ sequelize, transaction }) {
  const query = async (sql) => (await sequelize.query(sql, { transaction }))[0];
  const relations = await query(`SELECT c.relname AS name, c.relkind AS kind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core'
    AND c.relname IN ('RoutineExercises','RoutineMediaCleanupJobs','SequelizeMeta','routine_media_cleanup_due')`);
  const columns = await query(`SELECT c.relname AS table_name, a.attname AS name, t.typname AS type,
    a.atttypmod AS modifier, pg_catalog.format_type(a.atttypid,a.atttypmod) AS formatted_type,
    a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='core' AND c.relname IN ('RoutineExercises','RoutineMediaCleanupJobs','SequelizeMeta')
    AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`);
  const constraints = await query(`SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
    con.convalidated AS validated, pg_catalog.pg_get_constraintdef(con.oid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord) AS columns
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='core' AND c.relname IN ('RoutineExercises','RoutineMediaCleanupJobs','SequelizeMeta')`);
  const indexes = await query(`SELECT c.relname AS table_name, idx.relname AS name,
    i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready, am.amname AS method,
    i.indimmediate AS immediate, pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate,
    pg_catalog.pg_get_expr(i.indexprs,i.indrelid) AS expression,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num
      WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS columns,
    pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
    JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid=idx.relam WHERE n.nspname='core'
    AND (c.relname IN ('RoutineExercises','RoutineMediaCleanupJobs','SequelizeMeta') OR idx.relname='routine_media_cleanup_due')`);
  return { relations, columns, constraints, indexes };
}

const exerciseRules = {
  videoUrl: { text: Infinity, nullable: true, sql: "TEXT" },
  videoPublicId: { text: 255, nullable: true, sql: "VARCHAR(255)" },
  // Preserve historical 022 NOT NULL DEFAULT 'none' and the nullable variant.
  videoType: { text: 20, videoType: true, sql: "VARCHAR(20)" },
};
const cleanupRules = {
  id: { type: "uuid", required: true, uuidDefault: true, sql: "UUID NOT NULL" },
  publicId: { text: 255, required: true, sql: "VARCHAR(255) NOT NULL" },
  resourceType: { text: 10, required: true, sql: "VARCHAR(10) NOT NULL" },
  assetUrl: { text: Infinity, nullable: true, sql: "TEXT" },
  attempts: { type: "int4", required: true, default: "zero", sql: "INTEGER NOT NULL DEFAULT 0" },
  nextAttemptAt: { type: "timestamptz", required: true, default: "now", sql: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
  createdAt: { type: "timestamptz", required: true, default: "now", sql: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
  updatedAt: { type: "timestamptz", required: true, default: "now", sql: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
};

function validateColumn(column, rule) {
  const label = `${column.table_name}.${column.name}`;
  if (column.identity || column.generated) incompatible(`${label} no puede ser identity/generated`);
  const textType = column.type === "text" || (column.type === "varchar" &&
    (column.modifier === -1 || (rule.text !== Infinity && column.modifier - 4 >= rule.text)));
  if (!(rule.text ? textType : column.type === rule.type)) incompatible(`${label}: tipo ${column.formatted_type} no admitido`);
  if (rule.nullable && column.not_null) incompatible(`${label} debe permitir NULL`);
  if (rule.required && !column.not_null) incompatible(`${label} debe ser NOT NULL`);
  const value = column.default_value;
  const nullDefault = value === null || /^NULL(?:::(?:text|character varying(?:\(\d+\))?))?$/i.test(value);
  if (rule.videoType) {
    const none = /^'none'::(?:character varying|text)$/.test(value);
    if ((!nullDefault && !none) || (column.not_null && !none)) incompatible(`${label}: default incompatible con none/NULL`);
  } else if (rule.default === "now") {
    if (!/^(now\(\)|CURRENT_TIMESTAMP|transaction_timestamp\(\))$/i.test(value)) incompatible(`${label}: default temporal incompatible`);
  } else if (rule.default === "zero") {
    if (!/^(0|'0'::integer)$/.test(value)) incompatible(`${label}: default debe ser 0`);
  } else if (!nullDefault && !(rule.uuidDefault && /^(gen_random_uuid|uuid_generate_v4)\(\)$/.test(value))) incompatible(`${label}: default inesperado`);
}

// Recognize only simple enum CHECKs. Never evaluate arbitrary SQL/functions
// obtained from existing constraint definitions.
export function enumCheckValues(definition, field) {
  // Whitespace/parentheses normalization must never change a string literal.
  const strings = definition.match(/'(?:''|[^'])*'/g) || [];
  if (!strings.length || strings.some((value) => !/^'[a-z_]+'$/.test(value))) return null;
  const compact = definition.replace(/ NOT VALID$/, "").replace(/::(?:character varying|text)(?:\[\])?/g, "").replace(/[()\s"]/g, "");
  const prefix = `CHECK${field}=ANYARRAY[`;
  if (!compact.startsWith(prefix) || !compact.endsWith("]")) return null;
  const literals = compact.slice(prefix.length, -1).split(",");
  return literals.every((value) => /^'[a-z_]+'$/.test(value)) ? literals.map((value) => value.slice(1, -1)) : null;
}

export function validateExistingSchema(schema) {
  const relation = (name) => schema.relations.find((row) => row.name === name);
  if (relation(exerciseTable)?.kind !== "r") incompatible(`core.${exerciseTable} debe ser una tabla ordinaria existente`);
  if (relation(cleanupTable) && relation(cleanupTable).kind !== "r") incompatible(`core.${cleanupTable} debe ser una tabla ordinaria`);
  for (const name of ["id", "routineId"]) {
    const column = schema.columns.find((row) => row.table_name === exerciseTable && row.name === name);
    if (!column || column.type !== "uuid" || !column.not_null) incompatible(`${exerciseTable}.${name} debe ser UUID NOT NULL`);
  }
  for (const [table, rules] of [[exerciseTable, exerciseRules], [cleanupTable, cleanupRules]]) {
    for (const column of schema.columns.filter((row) => row.table_name === table && rules[row.name])) validateColumn(column, rules[column.name]);
  }
  const legacyChecks = [];
  for (const constraint of schema.constraints) {
    if (constraint.table_name === exerciseTable && constraint.columns.some((name) => name in exerciseRules)) {
      const values = constraint.type === "c" && sameColumns(constraint.columns, ["videoType"]) ? enumCheckValues(constraint.definition, "videoType") : null;
      if (!values || !(sameColumns(values, videoTypes.filter((value) => value !== "drive")) || sameColumns(values, videoTypes))) incompatible(`${exerciseTable}: restricción de video no reconocida (${constraint.name})`);
      if (!values.includes("drive")) legacyChecks.push(constraint.name);
    }
    if (constraint.table_name === cleanupTable && constraint.type === "c") {
      const values = enumCheckValues(constraint.definition, "resourceType");
      if (!sameColumns(constraint.columns, ["resourceType"]) || !values || !sameColumns(values, ["image", "video"])) incompatible(`${cleanupTable}: CHECK no reconocido (${constraint.name})`);
    }
    if (constraint.table_name === cleanupTable && constraint.type === "f") incompatible(`${cleanupTable}: FK inesperada (${constraint.name})`);
    if (constraint.table_name === cleanupTable && constraint.type === "p" && !sameColumns(constraint.columns, ["id"])) incompatible(`${cleanupTable}: clave primaria incompatible`);
  }
  for (const index of schema.indexes) {
    if (index.table_name === exerciseTable && index.unique && (index.columns.some((name) => name in exerciseRules) || /"(?:videoUrl|videoPublicId|videoType)"/.test(index.expression || ""))) incompatible(`${exerciseTable}: índice UNIQUE inesperado (${index.name})`);
    if (index.table_name === cleanupTable && index.unique && !(plainIndex(index) &&
      (sameColumns(index.columns, ["id"]) || sameColumns(index.columns, ["publicId", "resourceType"])))) incompatible(`${cleanupTable}: índice UNIQUE incompatible (${index.name})`);
  }
  const due = schema.indexes.find((index) => index.name === "routine_media_cleanup_due");
  if (relation("routine_media_cleanup_due") && (!due || due.table_name !== cleanupTable || !plainIndex(due) || due.unique || !sameColumns(due.columns, ["nextAttemptAt"]))) incompatible("routine_media_cleanup_due existe con otra definición");
  return { legacyChecks };
}

export async function up({ sequelize, transaction }) {
  if (!transaction) return sequelize.transaction((tx) => up({ sequelize, transaction: tx }));
  const query = (sql) => sequelize.query(sql, { transaction });
  await query("SET LOCAL lock_timeout = '5s'");
  await query("SET LOCAL statement_timeout = '30s'");
  await query("SELECT pg_advisory_xact_lock(20261116, 100)");
  await query(`LOCK TABLE ${qualified(exerciseTable)} IN SHARE ROW EXCLUSIVE MODE`);
  let schema = await inspectSchema({ sequelize, transaction });
  if (schema.relations.some((row) => row.name === cleanupTable && row.kind === "r")) {
    await query(`LOCK TABLE ${qualified(cleanupTable)} IN SHARE ROW EXCLUSIVE MODE`);
    schema = await inspectSchema({ sequelize, transaction });
  }
  const { legacyChecks } = validateExistingSchema(schema);
  const existing = (table, name) => schema.columns.some((row) => row.table_name === table && row.name === name);
  const cleanupExists = schema.relations.some((row) => row.name === cleanupTable);
  if (cleanupExists && Object.entries(cleanupRules).some(([name, rule]) => rule.required && !existing(cleanupTable, name))) {
    const [rows] = await query(`SELECT EXISTS (SELECT 1 FROM ${qualified(cleanupTable)}) AS populated`);
    if (rows[0].populated) incompatible(`${cleanupTable} contiene trabajos y le faltan columnas obligatorias; no se inventarán valores`);
  }
  for (const [name, rule] of Object.entries(exerciseRules)) {
    if (!existing(exerciseTable, name)) await query(`ALTER TABLE ${qualified(exerciseTable)} ADD COLUMN ${identifier(name)} ${rule.sql}`);
  }
  const [invalid] = await query(`SELECT EXISTS (SELECT 1 FROM ${qualified(exerciseTable)}
    WHERE "videoType" IS NOT NULL AND "videoType" NOT IN ('none','upload','youtube','external','drive')) AS invalid`);
  if (invalid[0].invalid) incompatible("RoutineExercises.videoType contiene valores fuera del contrato; no se convertirán ni borrarán");
  const currentCheck = schema.constraints.some((row) => row.table_name === exerciseTable && row.type === "c" && sameColumns(enumCheckValues(row.definition, "videoType") || [], videoTypes));
  if (!currentCheck) {
    if (schema.constraints.some((row) => row.table_name === exerciseTable && row.name === "routine_exercises_video_type_mobile_check")) incompatible("nombre de CHECK móvil ocupado");
    // The broader CHECK is validated BEFORE retiring recognized legacy CHECKs.
    await query(`ALTER TABLE ${qualified(exerciseTable)} ADD CONSTRAINT "routine_exercises_video_type_mobile_check" CHECK ("videoType" IN ('none','upload','youtube','external','drive'))`);
  }
  for (const name of legacyChecks) await query(`ALTER TABLE ${qualified(exerciseTable)} DROP CONSTRAINT ${identifier(name)}`);
  for (const row of schema.constraints.filter((row) => !row.validated && row.type === "c" && !legacyChecks.includes(row.name))) {
    if (row.table_name === cleanupTable || (row.table_name === exerciseTable && row.columns.some((name) => name in exerciseRules))) await query(`ALTER TABLE ${qualified(row.table_name)} VALIDATE CONSTRAINT ${identifier(row.name)}`);
  }
  if (!cleanupExists) await query(`CREATE TABLE ${qualified(cleanupTable)} (
    "id" UUID PRIMARY KEY, "publicId" VARCHAR(255) NOT NULL,
    "resourceType" VARCHAR(10) NOT NULL CHECK ("resourceType" IN ('image','video')), "assetUrl" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE ("publicId","resourceType"))`);
  else {
    for (const [name, rule] of Object.entries(cleanupRules)) {
      if (!existing(cleanupTable, name)) await query(`ALTER TABLE ${qualified(cleanupTable)} ADD COLUMN ${identifier(name)} ${rule.sql}`);
    }
    if (!schema.constraints.some((row) => row.table_name === cleanupTable && row.type === "p")) await query(`ALTER TABLE ${qualified(cleanupTable)} ADD PRIMARY KEY ("id")`);
    if (!schema.indexes.some((row) => row.table_name === cleanupTable && row.unique && plainIndex(row) && sameColumns(row.columns, ["publicId", "resourceType"]))) await query(`ALTER TABLE ${qualified(cleanupTable)} ADD UNIQUE ("publicId","resourceType")`);
    if (!schema.constraints.some((row) => row.table_name === cleanupTable && row.type === "c")) await query(`ALTER TABLE ${qualified(cleanupTable)} ADD CONSTRAINT "routine_media_cleanup_resource_type_check" CHECK ("resourceType" IN ('image','video'))`);
  }
  if (!schema.relations.some((row) => row.name === "routine_media_cleanup_due")) await query(`CREATE INDEX "routine_media_cleanup_due" ON ${qualified(cleanupTable)} ("nextAttemptAt")`);
  validateExistingSchema(await inspectSchema({ sequelize, transaction }));
}

export async function down() {
  // No reliable ownership inference for preexisting columns. Preserve everything,
  // including SequelizeMeta (the runner stops before bookkeeping on this error).
  throw new Error("Non-destructive migration; rollback refused: conservar columnas, restricciones, cola y SequelizeMeta. Revertir solo el código o preparar una migración correctiva revisada.");
}
