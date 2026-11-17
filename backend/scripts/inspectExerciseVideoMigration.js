import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Sequelize } from "sequelize";
import { postgresOptions } from "../config/postgresConnection.js";
import { inspectSchema, validateExistingSchema, migrationName } from "../migrations/20261116000100-exercise-videos-and-media-cleanup.js";

// Deliberately does not import config/sequelize.js or call migrate:status (which
// can create SequelizeMeta). Load an env file explicitly with node --env-file.
export async function inspectExerciseVideoMigration(sequelize) {
  return sequelize.transaction({ readOnly: true }, async (transaction) => {
    await sequelize.query("SET TRANSACTION READ ONLY", { transaction });
    const [mode] = await sequelize.query("SELECT current_setting('transaction_read_only') AS mode", { transaction });
    if (mode[0].mode !== "on") throw new Error("Read-only inspection required");
    const schema = await inspectSchema({ sequelize, transaction });
    let compatibility;
    try { compatibility = { compatible: true, ...validateExistingSchema(schema) }; }
    catch (error) { compatibility = { compatible: false, reason: error.message }; }
    const metaExists = schema.relations.some((row) => row.name === "SequelizeMeta" && row.kind === "r");
    const migrations = metaExists ? (await sequelize.query('SELECT "name", "executedAt" FROM "core"."SequelizeMeta" ORDER BY "name"', { transaction }))[0] : [];
    return { readOnly: true, migration: migrationName, recorded: migrations.some((row) => row.name === migrationName),
      metaExists, compatibility, ...schema, migrations };
  });
}

async function main() {
  const options = postgresOptions(process.env.DATABASE_URL_RUNTIME, { pooled: false });
  options.dialectOptions = { ...options.dialectOptions,
    options: "-c default_transaction_read_only=on", application_name: "titanium-exercise-video-migration-inspection",
    statement_timeout: 10000, connectionTimeoutMillis: 10000 };
  const sequelize = new Sequelize(options);
  try {
    const result = await inspectExerciseVideoMigration(sequelize);
    const targetFingerprint = createHash("sha256").update(JSON.stringify({ host: options.host, port: options.port, database: options.database })).digest("hex");
    console.log(JSON.stringify({ targetFingerprint, ...result }, null, 2));
    if (!result.compatibility.compatible) process.exitCode = 1;
  } finally { await sequelize.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("No se completó la inspección de solo lectura.", { name: error.name, code: error.original?.code || error.code || null });
    process.exitCode = 1;
  });
}
