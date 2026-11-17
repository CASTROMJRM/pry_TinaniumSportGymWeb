import { Op } from "sequelize";
import { Routine, RoutineExercise, User } from "../models/index.js";
import { saveTrainerRoutine, removeTrainerRoutine, changeExerciseVideo, transitionRoutine } from "../services/trainerRoutineMutationService.js";

const allowedStatuses = [
  "draft",
  "pending_review",
  "published",
  "archived",
  "rejected",
];
const allowedLevels = ["principiante", "intermedio", "avanzado"];
const allowedCategories = [
  "fuerza",
  "hipertrofia",
  "perdida_peso",
  "resistencia",
  "movilidad",
  "general",
];

const routineInclude = [
  {
    model: RoutineExercise,
    as: "exercises",
    required: false,
    order: [["dayNumber", "ASC"], ["order", "ASC"]],
  },
  {
    model: User,
    as: "trainer",
    attributes: ["id", "email", "role"],
  },
];

const normalizeText = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean.length ? clean : null;
};

const serializeRoutine = (routine) => {
  const json = routine?.toJSON ? routine.toJSON() : routine;

  const exercises = Array.isArray(json.exercises)
    ? [...json.exercises].sort((a, b) => {
        const dayDiff = Number(a.dayNumber ?? 0) - Number(b.dayNumber ?? 0);
        if (dayDiff !== 0) return dayDiff;
        return Number(a.order ?? 0) - Number(b.order ?? 0);
      })
    : [];

  return {
    ...json,
    exercises: exercises.map((exercise) => ({ ...exercise,
      videoType: exercise.videoType || "none", hasVideo: Boolean(exercise.videoUrl) })),
    trainerEmail: json.trainer?.email ?? null,
  };
};

const getTrainerId = (req) => {
  return req.user?.id;
};

const ensureTrainer = (req, res) => {
  if (!req.user || req.user.role !== "entrenador") {
    res.status(403).json({ error: "Acceso solo para entrenadores" });
    return false;
  }

  return true;
};

const findTrainerRoutine = async (req) => {
  return Routine.findOne({
    where: {
      id: req.params.id,
      trainerId: getTrainerId(req),
    },
    include: routineInclude,
  });
};

export const listTrainerRoutines = async (req, res) => {
  if (!ensureTrainer(req, res)) return;

  try {
    const trainerId = getTrainerId(req);
    const search = normalizeText(req.query.search);
    const status = normalizeText(req.query.status);
    const category = normalizeText(req.query.category);
    const level = normalizeText(req.query.level);

    const where = {
      trainerId,
    };

    if (status && allowedStatuses.includes(status)) {
      where.status = status;
    }

    if (category && allowedCategories.includes(category)) {
      where.category = category;
    }

    if (level && allowedLevels.includes(level)) {
      where.level = level;
    }

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { objective: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const routines = await Routine.findAll({
      where,
      include: routineInclude,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      routines: routines.map(serializeRoutine),
    });
  } catch (error) {
    console.error("listTrainerRoutines error:", error);
    return res.status(500).json({ error: "No se pudieron cargar las rutinas" });
  }
};

export const getTrainerRoutineById = async (req, res) => {
  if (!ensureTrainer(req, res)) return;

  try {
    const routine = await findTrainerRoutine(req);

    if (!routine) {
      return res.status(404).json({ error: "Rutina no encontrada" });
    }

    return res.json({
      routine: serializeRoutine(routine),
    });
  } catch (error) {
    console.error("getTrainerRoutineById error:", error);
    return res.status(500).json({ error: "No se pudo cargar la rutina" });
  }
};

function mutationError(res, error) {
  if (!error.statusCode) console.error("Routine mutation failed", { name: error.name });
  return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "No se pudo guardar la rutina" });
}

const saveRoutine = (creating) => async (req, res) => {
  if (!ensureTrainer(req, res)) return;
  try {
    const routine = await saveTrainerRoutine({ routineId: creating ? undefined : req.params.id,
      trainerId: getTrainerId(req), body: req.body, files: req.files });
    return res.status(creating ? 201 : 200).json({
      message: creating ? "Rutina creada correctamente" : "Rutina actualizada correctamente",
      routine: serializeRoutine(routine),
    });
  } catch (error) { return mutationError(res, error); }
};
export const createTrainerRoutine = saveRoutine(true);
export const updateTrainerRoutine = saveRoutine(false);

export const deleteTrainerRoutine = async (req, res) => {
  if (!ensureTrainer(req, res)) return;
  try {
    await removeTrainerRoutine({ routineId: req.params.id, trainerId: getTrainerId(req) });
    return res.json({ message: "Rutina eliminada correctamente" });
  } catch (error) { return mutationError(res, error); }
};

const videoMutation = (action) => async (req, res) => {
  if (!ensureTrainer(req, res)) return;
  try {
    const routine = await changeExerciseVideo({ routineId: req.params.id, exerciseId: req.params.exerciseId,
      trainerId: getTrainerId(req), action, file: req.file, videoUrl: req.body?.videoUrl });
    return res.json({ routine: serializeRoutine(routine) });
  } catch (error) { return mutationError(res, error); }
};
export const uploadTrainerExerciseVideo = videoMutation("upload");
export const setTrainerExerciseVideoUrl = videoMutation("url");
export const deleteTrainerExerciseVideo = videoMutation("delete");

const changeStatus = (action, admin = false) => async (req, res) => {
  if (admin) {
    if (req.user?.role !== "administrador") return res.status(403).json({ error: "Acceso solo para administradores" });
  } else if (!ensureTrainer(req, res)) return;
  try {
    const routine = await transitionRoutine({ routineId: req.params.id,
      trainerId: admin ? undefined : getTrainerId(req), action });
    const messages = { publish: "Rutina enviada a revisión del administrador", archive: "Rutina archivada correctamente",
      approve: "Rutina aprobada y publicada correctamente", reject: "Rutina rechazada correctamente" };
    return res.json({ ok: true, message: messages[action], routine: serializeRoutine(routine) });
  } catch (error) { return mutationError(res, error); }
};
export const publishTrainerRoutine = changeStatus("publish");
export const archiveTrainerRoutine = changeStatus("archive");
export const approveAdminRoutine = changeStatus("approve", true);
export const rejectAdminRoutine = changeStatus("reject", true);
export const archiveAdminRoutine = changeStatus("archive", true);

export const publicTrainerRoutine = async (req, res) => {
  try {
    const search = normalizeText(req.query.search);
    const category = normalizeText(req.query.category);
    const level = normalizeText(req.query.level);

    const where = {
      status: "published",
    };

    if (category && allowedCategories.includes(category)) {
      where.category = category;
    }

    if (level && allowedLevels.includes(level)) {
      where.level = level;
    }

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { objective: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const routines = await Routine.findAll({
      where,
      include: routineInclude,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      ok: true,
      routines: routines.map(serializeRoutine),
      activeSubscription: req.activeSubscription ?? null,
    });
  } catch (error) {
    console.error("publicTrainerRoutine error:", error);

    return res.status(500).json({
      ok: false,
      error: "No se pudieron cargar las rutinas disponibles",
    });
  }
};

export const getPublicTrainerRoutineById = async (req, res) => {
  try {
    const routine = await Routine.findOne({
      where: {
        id: req.params.id,
        status: "published",
      },
      include: routineInclude,
    });

    if (!routine) {
      return res.status(404).json({
        ok: false,
        error: "Rutina no encontrada o no disponible",
      });
    }

    return res.json({
      ok: true,
      routine: serializeRoutine(routine),
      activeSubscription: req.activeSubscription ?? null,
    });
  } catch (error) {
    console.error("getPublicTrainerRoutineById error:", error);

    return res.status(500).json({
      ok: false,
      error: "No se pudo cargar la rutina",
    });
  }
};
export const listAdminRoutinesForReview = async (req, res) => {
  try {
    const search = normalizeText(req.query.search);
    const status = normalizeText(req.query.status) || "pending_review";
    const category = normalizeText(req.query.category);
    const level = normalizeText(req.query.level);

    const where = {};

    if (status !== "all") {
      where.status = status;
    }

    if (category && allowedCategories.includes(category)) {
      where.category = category;
    }

    if (level && allowedLevels.includes(level)) {
      where.level = level;
    }

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { objective: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const routines = await Routine.findAll({
      where,
      include: routineInclude,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      ok: true,
      routines: routines.map(serializeRoutine),
    });
  } catch (error) {
    console.error("listAdminRoutinesForReview error:", error);

    return res.status(500).json({
      ok: false,
      error: "No se pudieron cargar las rutinas para revisión",
    });
  }
};
