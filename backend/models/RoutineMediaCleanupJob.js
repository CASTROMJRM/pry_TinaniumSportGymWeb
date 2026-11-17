import { DataTypes } from "sequelize";
import { sequelize } from "../config/sequelize.js";

export const RoutineMediaCleanupJob = sequelize.define("RoutineMediaCleanupJob", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  publicId: { type: DataTypes.STRING, allowNull: false },
  resourceType: { type: DataTypes.STRING(10), allowNull: false },
  assetUrl: { type: DataTypes.TEXT, allowNull: true },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { schema: "core", tableName: "RoutineMediaCleanupJobs", timestamps: true,
  indexes: [{ unique: true, fields: ["publicId", "resourceType"] }] });
