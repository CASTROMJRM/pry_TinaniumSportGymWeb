import { isIP } from "node:net";

export const isUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function routineError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateVideoUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\u0000-\u001f]/.test(value)) {
    throw routineError("videoUrl debe ser un enlace HTTPS público válido.");
  }
  let url;
  try { url = new URL(value); } catch { throw routineError("videoUrl inválida."); }
  const host = url.hostname.toLowerCase();
  // Links are never fetched by the backend. Exclude local/literal destinations,
  // credentials and nonstandard ports before exposing them to other clients.
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || host.endsWith(".")) {
    throw routineError("videoUrl debe usar HTTPS y un dominio público sin credenciales.");
  }
  return url.href;
}

export function detectVideoType(value) {
  if (!value) return "none";
  const host = new URL(value).hostname.toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
  if (host === "drive.google.com") return "drive";
  return "external";
}

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const videoFormats = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" };
export function validateVideoMetadata(file) {
  const extension = videoFormats[file?.mimetype];
  if (!extension || !file.originalname?.toLowerCase().endsWith(extension)) {
    throw routineError("Solo se permiten videos MP4, WEBM y MOV con formato y extensión coincidentes.");
  }
}
export function validateVideoFile(file) {
  if (!file?.buffer?.length) throw routineError("El campo video es obligatorio.");
  validateVideoMetadata(file);
  if (file.buffer.length > MAX_VIDEO_BYTES || file.size > MAX_VIDEO_BYTES) throw routineError("El video supera 100 MB.", 413);
  const buffer = file.buffer;
  const webm = buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3;
  // MP4 and modern QuickTime share the ISO BMFF ftyp header. Older MOV can
  // begin with a QuickTime atom. Cloudinary validates decoding on upload.
  const atom = buffer.length >= 12 ? buffer.toString("ascii", 4, 8) : "";
  const compatible = file.mimetype === "video/webm" ? webm :
    atom === "ftyp" || (file.mimetype === "video/quicktime" && ["moov", "mdat", "wide"].includes(atom));
  if (!compatible) throw routineError("El contenido del archivo no corresponde a un video permitido.");
}

export function parseExercises(raw) {
  let list = raw;
  try { if (typeof raw === "string") list = JSON.parse(raw); } catch { throw routineError("exercises debe contener JSON válido."); }
  if (!Array.isArray(list)) throw routineError("exercises debe ser un arreglo.");
  const ids = new Set();
  const text = (value, limit) => {
    if (value == null) return null;
    if (typeof value !== "string" || value.trim().length > limit) throw routineError("Texto de ejercicio inválido.");
    return value.trim() || null;
  };
  const integer = (value, fallback, min = 0, max = 2147483647) => {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    if (typeof value === "boolean" || !Number.isInteger(number) || number < min || number > max) throw routineError("Número de ejercicio inválido.");
    return number;
  };
  return list.map((exercise, index) => {
    if (!exercise || typeof exercise !== "object" || Array.isArray(exercise)) throw routineError("Ejercicio inválido.");
    let id;
    if (exercise.id != null && exercise.id !== "") {
      if (!isUuid(exercise.id)) throw routineError("UUID de ejercicio inválido.");
      id = exercise.id.toLowerCase();
      if (ids.has(id)) throw routineError("UUID de ejercicio duplicado.");
      ids.add(id);
    }
    const name = text(exercise.name, 160);
    if (!name) throw routineError("El nombre de cada ejercicio es obligatorio.");
    return { ...(id ? { id } : {}), name, description: text(exercise.description, 20000),
      dayNumber: integer(exercise.dayNumber, 1, 1, 7), sets: integer(exercise.sets, null),
      reps: text(exercise.reps, 60), restSeconds: integer(exercise.restSeconds, null),
      notes: text(exercise.notes, 20000), order: integer(exercise.order, index) };
  });
}

export function trainerEditStatus(current, requested) {
  if (current === "pending_review") throw routineError("La rutina está en revisión y no se puede editar.", 409);
  if (requested != null && !["draft", "pending_review", "published", "archived", "rejected"].includes(requested)) throw routineError("Estado de rutina inválido.");
  // The existing web form sends published when editing published content.
  // Every such edit requires a fresh administrative review.
  if (requested === "published" || requested === "pending_review") return "pending_review";
  if (requested === "archived") return "archived";
  if (requested === "draft") return "draft";
  if (requested === "rejected" && current !== "rejected") throw routineError("Solo un administrador puede rechazar una rutina.", 403);
  return current === "published" ? "pending_review" : current === "archived" && !requested ? "archived" : "draft";
}
