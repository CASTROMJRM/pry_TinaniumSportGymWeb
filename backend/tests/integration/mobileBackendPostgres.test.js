import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import { routineFixture } from "../helpers/routineFixture.js";
import { validateMobilePostgresTarget } from "../helpers/mobilePostgresTarget.js";
import { up, down } from "../../migrations/20261116000100-exercise-videos-and-media-cleanup.js";

test("mobile backend: real isolated PostgreSQL migration, routine HTTP, row locks and rollback", {
  skip: !process.env.MOBILE_TEST_DATABASE_URL, timeout: 60000,
}, async (t) => {
  const target = process.env.MOBILE_TEST_DATABASE_URL;
  validateMobilePostgresTarget(target, process.env.MOBILE_TEST_ALLOW_LOCAL_DDL);
  const db = new Sequelize(target, { dialect: "postgres", logging: false, pool: { max: 8, min: 0 },
    dialectOptions: { ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 15000 } });
  let ownSchema = false;
  t.after(async () => {
    try { if (ownSchema) await db.query('DROP SCHEMA "core" CASCADE'); } finally { await db.close(); }
  });
  const [identity] = await db.query("SELECT current_database() AS name, inet_server_addr()::text AS address, version()");
  assert.equal(identity[0].name, "titanium_mobile_test");
  assert.ok(["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(identity[0].address));
  const [schemas] = await db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core'");
  assert.equal(schemas.length, 0, "Refusing to modify an existing core schema.");
  await db.query('CREATE SCHEMA "core"'); ownSchema = true;
  // A real legacy exercise exists BEFORE up. No DROP/CREATE of domain tables.
  await db.query(`CREATE TABLE "core"."RoutineExercises" (
    "id" UUID PRIMARY KEY, "routineId" UUID NOT NULL, "name" VARCHAR(160) NOT NULL,
    "description" TEXT, "dayNumber" INTEGER NOT NULL DEFAULT 1, "sets" INTEGER, "reps" VARCHAR(60),
    "restSeconds" INTEGER, "notes" TEXT, "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const legacyId = randomUUID(), legacyRoutine = randomUUID();
  await db.query('INSERT INTO "core"."RoutineExercises" ("id", "routineId", "name") VALUES ($1, $2, $3)',
    { bind: [legacyId, legacyRoutine, "Existing PostgreSQL exercise"] });

  await t.test("up/refused-down/up preserve legacy UUID, columns and optional fields", async () => {
    await db.transaction((transaction) => up({ sequelize: db, transaction }));
    let [rows] = await db.query('SELECT * FROM "core"."RoutineExercises" WHERE "id"=$1', { bind: [legacyId] });
    assert.equal(rows[0].name, "Existing PostgreSQL exercise"); assert.equal(rows[0].videoUrl, null);
    await assert.rejects(db.transaction((transaction) => down({ sequelize: db, transaction })), /rollback refused/);
    [rows] = await db.query('SELECT * FROM "core"."RoutineExercises" WHERE "id"=$1', { bind: [legacyId] });
    assert.equal(rows[0].name, "Existing PostgreSQL exercise"); assert.equal("videoUrl" in rows[0], true);
    await db.transaction((transaction) => up({ sequelize: db, transaction }));
  });

  const f = await routineFixture({ database: db });
  // Define legacy Routines from the production model; sync only creates the
  // isolated missing table. Never sync/alter the migrated exercises or jobs.
  await f.models.Routine.sync();
  const request = await f.http(t);
  const created = await request("", { method: "POST", body: { title: "DB routine", exercises: [{ name: "A" }, { name: "B" }] } });
  assert.equal(created.status, 201); const routine = created.body.routine;
  const [a, b] = routine.exercises;

  await t.test("real HTTP diff retains UUID/video, creates new exercise, deletes only omitted row", async () => {
    await f.models.RoutineExercise.findByPk(a.id).then((row) => row.update({ videoUrl: "https://youtu.be/keep", videoType: "youtube" }));
    await f.models.RoutineExercise.findByPk(b.id).then((row) => row.update({ videoPublicId: "removed-asset", videoUrl: "https://example.com/removed.mp4", videoType: "upload" }));
    const edit = await request(`/${routine.id}`, { method: "PUT", body: { title: "DB edited", exercises: [
      { id: a.id, name: "A updated", dayNumber: 2, order: 2 }, { name: "new", dayNumber: 1, order: 0 },
    ] } });
    assert.equal(edit.status, 200); const kept = edit.body.routine.exercises.find((row) => row.id === a.id);
    assert.equal(kept.videoUrl, "https://youtu.be/keep"); assert.equal(kept.dayNumber, 2);
    assert.equal(await f.models.RoutineExercise.findByPk(b.id), null);
    assert.equal(f.deletions.length, 0); await f.cleanup.processRoutineMediaCleanup();
    assert.deepEqual(f.deletions, [{ id: "removed-asset", type: "video" }]);
    assert.equal((await f.models.RoutineExercise.findByPk(legacyId)).name, "Existing PostgreSQL exercise");
  });

  await t.test("a failure after SQL update rolls back rows and media cleanup", async () => {
    const before = await f.models.Routine.findByPk(routine.id);
    await f.models.RoutineExercise.findByPk(a.id).then((row) => row.update({ videoPublicId: "current-asset" }));
    f.models.RoutineExercise.addHook("afterUpdate", "fail-after-update", () => { throw new Error("Intentional failure after SQL"); });
    try {
      const result = await request(`/${routine.id}/exercises/${a.id}/video-url`, { method: "PATCH", body: { videoUrl: "https://youtu.be/replacement" } });
      assert.equal(result.status, 500);
    } finally { f.models.RoutineExercise.removeHook("afterUpdate", "fail-after-update"); }
    const kept = await f.models.RoutineExercise.findByPk(a.id);
    assert.equal(kept.videoPublicId, "current-asset"); assert.equal(kept.videoUrl, "https://youtu.be/keep");
    assert.equal(await f.models.RoutineMediaCleanupJob.count(), 0);
    assert.equal((await f.models.Routine.findByPk(routine.id)).status, before.status);
  });

  await t.test("upload is durably staged before provider call, row-locked until commit, and cleaned after rollback", async () => {
    let stagedId;
    f.controls.beforeUpload = async (buffer, options) => {
      stagedId = options.publicId;
      const [visible] = await db.query('SELECT "id" FROM "core"."RoutineMediaCleanupJobs" WHERE "publicId"=$1', { bind: [stagedId] });
      assert.equal(visible.length, 1, "Staging record must already be committed independently");
      await db.transaction(async (transaction) => {
        const [claimable] = await db.query('SELECT "id" FROM "core"."RoutineMediaCleanupJobs" WHERE "publicId"=$1 FOR UPDATE SKIP LOCKED', { bind: [stagedId], transaction });
        assert.equal(claimable.length, 0, "Cleanup worker cannot claim an upload in progress");
      });
    };
    f.models.RoutineExercise.addHook("afterUpdate", "fail-upload-persistence", () => { throw new Error("Intentional persistence failure"); });
    try {
      const form = new FormData();
      form.append("video", new Blob([Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])], { type: "video/mp4" }), "test.mp4");
      const result = await request(`/${routine.id}/exercises/${a.id}/video`, { method: "POST", body: form });
      assert.equal(result.status, 500);
    } finally {
      f.controls.beforeUpload = null;
      f.models.RoutineExercise.removeHook("afterUpdate", "fail-upload-persistence");
    }
    assert.equal((await f.models.RoutineExercise.findByPk(a.id)).videoPublicId, "current-asset");
    assert.ok(await f.models.RoutineMediaCleanupJob.findOne({ where: { publicId: stagedId } }));
    assert.equal(f.deletions.some((row) => row.id === stagedId), false);
    await f.cleanup.processRoutineMediaCleanup();
    assert.ok(f.deletions.some((row) => row.id === stagedId));
    assert.equal(f.deletions.some((row) => row.id === "current-asset"), false);
  });

  await t.test("concurrent edits contend on the parent row and preserve the exercise UUID", async () => {
    let unlock, locked;
    const gateReady = new Promise((resolve) => { locked = resolve; });
    const gate = db.transaction(async (transaction) => {
      await f.models.Routine.findByPk(routine.id, { transaction, lock: transaction.LOCK.UPDATE });
      locked(); await new Promise((resolve) => { unlock = resolve; });
    });
    await gateReady;
    const updates = ["first", "second"].map((name) => request(`/${routine.id}`, { method: "PUT", body: {
      title: name, exercises: [{ id: a.id, name, dayNumber: 2 }],
    } }));
    try {
      const deadline = Date.now() + 8000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const [rows] = await db.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        waiting = rows[0].count;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(waiting >= 2, "Both independent PostgreSQL sessions must wait for row locks");
    } finally { unlock(); await gate; }
    const results = await Promise.all(updates);
    assert.deepEqual(results.map((row) => row.status), [200, 200]);
    assert.equal(await f.models.RoutineExercise.count({ where: { routineId: routine.id } }), 1);
    assert.equal((await f.models.RoutineExercise.findByPk(a.id)).videoPublicId, "current-asset");
  });

  await t.test("concurrent uploads can use the full pool without requiring a spare connection", async () => {
    const routines = [];
    for (let index = 0; index < 8; index++) routines.push(await f.create({ title: `Pool ${index}` }));
    let arrived = 0, release;
    const barrier = new Promise((resolve) => { release = resolve; });
    f.controls.beforeUpload = async () => {
      arrived++;
      if (arrived === 8) release();
      let timer;
      try {
        await Promise.race([barrier, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Uploads exhausted pool before reaching provider")), 5000);
        })]);
      } finally { clearTimeout(timer); }
    };
    try {
      const results = await Promise.all(routines.map((row) => f.service.changeExerciseVideo({
        routineId: row.id, exerciseId: row.toJSON().exercises[0].id, trainerId: f.trainer.id, action: "upload",
        file: { buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), mimetype: "video/mp4", originalname: "pool.mp4" },
      })));
      assert.equal(results.length, 8); assert.equal(arrived, 8);
      assert.equal(await f.models.RoutineMediaCleanupJob.count(), 0);
    } finally { release(); f.controls.beforeUpload = null; }
  });

  await t.test("approval races with edits under the same lock; unreviewed content stays private", async () => {
    await request(`/${routine.id}/publish`, { method: "PATCH" });
    const results = await Promise.all([
      request(`/admin/routines/${routine.id}/approve`, { method: "PATCH", user: f.admin }),
      request(`/${routine.id}`, { method: "PUT", body: { title: "concurrent content", status: "published" } }),
    ]);
    assert.equal(results[0].status, 200); assert.ok([200, 409].includes(results[1].status));
    const final = await f.models.Routine.findByPk(routine.id);
    if (final.title === "concurrent content") assert.equal(final.status, "pending_review");
    else assert.equal(results[1].status, 409);
  });

  await t.test("down refuses to discard real media or queued cleanup and retains legacy data", async () => {
    await assert.rejects(db.transaction((transaction) => down({ sequelize: db, transaction })), /rollback refused/);
    assert.equal((await f.models.RoutineExercise.findByPk(a.id)).videoPublicId, "current-asset");
    assert.equal((await f.models.RoutineExercise.findByPk(legacyId)).name, "Existing PostgreSQL exercise");
    await f.cleanup.queueRoutineMediaCleanup("queued-file", "video");
    await assert.rejects(db.transaction((transaction) => down({ sequelize: db, transaction })), /rollback refused/);
    assert.equal(await f.models.RoutineMediaCleanupJob.count(), 1);
    await f.cleanup.processRoutineMediaCleanup();
    await assert.rejects(db.transaction((transaction) => down({ sequelize: db, transaction })), /rollback refused/);
    const [rows] = await db.query('SELECT "id", "name" FROM "core"."RoutineExercises" WHERE "id"=$1', { bind: [legacyId] });
    assert.equal(rows[0].name, "Existing PostgreSQL exercise");
  });
});
