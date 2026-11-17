import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import { validateMobilePostgresTarget } from "../helpers/mobilePostgresTarget.js";
import { migrationRunnerFixture } from "../helpers/migrationRunnerFixture.js";
import { inspectExerciseVideoMigration } from "../../scripts/inspectExerciseVideoMigration.js";
import { up, down, inspectSchema, migrationName } from "../../migrations/20261116000100-exercise-videos-and-media-cleanup.js";

test("exercise video migration: real PostgreSQL legacy/partial schema, validation, idempotency and atomic runner", {
  skip: !process.env.MOBILE_TEST_DATABASE_URL, timeout: 60000,
}, async (t) => {
  const target = process.env.MOBILE_TEST_DATABASE_URL;
  validateMobilePostgresTarget(target, process.env.MOBILE_TEST_ALLOW_LOCAL_DDL);
  const db = new Sequelize(target, { dialect: "postgres", logging: false, pool: { min: 0, max: 8 },
    dialectOptions: { ssl: false, statement_timeout: 15000, connectionTimeoutMillis: 5000 } });
  t.after(() => db.close());
  const [identity] = await db.query("SELECT current_database() AS name, inet_server_addr()::text AS address");
  assert.equal(identity[0].name, "titanium_mobile_test");
  assert.ok(["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(identity[0].address));
  const names = ["videoUrl", "videoPublicId", "videoType"];
  const definitions = ["TEXT", "VARCHAR(255)", "VARCHAR(20) NOT NULL DEFAULT 'none'"];
  async function fixture(child, mask = 0) {
    const [schemas] = await db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='core'");
    assert.equal(schemas.length, 0, "Refusing to modify an existing schema");
    await db.query('CREATE SCHEMA "core"');
    child.after(() => db.query('DROP SCHEMA "core" CASCADE'));
    await db.query(`CREATE TABLE "core"."Routines" ("id" UUID PRIMARY KEY, "title" TEXT NOT NULL);
      CREATE TABLE "core"."RoutineExercises" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "routineId" UUID NOT NULL REFERENCES "core"."Routines"("id"),
        "name" VARCHAR(160) NOT NULL, "dayNumber" INTEGER NOT NULL DEFAULT 1 CHECK ("dayNumber">0),
        "order" INTEGER NOT NULL DEFAULT 0, "notes" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    for (let index = 0; index < 3; index++) {
      if (mask & (1 << index)) await db.query(`ALTER TABLE "core"."RoutineExercises" ADD COLUMN "${names[index]}" ${definitions[index]}`);
    }
    if (mask & 4) await db.query(`ALTER TABLE "core"."RoutineExercises" ADD CONSTRAINT "routine_exercises_video_type_check"
      CHECK ("videoType" IN ('none','upload','youtube','external'))`);
    const routineId = randomUUID(), exerciseId = randomUUID();
    await db.query('INSERT INTO "core"."Routines" ("id","title") VALUES ($1,$2)', { bind: [routineId, "Existing routine"] });
    const fields = ["id", "routineId", "name", "notes"], values = [exerciseId, routineId, "Existing exercise", "Keep all existing data"];
    for (let index = 0; index < 3; index++) if (mask & (1 << index)) {
      fields.push(names[index]); values.push(["https://example.com/real-existing-video.mp4", "titanium/routines/videos/existing", "upload"][index]);
    }
    await db.query(`INSERT INTO "core"."RoutineExercises" (${fields.map((field) => `"${field}"`).join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})`, { bind: values });
    return { routineId, exerciseId };
  }
  async function rows() {
    return { routines: (await db.query('SELECT * FROM "core"."Routines" ORDER BY "id"'))[0],
      exercises: (await db.query('SELECT * FROM "core"."RoutineExercises" ORDER BY "id"'))[0] };
  }
  const migrate = () => db.transaction((transaction) => up({ sequelize: db, transaction }));
  const schema = () => db.transaction((transaction) => inspectSchema({ sequelize: db, transaction }));
  async function assertPreserved(before) {
    const after = await rows(); assert.deepEqual(after.routines, before.routines);
    assert.equal(after.exercises.length, before.exercises.length);
    for (let index = 0; index < before.exercises.length; index++) {
      for (const [key, value] of Object.entries(before.exercises[index])) assert.deepEqual(after.exercises[index][key], value, key);
    }
  }

  for (let mask = 0; mask < 8; mask++) await t.test(`all column subsets: mask ${mask}, two up executions preserve every existing field`, async (child) => {
    const ids = await fixture(child, mask), before = await rows();
    if (mask === 0) await up({ sequelize: db }); else await migrate();
    await assertPreserved(before);
    const firstRows = await rows(), firstSchema = await schema();
    await migrate(); assert.deepEqual(await rows(), firstRows); assert.deepEqual(await schema(), firstSchema);
    await assert.rejects(db.transaction((transaction) => down({ sequelize: db, transaction })), /rollback refused/);
    assert.deepEqual(await rows(), firstRows); assert.deepEqual(await schema(), firstSchema);
    if (mask & 4) {
      const type = firstSchema.columns.find((column) => column.table_name === "RoutineExercises" && column.name === "videoType");
      assert.equal(type.not_null, true); assert.equal(type.default_value, "'none'::character varying");
      // Prove the known historical CHECK was broadened without disabling it.
      await db.transaction(async (transaction) => {
        await db.query('UPDATE "core"."RoutineExercises" SET "videoType"=\'drive\' WHERE "id"=$1', { bind: [ids.exerciseId], transaction });
        await assert.rejects(db.query('UPDATE "core"."RoutineExercises" SET "videoType"=\'unsupported\' WHERE "id"=$1', { bind: [ids.exerciseId], transaction }), /check constraint/);
        // The expected SQL error aborts this disposable transaction.
      }).catch((error) => { if (!/transaction|aborted/i.test(error.message)) throw error; });
      await assertPreserved(before);
    }
  });

  for (const [label, ddl] of [
    ["wrong type", 'ADD COLUMN "videoUrl" INTEGER'],
    ["short public id", 'ADD COLUMN "videoPublicId" VARCHAR(40)'],
    ["incompatible nullability", 'ADD COLUMN "videoUrl" TEXT NOT NULL DEFAULT \'placeholder\''],
    ["unexpected default", 'ADD COLUMN "videoType" VARCHAR(20) DEFAULT \'youtube\''],
    ["generated column", 'ADD COLUMN "videoUrl" TEXT GENERATED ALWAYS AS (\'https://example.com/generated\') STORED'],
    ["unknown check", 'ADD COLUMN "videoUrl" TEXT CHECK (length("videoUrl")<100)'],
    ["unique video association", 'ADD COLUMN "videoPublicId" VARCHAR(255) UNIQUE'],
  ]) await t.test(`${label}: reject and roll back without losing data or adding other columns`, async (child) => {
    await fixture(child); await db.query(`ALTER TABLE "core"."RoutineExercises" ${ddl}`);
    const before = await rows(), beforeSchema = await schema();
    await assert.rejects(migrate(), /Esquema incompatible/);
    assert.deepEqual(await rows(), before); assert.deepEqual(await schema(), beforeSchema);
  });

  await t.test("unexpected existing videoType data is preserved; migration rejects instead of coercing it", async (child) => {
    await fixture(child); await db.query('ALTER TABLE "core"."RoutineExercises" ADD COLUMN "videoType" VARCHAR(20) DEFAULT NULL');
    await db.query('UPDATE "core"."RoutineExercises" SET "videoType"=\'custom-existing\'');
    const before = await rows(), beforeSchema = await schema(); await assert.rejects(migrate(), /valores fuera del contrato/);
    assert.deepEqual(await rows(), before); assert.deepEqual(await schema(), beforeSchema);
  });

  await t.test("existing nullable fields and populated cleanup queue survive; missing optional assetUrl is added", async (child) => {
    await fixture(child, 3); await db.query('ALTER TABLE "core"."RoutineExercises" ADD COLUMN "videoType" VARCHAR(20)');
    await db.query(`CREATE TABLE "core"."RoutineMediaCleanupJobs" (
      "id" UUID PRIMARY KEY, "publicId" VARCHAR(255) NOT NULL, "resourceType" VARCHAR(10) NOT NULL,
      "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    await db.query('INSERT INTO "core"."RoutineMediaCleanupJobs" ("id","publicId","resourceType") VALUES ($1,\'existing-file\',\'video\')', { bind: [randomUUID()] });
    const before = await rows(), [jobs] = await db.query('SELECT * FROM "core"."RoutineMediaCleanupJobs"');
    await migrate(); await migrate(); await assertPreserved(before);
    const [after] = await db.query('SELECT * FROM "core"."RoutineMediaCleanupJobs"');
    for (const [key, value] of Object.entries(jobs[0])) assert.deepEqual(after[0][key], value);
    assert.equal(after[0].assetUrl, null);
    await assert.rejects(down(), /rollback refused/); assert.deepEqual((await db.query('SELECT * FROM "core"."RoutineMediaCleanupJobs"'))[0], after);
  });

  await t.test("empty partial cleanup table is completed, while populated incomplete tables are refused", async (child) => {
    await fixture(child, 7);
    await db.query('CREATE TABLE "core"."RoutineMediaCleanupJobs" ("id" UUID PRIMARY KEY)');
    await db.query('INSERT INTO "core"."RoutineMediaCleanupJobs" ("id") VALUES ($1)', { bind: [randomUUID()] });
    const before = await schema(); await assert.rejects(migrate(), /no se inventarán valores/); assert.deepEqual(await schema(), before);
    // Use a savepoint to test an empty partial variant without deleting rows.
    await db.transaction(async (transaction) => {
      await db.query('ALTER TABLE "core"."RoutineMediaCleanupJobs" RENAME TO "PreservedIncompleteJobs"', { transaction });
      await db.query('CREATE TABLE "core"."RoutineMediaCleanupJobs" ("id" UUID PRIMARY KEY)', { transaction });
      await up({ sequelize: db, transaction }); await up({ sequelize: db, transaction });
      assert.equal((await db.query('SELECT count(*)::int AS count FROM "core"."PreservedIncompleteJobs"', { transaction }))[0][0].count, 1);
    });
  });

  await t.test("a conflicting index definition is refused rather than silently skipped", async (child) => {
    await fixture(child, 7); await migrate();
    // Preserve the correct index under another name, then simulate name reuse.
    await db.query('ALTER INDEX "core"."routine_media_cleanup_due" RENAME TO "preserved_due_index"');
    await db.query('CREATE INDEX "routine_media_cleanup_due" ON "core"."RoutineExercises" ("name")');
    const before = await schema(); await assert.rejects(migrate(), /otra definición/); assert.deepEqual(await schema(), before);
  });

  await t.test("read-only inspection never creates SequelizeMeta or modifies schema", async (child) => {
    await fixture(child, 7); const before = await schema(), beforeRows = await rows();
    const inspected = await inspectExerciseVideoMigration(db);
    assert.equal(inspected.readOnly, true); assert.equal(inspected.metaExists, false); assert.equal(inspected.recorded, false);
    assert.equal(inspected.compatibility.compatible, true);
    assert.deepEqual(await schema(), before); assert.deepEqual(await rows(), beforeRows);
  });

  await t.test("actual runner records once, skips second up and refused down preserves SequelizeMeta and all structures", async (child) => {
    await fixture(child, 7); const before = await rows();
    const first = await migrationRunnerFixture(db); assert.equal(first.exitCode, 0, JSON.stringify(first.errors)); assert.deepEqual(first.metaTransactions, [true]);
    const [meta] = await db.query('SELECT * FROM "core"."SequelizeMeta"');
    assert.equal(meta.length, 1); assert.equal(meta[0].name, migrationName);
    const afterSchema = await schema(); const second = await migrationRunnerFixture(db);
    assert.equal(second.exitCode, 0); assert.deepEqual(second.metaTransactions, []);
    const reverted = await migrationRunnerFixture(db, "down"); assert.equal(reverted.exitCode, 1);
    assert.deepEqual((await db.query('SELECT * FROM "core"."SequelizeMeta"'))[0], meta);
    assert.deepEqual(await schema(), afterSchema); await assertPreserved(before);
  });

  await t.test("failure after real metadata INSERT rolls back DDL and metadata together; retry succeeds", async (child) => {
    await fixture(child, 1); const before = await rows();
    const failed = await migrationRunnerFixture(db, "up", { failMetaInsert: true });
    assert.equal(failed.exitCode, 1); assert.deepEqual(failed.metaTransactions, [true]);
    const after = await schema();
    assert.equal(after.columns.filter((column) => column.table_name === "RoutineExercises" && names.includes(column.name)).length, 1);
    assert.equal(after.relations.some((relation) => relation.name === "RoutineMediaCleanupJobs"), false);
    assert.equal((await db.query('SELECT * FROM "core"."SequelizeMeta"'))[0].length, 0);
    await assertPreserved(before);
    const retry = await migrationRunnerFixture(db); assert.equal(retry.exitCode, 0, JSON.stringify(retry.errors)); await assertPreserved(before);
  });
});
