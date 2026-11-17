import { randomUUID } from "node:crypto";
import { sequelize } from "../config/sequelize.js";
import { Routine, RoutineExercise, RoutineMediaCleanupJob, User } from "../models/index.js";
import { uploadMediaBufferToCloudinary } from "../utils/cloudinaryUpload.js";
import { queueRoutineMediaCleanup, requestRoutineMediaCleanup } from "./routineMediaCleanupService.js";
import { isUuid, routineError, parseExercises, trainerEditStatus, validateVideoFile,
  validateVideoUrl, detectVideoType } from "../utils/routineValidation.js";

const include = [{ model: RoutineExercise, as: "exercises", required: false },
  { model: User, as: "trainer", attributes: ["id", "email", "role"] }];

async function withMediaTransaction(operation, incoming = []) {
  const staged = [];
  try {
    // Reserve uploads before opening the domain transaction. Doing this from
    // inside it would require another connection while holding one and could
    // exhaust the pool under concurrent uploads.
    for (const { file, resourceType } of incoming) {
      if (resourceType === "video") validateVideoFile(file);
      const folder = `titanium/routines/${resourceType === "video" ? "videos" : "images"}`;
      const publicId = `${folder}/${randomUUID()}`;
      const job = await RoutineMediaCleanupJob.create({ publicId, resourceType,
        nextAttemptAt: new Date(Date.now() + 60000) });
      staged.push({ publicId, resourceType, file, jobId: job.id, folder });
    }
    const result = await sequelize.transaction((transaction) => operation(transaction, staged));
    void requestRoutineMediaCleanup();
    return result;
  } catch (error) {
    // Newly uploaded files are disposable only if the DB has no reference.
    // The worker rechecks references even if commit acknowledgement was lost.
    for (const file of staged) {
      try { await queueRoutineMediaCleanup(file.publicId, file.resourceType, undefined, file.assetUrl); }
      catch { console.error("Could not queue uncommitted routine upload", { publicId: file.publicId, resourceType: file.resourceType }); }
    }
    if (staged.length) void requestRoutineMediaCleanup();
    throw error;
  }
}

async function upload(file, resourceType, staged, transaction) {
  if (resourceType === "video") validateVideoFile(file);
  // Persist the intended ID BEFORE contacting Cloudinary, outside the domain
  // transaction. Hold its row lock throughout upload and reference creation.
  // A crashed process rolls back the lock/deletion, leaving durable cleanup.
  const pending = staged.find((item) => item.file === file && item.resourceType === resourceType);
  if (!pending) throw routineError("Subida no reservada.", 503);
  const { folder, publicId } = pending;
  const locked = await RoutineMediaCleanupJob.findByPk(pending.jobId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!locked) throw routineError("No se pudo reservar la subida de medios.", 503);
  const result = await uploadMediaBufferToCloudinary(file.buffer, {
    folder, resourceType, publicId,
  });
  if (result.public_id !== publicId) {
    if (result.public_id) staged.push({ publicId: result.public_id, resourceType });
    throw routineError("El proveedor devolvió un identificador de medio inesperado.", 502);
  }
  pending.assetUrl = result.secure_url;
  await locked.destroy({ transaction });
  return result;
}

async function lockRoutine({ routineId, trainerId }, transaction) {
  if (!isUuid(routineId)) throw routineError("UUID de rutina inválido.");
  const routine = await Routine.findOne({ where: { id: routineId, trainerId },
    transaction, lock: transaction.LOCK.UPDATE });
  if (!routine) throw routineError("Rutina no encontrada.", 404);
  return routine;
}

function routineFields(body, current = {}) {
  const fields = {};
  for (const [key, limit] of [["title", 160], ["objective", 220], ["description", 20000]]) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== "string") throw routineError(`${key} inválido.`);
    const value = body[key]?.trim() || null;
    if ((key === "title" && !value) || value?.length > limit) throw routineError(`${key} inválido.`);
    fields[key] = value;
  }
  if (!current.id && !fields.title) throw routineError("El nombre de la rutina es obligatorio.");
  for (const [key, options, fallback] of [
    ["level", ["principiante", "intermedio", "avanzado"], "principiante"],
    ["category", ["fuerza", "hipertrofia", "perdida_peso", "resistencia", "movilidad", "general"], "general"],
  ]) {
    if (body[key] !== undefined && !options.includes(body[key])) throw routineError(`${key} inválido.`);
    if (body[key] !== undefined || !current.id) fields[key] = body[key] || fallback;
  }
  for (const [key, fallback, max] of [["durationWeeks", 4, 520], ["daysPerWeek", 3, 7], ["estimatedMinutes", 45, 1440]]) {
    if (body[key] === undefined && current.id) continue;
    const value = body[key] === undefined ? fallback : Number(body[key]);
    if (!Number.isInteger(value) || value < 1 || value > max) throw routineError(`${key} inválido.`);
    fields[key] = value;
  }
  fields.status = trainerEditStatus(current.status, body.status);
  return fields;
}

async function applyGeneralMedia(body, files, routine, transaction, staged) {
  const media = {};
  const image = files?.image?.[0];
  const video = files?.video?.[0];
  // Validate all input before any upload.
  const externalUrl = body.videoUrl ? validateVideoUrl(body.videoUrl) : null;
  if (video) validateVideoFile(video);
  if (image) {
    const result = await upload(image, "image", staged, transaction);
    media.imageUrl = result.secure_url;
    media.imagePublicId = result.public_id;
    await queueRoutineMediaCleanup(routine?.imagePublicId, "image", transaction, routine?.imageUrl);
  }
  if (video) {
    const result = await upload(video, "video", staged, transaction);
    Object.assign(media, { videoUrl: result.secure_url, videoPublicId: result.public_id, videoType: "upload" });
  } else if (externalUrl && externalUrl !== routine?.videoUrl) {
    Object.assign(media, { videoUrl: externalUrl, videoPublicId: null, videoType: detectVideoType(externalUrl) });
  } else if (body.removeVideo === true || body.removeVideo === "true") {
    Object.assign(media, { videoUrl: null, videoPublicId: null, videoType: "none" });
  }
  if ("videoUrl" in media) await queueRoutineMediaCleanup(routine?.videoPublicId, "video", transaction, routine?.videoUrl);
  return media;
}

async function syncExercises(routine, exercises, transaction) {
  const existing = await RoutineExercise.findAll({ where: { routineId: routine.id }, transaction, lock: transaction.LOCK.UPDATE });
  const byId = new Map(existing.map((exercise) => [exercise.id, exercise]));
  // Complete validation before the first mutation. Ignore media fields in this
  // contract: only the dedicated video endpoints can change exercise media.
  for (const exercise of exercises) {
    if (exercise.id && !byId.has(exercise.id)) throw routineError("El ejercicio no pertenece a esta rutina.", 400);
    if (exercise.dayNumber > routine.daysPerWeek) throw routineError("El día del ejercicio excede daysPerWeek.");
  }
  const retained = new Set(exercises.map((exercise) => exercise.id).filter(Boolean));
  for (const exercise of exercises) {
    const { id, ...fields } = exercise;
    if (id) await byId.get(id).update(fields, { transaction });
    else await RoutineExercise.create({ ...fields, routineId: routine.id }, { transaction });
  }
  for (const exercise of existing) {
    if (retained.has(exercise.id)) continue;
    await queueRoutineMediaCleanup(exercise.videoPublicId, "video", transaction, exercise.videoUrl);
    await exercise.destroy({ transaction });
  }
}

function fullRoutine(id, transaction) {
  return Routine.findByPk(id, { include, transaction });
}

export async function saveTrainerRoutine({ routineId, trainerId, body = {}, files = {} }) {
  const exercises = body.exercises === undefined ? undefined : parseExercises(body.exercises);
  return withMediaTransaction(async (transaction, staged) => {
    const current = routineId ? await lockRoutine({ routineId, trainerId }, transaction) : null;
    const fields = routineFields(body, current || {});
    if (!current && exercises?.some((exercise) => exercise.id)) throw routineError("Los ejercicios nuevos no deben incluir UUID.");
    const media = await applyGeneralMedia(body, files, current, transaction, staged);
    const routine = current
      ? await current.update({ ...fields, ...media }, { transaction })
      : await Routine.create({ ...fields, ...media, trainerId }, { transaction });
    if (exercises !== undefined) await syncExercises(routine, exercises, transaction);
    else if (current && fields.daysPerWeek !== undefined) {
      const rows = await RoutineExercise.findAll({ where: { routineId: routine.id }, transaction });
      if (rows.some((row) => row.dayNumber > routine.daysPerWeek)) throw routineError("daysPerWeek deja ejercicios fuera de rango.");
    }
    return fullRoutine(routine.id, transaction);
  }, [
    ...(files.image?.[0] ? [{ file: files.image[0], resourceType: "image" }] : []),
    ...(files.video?.[0] ? [{ file: files.video[0], resourceType: "video" }] : []),
  ]);
}

export async function changeExerciseVideo({ routineId, exerciseId, trainerId, action, file, videoUrl }) {
  if (!isUuid(exerciseId)) throw routineError("UUID de ejercicio inválido.");
  return withMediaTransaction(async (transaction, staged) => {
    const routine = await lockRoutine({ routineId, trainerId }, transaction);
    const status = trainerEditStatus(routine.status);
    const exercise = await RoutineExercise.findOne({ where: { id: exerciseId, routineId: routine.id },
      transaction, lock: transaction.LOCK.UPDATE });
    if (!exercise) throw routineError("Ejercicio no encontrado en esta rutina.", 404);
    let fields = { videoUrl: null, videoPublicId: null, videoType: "none" };
    if (action === "upload") {
      const result = await upload(file, "video", staged, transaction);
      fields = { videoUrl: result.secure_url, videoPublicId: result.public_id, videoType: "upload" };
    } else if (action === "url") {
      const url = validateVideoUrl(videoUrl);
      fields = url === exercise.videoUrl ? { videoUrl: url, videoPublicId: exercise.videoPublicId, videoType: exercise.videoType }
        : { videoUrl: url, videoPublicId: null, videoType: detectVideoType(url) };
    } else if (action !== "delete") throw routineError("Operación de video inválida.");
    if (fields.videoPublicId !== exercise.videoPublicId) await queueRoutineMediaCleanup(exercise.videoPublicId, "video", transaction, exercise.videoUrl);
    await exercise.update(fields, { transaction });
    await routine.update({ status }, { transaction });
    return fullRoutine(routine.id, transaction);
  }, action === "upload" ? [{ file, resourceType: "video" }] : []);
}

export async function removeTrainerRoutine({ routineId, trainerId }) {
  return withMediaTransaction(async (transaction) => {
    const routine = await lockRoutine({ routineId, trainerId }, transaction);
    trainerEditStatus(routine.status);
    const exercises = await RoutineExercise.findAll({ where: { routineId }, transaction, lock: transaction.LOCK.UPDATE });
    for (const exercise of exercises) {
      await queueRoutineMediaCleanup(exercise.videoPublicId, "video", transaction, exercise.videoUrl);
      await exercise.destroy({ transaction });
    }
    await queueRoutineMediaCleanup(routine.imagePublicId, "image", transaction, routine.imageUrl);
    await queueRoutineMediaCleanup(routine.videoPublicId, "video", transaction, routine.videoUrl);
    await routine.destroy({ transaction });
  });
}

export async function transitionRoutine({ routineId, trainerId, action }) {
  if (!isUuid(routineId)) throw routineError("UUID de rutina inválido.");
  return sequelize.transaction(async (transaction) => {
    const routine = trainerId
      ? await lockRoutine({ routineId, trainerId }, transaction)
      : await Routine.findByPk(routineId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!routine) throw routineError("Rutina no encontrada.", 404);
    if (["approve", "reject"].includes(action) && routine.status !== "pending_review") {
      throw routineError("La rutina debe estar pendiente de revisión.", 409);
    }
    const status = { publish: "pending_review", archive: "archived", approve: "published", reject: "rejected" }[action];
    if (!status) throw routineError("Transición inválida.");
    await routine.update({ status }, { transaction });
    return fullRoutine(routine.id, transaction);
  });
}
