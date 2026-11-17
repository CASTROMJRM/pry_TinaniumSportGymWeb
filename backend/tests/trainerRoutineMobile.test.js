import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { routineFixture } from "./helpers/routineFixture.js";
import { parseExercises, validateVideoFile, validateVideoUrl } from "../utils/routineValidation.js";

export const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
function videoForm(bytes = mp4, type = "video/mp4", name = "exercise.mp4") {
  const form = new FormData(); form.append("video", new Blob([bytes], { type }), name); return form;
}

test("exercise diff preserves UUIDs and media, creates new rows and removes only omitted rows", async () => {
  const f = await routineFixture();
  const routine = await f.create({ exercises: [{ name: "A" }, { name: "B" }] });
  const [a, b] = routine.toJSON().exercises;
  await f.models.RoutineExercise.findByPk(a.id).then((row) => row.update({ videoUrl: "https://youtu.be/keep", videoPublicId: "keep", videoType: "upload" }));
  await f.models.RoutineExercise.findByPk(b.id).then((row) => row.update({ videoUrl: "https://youtu.be/remove", videoPublicId: "remove" }));
  await f.service.saveTrainerRoutine({ routineId: routine.id, trainerId: f.trainer.id,
    body: { exercises: [{ id: a.id, name: "A edited", dayNumber: 2, order: 3, videoUrl: "https://evil.example/video" }, { name: "C", dayNumber: 1, order: 0 }] } });
  const rows = await f.models.RoutineExercise.findAll({ where: { routineId: routine.id } });
  assert.equal(rows.length, 2); assert.equal(rows[0].id, a.id); assert.equal(rows[0].name, "A edited");
  assert.equal(rows[0].dayNumber, 2); assert.equal(rows[0].order, 3); assert.equal(rows[0].videoPublicId, "keep");
  assert.equal(rows[0].videoUrl, "https://youtu.be/keep"); assert.notEqual(rows[1].id, b.id);
  assert.equal(f.deletions.length, 0); await f.cleanup.processRoutineMediaCleanup();
  assert.deepEqual(f.deletions, [{ id: "remove", type: "video" }]);
});

test("invalid JSON, foreign and duplicate UUIDs cannot erase any exercises or media", async () => {
  const f = await routineFixture(); const routine = await f.create();
  const a = routine.toJSON().exercises[0];
  const foreign = await f.models.RoutineExercise.create({ routineId: randomUUID(), name: "foreign" });
  for (const exercises of ["invalid json", {}, null, [{ id: foreign.id, name: "foreign" }],
    [{ id: a.id, name: "A" }, { id: a.id.toUpperCase(), name: "duplicate" }], [{ id: "local-1", name: "bad" }], [{ name: "" }]]) {
    await assert.rejects(f.service.saveTrainerRoutine({ routineId: routine.id, trainerId: f.trainer.id, body: { exercises } }), { statusCode: 400 });
    assert.equal((await f.models.RoutineExercise.findByPk(a.id)).name, a.name);
  }
  await f.service.saveTrainerRoutine({ routineId: routine.id, trainerId: f.trainer.id, body: { title: "Only title" } });
  assert.ok(await f.models.RoutineExercise.findByPk(a.id));
  assert.equal(f.deletions.length, 0);
});

test("failed exercise update rolls back routine, rows and cleanup jobs", async () => {
  const f = await routineFixture(); const routine = await f.create(); const a = routine.toJSON().exercises[0];
  await f.models.RoutineExercise.findByPk(a.id).then((row) => row.update({ videoPublicId: "keep" }));
  f.failNext.add("RoutineExercise.create");
  await assert.rejects(f.service.saveTrainerRoutine({ routineId: routine.id, trainerId: f.trainer.id,
    body: { title: "must roll back", exercises: [{ id: a.id, name: "changed" }, { name: "new" }] } }));
  assert.equal(routine.title, "Rutina aislada"); assert.equal((await f.models.RoutineExercise.findByPk(a.id)).name, "Sentadilla");
  assert.equal(await f.models.RoutineMediaCleanupJob.count(), 0); assert.equal(f.deletions.length, 0);
});

test("video endpoints validate ownership, multipart and return parseTrainerRoutine-compatible data", async (t) => {
  const f = await routineFixture(), request = await f.http(t);
  const routine = await f.create(), exercise = routine.toJSON().exercises[0];
  const path = `/${routine.id}/exercises/${exercise.id}`;
  for (const user of [null, f.client, f.admin, f.other]) {
    for (const [suffix, method, body] of [["video", "POST", videoForm()], ["video-url", "PATCH", { videoUrl: "https://youtu.be/example" }], ["video", "DELETE", undefined]]) {
      const result = await request(path + "/" + suffix, { method, user, body });
      assert.equal(result.status, user === null ? 401 : user === f.other ? 404 : 403);
    }
  }
  assert.equal(f.uploads.length, 0);
  const upload = await request(path + "/video", { method: "POST", body: videoForm() });
  assert.equal(upload.status, 200); assert.equal(upload.body.routine.exercises[0].id, exercise.id);
  assert.equal(upload.body.routine.exercises[0].videoType, "upload"); assert.equal(upload.body.routine.exercises[0].hasVideo, true);
  const id = f.uploads[0].id;
  const link = await request(path + "/video-url", { method: "PATCH", body: { videoUrl: "https://www.youtube.com/watch?v=demo" } });
  assert.equal(link.status, 200); assert.equal(link.body.routine.exercises[0].videoType, "youtube");
  assert.equal(f.deletions.length, 0); await f.cleanup.processRoutineMediaCleanup();
  assert.deepEqual(f.deletions, [{ id, type: "video" }]);
  const removed = await request(path + "/video", { method: "DELETE" });
  assert.equal(removed.status, 200); assert.equal(removed.body.routine.exercises[0].videoUrl, null);
  assert.equal(removed.body.routine.exercises[0].hasVideo, false);
  assert.equal((await request(`/${routine.id}/exercises/${randomUUID()}/video`, { method: "DELETE" })).status, 404);
  assert.equal((await request("/bad-id/exercises/bad-id/video", { method: "DELETE" })).status, 400);
});

test("file validation rejects spoofed content, unsupported formats, unsafe URLs and missing video", async (t) => {
  const f = await routineFixture(), request = await f.http(t), routine = await f.create();
  const path = `/${routine.id}/exercises/${routine.toJSON().exercises[0].id}`;
  for (const form of [videoForm(Buffer.from("not video")), videoForm(mp4, "image/png", "image.png"),
    videoForm(mp4, "video/mp4", "wrong.mov"), new FormData()]) {
    assert.equal((await request(path + "/video", { method: "POST", body: form })).status, 400);
  }
  for (const videoUrl of ["javascript:alert(1)", "http://youtube.com/a", "https://user:secret@youtube.com/a", "https://127.0.0.1/a", "https://[::1]/a",
    "https://2130706433/a", "https://localhost/a", "https://service.internal/a", "https://youtube.com:8443/a", "https://youtube.com/\n", "https://youtube.com\\@evil.com/a", {}, null]) {
    assert.equal((await request(path + "/video-url", { method: "PATCH", body: { videoUrl } })).status, 400, String(videoUrl));
  }
  assert.equal(f.uploads.length, 0);
  for (const [buffer, mimetype, originalname] of [[mp4, "video/mp4", "a.mp4"], [mp4, "video/quicktime", "a.mov"],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), "video/webm", "a.webm"]]) {
    validateVideoFile({ buffer, mimetype, originalname, size: buffer.length });
  }
  assert.throws(() => validateVideoFile({ buffer: mp4, mimetype: "video/mp4", originalname: "a.mp4", size: 100 * 1024 * 1024 + 1 }), { statusCode: 413 });
  assert.equal(validateVideoUrl("https://youtu.be/example"), "https://youtu.be/example");
});

test("multipart streaming enforces the 100 MB limit before calling Cloudinary", async (t) => {
  const f = await routineFixture(), request = await f.http(t), routine = await f.create();
  const boundary = "routine-test-boundary";
  async function* multipart() {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
    yield mp4;
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 101; i++) yield chunk;
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  const result = await request(`/${routine.id}/exercises/${routine.toJSON().exercises[0].id}/video`, {
    method: "POST", rawBody: Readable.from(multipart()), headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(result.status, 413); assert.equal(f.uploads.length, 0);
});

test("failed upload persistence retains current media and cleans only staged upload after rollback", async () => {
  const f = await routineFixture(), routine = await f.create(), exercise = routine.toJSON().exercises[0];
  await f.models.RoutineExercise.findByPk(exercise.id).then((row) => row.update({ videoPublicId: "original", videoUrl: "https://example.com/original.mp4", videoType: "upload" }));
  f.failNext.add("RoutineExercise.update");
  await assert.rejects(f.service.changeExerciseVideo({ routineId: routine.id, exerciseId: exercise.id, trainerId: f.trainer.id,
    action: "upload", file: { buffer: mp4, mimetype: "video/mp4", originalname: "a.mp4", size: mp4.length } }));
  assert.equal((await f.models.RoutineExercise.findByPk(exercise.id)).videoPublicId, "original");
  assert.equal(f.deletions.length, 0); await f.cleanup.processRoutineMediaCleanup();
  assert.deepEqual(f.deletions, [{ id: f.uploads[0].id, type: "video" }]);
});

test("cleanup retries provider failures, protects referenced files and handles duplicate requests", async () => {
  const f = await routineFixture(), routine = await f.create(), exercise = routine.toJSON().exercises[0];
  await f.models.RoutineExercise.findByPk(exercise.id).then((row) => row.update({ videoPublicId: "current" }));
  await f.cleanup.queueRoutineMediaCleanup("current", "video");
  await f.cleanup.processRoutineMediaCleanup(); assert.equal(f.deletions.length, 0);
  await f.cleanup.queueRoutineMediaCleanup("old", "video"); await f.cleanup.queueRoutineMediaCleanup("old", "video");
  f.failNext.add("cleanup"); await f.cleanup.processRoutineMediaCleanup();
  const job = await f.models.RoutineMediaCleanupJob.findOne({ where: { publicId: "old" } });
  assert.equal(job.attempts, 1); await job.update({ nextAttemptAt: new Date(0) });
  await f.cleanup.processRoutineMediaCleanup(); assert.deepEqual(f.deletions, [{ id: "old", type: "video" }]);
});

test("cleanup preserves an uploaded asset reused by another exercise as an external URL", async () => {
  const f = await routineFixture(), routine = await f.create();
  const url = "https://res.cloudinary.com/test/video/upload/shared.mp4";
  await f.models.RoutineExercise.create({ routineId: routine.id, name: "External reference", videoUrl: url, videoType: "external" });
  await f.cleanup.queueRoutineMediaCleanup("shared", "video", undefined, url);
  await f.cleanup.processRoutineMediaCleanup();
  assert.equal(f.deletions.length, 0); assert.equal(await f.models.RoutineMediaCleanupJob.count(), 1);
});

test("administrative approval cannot be bypassed through create, edit, video or publish", async (t) => {
  const f = await routineFixture(), request = await f.http(t);
  const created = await request("", { method: "POST", body: { title: "Web publish", status: "published", exercises: [{ name: "A" }] } });
  assert.equal(created.status, 201); assert.equal(created.body.routine.status, "pending_review");
  const routine = created.body.routine, path = `/${routine.id}`;
  assert.equal((await request(path, { method: "PUT", body: { title: "Edit in review" } })).status, 409);
  assert.equal((await request(path + `/exercises/${routine.exercises[0].id}/video-url`, { method: "PATCH", body: { videoUrl: "https://youtu.be/example" } })).status, 409);
  const approved = await request(`/admin/routines/${routine.id}/approve`, { method: "PATCH", user: f.admin });
  assert.equal(approved.status, 200); assert.equal(approved.body.routine.status, "published");
  const edit = await request(path, { method: "PUT", body: { title: "Changed published", status: "published" } });
  assert.equal(edit.body.routine.status, "pending_review");
  await request(`/admin/routines/${routine.id}/approve`, { method: "PATCH", user: f.admin });
  const video = await request(path + `/exercises/${routine.exercises[0].id}/video-url`, { method: "PATCH", body: { videoUrl: "https://youtu.be/example" } });
  assert.equal(video.body.routine.status, "pending_review");
  assert.equal((await request(`/admin/routines/${routine.id}/approve`, { method: "PATCH", user: f.trainer })).status, 403);
  await request(`/admin/routines/${routine.id}/reject`, { method: "PATCH", user: f.admin });
  assert.equal((await request(path + "/publish", { method: "PATCH" })).body.routine.status, "pending_review");
  await request(`/admin/routines/${routine.id}/archive`, { method: "PATCH", user: f.admin });
  assert.equal((await request(`/admin/routines/${routine.id}/approve`, { method: "PATCH", user: f.admin })).status, 409);
});

test("trainer/admin/client responses expose videos only with ownership, publication and subscription", async (t) => {
  const f = await routineFixture(), request = await f.http(t), routine = await f.create();
  const exercise = routine.toJSON().exercises[0];
  await f.service.changeExerciseVideo({ routineId: routine.id, exerciseId: exercise.id, trainerId: f.trainer.id,
    action: "url", videoUrl: "https://youtu.be/visible" });
  await f.service.transitionRoutine({ routineId: routine.id, trainerId: f.trainer.id, action: "publish" });
  const admin = await request("/admin/routines", { user: f.admin });
  assert.equal(admin.body.routines[0].exercises[0].videoUrl, "https://youtu.be/visible");
  assert.equal((await request("/" + routine.id, { user: f.other })).status, 404);
  assert.equal((await request(`/client/routines/${routine.id}`, { user: f.client })).status, 403);
  await f.models.UserSubscription.create({ userId: f.client.id, status: "active", startsAt: "2020-01-01", endsAt: "2099-12-31" });
  assert.equal((await request(`/client/routines/${routine.id}`, { user: f.client })).status, 404);
  await f.service.transitionRoutine({ routineId: routine.id, action: "approve" });
  const visible = await request(`/client/routines/${routine.id}`, { user: f.client });
  assert.equal(visible.status, 200); assert.equal(visible.body.routine.exercises[0].videoUrl, "https://youtu.be/visible");
  assert.equal(visible.body.routine.exercises[0].hasVideo, true);
});

test("general routine media survives rollback and deletion cleans both general and exercise files", async () => {
  const f = await routineFixture(), routine = await f.create(), exercise = routine.toJSON().exercises[0];
  await routine.update({ imagePublicId: "image", videoPublicId: "general", videoUrl: "https://example.com/general.mp4" });
  await f.models.RoutineExercise.findByPk(exercise.id).then((row) => row.update({ videoPublicId: "exercise" }));
  f.failNext.add("Routine.update");
  await assert.rejects(f.service.saveTrainerRoutine({ routineId: routine.id, trainerId: f.trainer.id,
    body: { videoUrl: "https://youtu.be/replacement" } }));
  assert.equal(routine.videoPublicId, "general"); assert.equal(await f.models.RoutineMediaCleanupJob.count(), 0);
  await f.service.removeTrainerRoutine({ routineId: routine.id, trainerId: f.trainer.id });
  assert.equal(f.deletions.length, 0); await f.cleanup.processRoutineMediaCleanup();
  assert.deepEqual(f.deletions.map((item) => item.id).sort(), ["exercise", "general", "image"]);
  assert.equal(await f.models.RoutineExercise.count(), 0);
});

test("exercise validation preserves training days and rejects invalid counts without coercing UUIDs", () => {
  for (const exercises of [[{ name: "a", dayNumber: 0 }], [{ name: "a", sets: -1 }], [{ name: "a", order: 0.1 }]]) assert.throws(() => parseExercises(exercises));
  assert.equal(parseExercises([{ name: "a", dayNumber: 7, order: 4 }])[0].dayNumber, 7);
});
