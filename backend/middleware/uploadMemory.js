import multer from "multer";
import { MAX_VIDEO_BYTES, validateVideoMetadata } from "../utils/routineValidation.js";

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedImageTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/quicktime"];
  const allowedCsvTypes = ["text/csv", "application/vnd.ms-excel"];
  const isCsvUpload =
    file.fieldname === "file" &&
    (allowedCsvTypes.includes(file.mimetype) ||
      file.originalname?.toLowerCase().endsWith(".csv"));

  if (
    allowedImageTypes.includes(file.mimetype) ||
    allowedVideoTypes.includes(file.mimetype) ||
    isCsvUpload
  ) {
    cb(null, true);
  } else {
    cb(new Error("Tipo de archivo no permitido"), false);
  }
};

export const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
  fileFilter,
});

const exerciseVideoUpload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 0, parts: 1 },
  fileFilter(req, file, cb) {
    try { validateVideoMetadata(file); cb(null, true); } catch (error) { cb(error); }
  },
}).single("video");

export function uploadExerciseVideo(req, res, next) {
  exerciseVideoUpload(req, res, (error) => {
    if (!error) return next();
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error:
      error.code === "LIMIT_FILE_SIZE" ? "El video supera 100 MB." : "Archivo de video inválido. Usa el campo video (MP4, WEBM o MOV)." });
  });
}
