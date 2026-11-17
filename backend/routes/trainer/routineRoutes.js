import { Router } from "express";
import { verifyToken, authorizeRole } from "../../middleware/authMiddleware.js";
import { checkBlacklist } from "../../middleware/checkBlacklist.js";
import { upload, uploadExerciseVideo } from "../../middleware/uploadMemory.js";
import { isUuid } from "../../utils/routineValidation.js";

import {
  listTrainerRoutines,
  getTrainerRoutineById,
  createTrainerRoutine,
  updateTrainerRoutine,
  deleteTrainerRoutine,
  publishTrainerRoutine,
  archiveTrainerRoutine,
  uploadTrainerExerciseVideo,
  setTrainerExerciseVideoUrl,
  deleteTrainerExerciseVideo,
} from "../../controllers/trainerRoutineController.js";

const router = Router();

router.use(verifyToken, checkBlacklist, authorizeRole("entrenador"));
for (const name of ["id", "exerciseId"]) router.param(name, (req, res, next, value) => {
  if (!isUuid(value)) return res.status(400).json({ error: "UUID inválido." });
  next();
});

router.post("/:id/exercises/:exerciseId/video", uploadExerciseVideo, uploadTrainerExerciseVideo);
router.patch("/:id/exercises/:exerciseId/video-url", setTrainerExerciseVideoUrl);
router.delete("/:id/exercises/:exerciseId/video", deleteTrainerExerciseVideo);

router.get("/", listTrainerRoutines);

router.get("/:id", getTrainerRoutineById);

router.post(
  "/",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "video", maxCount: 1 },
  ]),
  createTrainerRoutine
);

router.put(
  "/:id",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "video", maxCount: 1 },
  ]),
  updateTrainerRoutine
);

router.delete("/:id", deleteTrainerRoutine);

router.patch("/:id/publish", publishTrainerRoutine);

router.patch("/:id/archive", archiveTrainerRoutine);

export default router;
