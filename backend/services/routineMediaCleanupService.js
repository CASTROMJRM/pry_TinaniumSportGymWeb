import { Op } from "sequelize";
import { sequelize } from "../config/sequelize.js";
import { Routine, RoutineExercise, RoutineMediaCleanupJob } from "../models/index.js";
import { destroyCloudinaryImage, destroyCloudinaryVideo } from "../utils/cloudinaryUpload.js";

export async function queueRoutineMediaCleanup(publicId, resourceType, transaction, assetUrl = null) {
  if (!publicId) return;
  const [job] = await RoutineMediaCleanupJob.findOrCreate({ where: { publicId, resourceType },
    defaults: { nextAttemptAt: new Date(), assetUrl }, transaction });
  if (assetUrl && !job.assetUrl) await job.update({ assetUrl }, { transaction });
  if (!transaction) await job.update({ nextAttemptAt: new Date() });
}

export async function processRoutineMediaCleanup() {
  // Multiple instances claim independent jobs using PostgreSQL row locks.
  for (let i = 0; i < 20; i++) {
    const found = await sequelize.transaction(async (transaction) => {
      const job = await RoutineMediaCleanupJob.findOne({ where: { nextAttemptAt: { [Op.lte]: new Date() } },
        order: [["nextAttemptAt", "ASC"]], transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
      if (!job) return false;
      const field = job.resourceType === "video" ? "videoPublicId" : "imagePublicId";
      const urlField = job.resourceType === "video" ? "videoUrl" : "imageUrl";
      const where = { [Op.or]: [{ [field]: job.publicId }, ...(job.assetUrl ? [{ [urlField]: job.assetUrl }] : [])] };
      const inUse = await Routine.findOne({ where, transaction }) ||
        (job.resourceType === "video" && await RoutineExercise.findOne({ where, transaction }));
      try {
        if (inUse) throw new Error("Asset still referenced");
        const result = await (job.resourceType === "video" ? destroyCloudinaryVideo : destroyCloudinaryImage)(job.publicId);
        if (result && !["ok", "not found"].includes(result.result)) throw new Error("Provider refused cleanup");
        await job.destroy({ transaction });
      } catch {
        await job.update({ attempts: job.attempts + 1,
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6))) }, { transaction });
        console.warn("Routine media cleanup deferred", { jobId: job.id });
      }
      return true;
    });
    if (!found) break;
  }
}

export function requestRoutineMediaCleanup() {
  return processRoutineMediaCleanup().catch(() => console.warn("Routine media cleanup worker unavailable; jobs remain queued."));
}

let timer;
export function initializeRoutineMediaCleanupScheduler() {
  if (timer) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await requestRoutineMediaCleanup(); } finally { running = false; }
  };
  void run();
  timer = setInterval(run, 60000);
  timer.unref();
}
