import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import vm from "node:vm";
import * as Sequelize from "sequelize";
import express from "express";
import multer from "multer";
import jwt from "jsonwebtoken";

// Never imports dotenv, application connections, production models/index or
// Cloudinary. Optional DB is explicitly supplied by the loopback-only runner.
export async function routineFixture({ database } = {}) {
  const env = { JWT_SECRET: "isolated-routine-session-key" };
  const logs = [], uploads = [], deletions = [], failNext = new Set();
  const controls = { beforeUpload: null };
  const context = vm.createContext({ process: { env }, Buffer, URL, Date, setTimeout, clearTimeout, setInterval,
    console: { log() {}, warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const names = ["Routine", "RoutineExercise", "RoutineMediaCleanupJob", "User", "Session", "UserSubscription", "MembershipPlan"];
  const tables = Object.fromEntries(names.map((name) => [name, []]));
  const models = {};
  function fail(key) { if (failNext.delete(key)) throw new Error("Injected failure " + key); }
  const matches = (row, where = {}) => Reflect.ownKeys(where).every((key) => {
    if (key === Sequelize.Op.or) return where[key].some((part) => matches(row, part));
    const value = where[key];
    if (!value || typeof value !== "object" || value instanceof Date) return row[key] === value;
    return Reflect.ownKeys(value).every((op) => op === Sequelize.Op.lte ? row[key] <= value[op] :
      op === Sequelize.Op.gte ? row[key] >= value[op] : op === Sequelize.Op.in ? value[op].includes(row[key]) : false);
  });
  for (const name of names) {
    models[name] = {
      async create(fields) {
        fail(name + ".create");
        const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(),
          ...(name === "Routine" ? { status: "draft", daysPerWeek: 3 } : {}),
          ...(name === "RoutineMediaCleanupJob" ? { attempts: 0, nextAttemptAt: new Date() } : {}), ...fields };
        Object.defineProperties(row, {
          update: { value: async (values) => { fail(name + ".update"); Object.assign(row, values); return row; } },
          destroy: { value: async () => { fail(name + ".destroy"); tables[name].splice(tables[name].indexOf(row), 1); } },
          toJSON: { value: () => ({ ...row, ...(name === "Routine" ? {
            exercises: tables.RoutineExercise.filter((value) => value.routineId === row.id).map((value) => ({ ...value })),
            trainer: tables.User.find((value) => value.id === row.trainerId),
          } : {}) }) },
        });
        tables[name].push(row); return row;
      },
      async findAll({ where } = {}) { return tables[name].filter((row) => matches(row, where)); },
      async findOne(options) { return (await this.findAll(options))[0] || null; },
      async findByPk(id, options = {}) { return this.findOne({ ...options, where: { id } }); },
      async findOrCreate({ where, defaults }) {
        const existing = await this.findOne({ where });
        return existing ? [existing, false] : [await this.create({ ...defaults, ...where }), true];
      },
      async count(options) { return (await this.findAll(options)).length; },
      async destroy(options) { for (const row of await this.findAll(options)) await row.destroy(); },
    };
  }
  let queue = Promise.resolve();
  const memoryDb = {
    transaction(operation) {
      const result = queue.then(async () => {
        const snapshot = Object.fromEntries(names.map((name) => [name, tables[name].map((row) => [row, { ...row }])]));
        try { return await operation({ LOCK: { UPDATE: "UPDATE" } }); }
        catch (error) {
          for (const name of names) tables[name] = snapshot[name].map(([row, before]) => {
            for (const key of Object.keys(row)) delete row[key]; Object.assign(row, before); return row;
          });
          throw error;
        }
      });
      queue = result.catch(() => {}); return result;
    },
  };
  const db = database || memoryDb;
  const cloud = {
    async uploadMediaBufferToCloudinary(buffer, options) {
      await controls.beforeUpload?.(buffer, options);
      fail("upload");
      const id = options.publicId || randomUUID(); uploads.push({ id, options });
      return { public_id: id, secure_url: `https://res.cloudinary.com/test/video/upload/${id}.mp4` };
    },
    async destroyCloudinaryImage(id) { fail("cleanup"); deletions.push({ id, type: "image" }); return { result: "ok" }; },
    async destroyCloudinaryVideo(id) {
      fail("cleanup");
      if (id.startsWith("titanium/routines/") && !uploads.some((row) => row.id === id)) return { result: "not found" };
      deletions.push({ id, type: "video" }); return { result: "ok" };
    },
  };
  const internal = {
    "config/sequelize.js": { sequelize: db }, "models/index.js": models,
    "models/User.js": { User: models.User }, "models/Session.js": { Session: models.Session },
    "middleware/tokenBlacklist.js": { isTokenBlacklisted: () => false },
    "utils/cloudinaryUpload.js": cloud,
  };
  const external = { sequelize: Sequelize, express: { Router: express.Router },
    multer: { default: multer }, jsonwebtoken: { default: jwt }, "node:net": net, "node:crypto": { randomUUID } };
  const base = new URL("../../", import.meta.url), cache = new Map();
  function synthetic(key, values) {
    if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context, identifier: key }));
    return cache.get(key);
  }
  async function moduleFor(url) {
    const key = url.href.slice(base.href.length);
    if (internal[key]) return synthetic(key, internal[key]);
    if (cache.has(url.href)) return cache.get(url.href);
    const module = new vm.SourceTextModule(await readFile(url, "utf8"), { context, identifier: url.href });
    cache.set(url.href, module); return module;
  }
  const linker = async (specifier, parent) => {
    if (external[specifier]) return synthetic(specifier, external[specifier]);
    assert.ok(specifier.startsWith("."), specifier);
    return moduleFor(new URL(specifier, parent.identifier));
  };
  async function load(path) {
    const module = await moduleFor(new URL(path, base));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  }
  if (database) {
    const { DataTypes } = Sequelize;
    const id = () => ({ type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true });
    models.User = database.define("User", { id: id(), email: DataTypes.STRING, role: DataTypes.STRING }, { schema: "core", tableName: "Users" });
    models.Session = database.define("Session", { id: id(), userId: DataTypes.UUID, token: DataTypes.TEXT,
      revoked: DataTypes.BOOLEAN, expiresAt: DataTypes.DATE }, { schema: "core", tableName: "sessions" });
    models.MembershipPlan = database.define("MembershipPlan", { id: id() }, { schema: "core" });
    models.UserSubscription = database.define("UserSubscription", { id: id(), userId: DataTypes.UUID,
      status: DataTypes.STRING, startsAt: DataTypes.DATEONLY, endsAt: DataTypes.DATEONLY }, { schema: "core" });
    internal["models/User.js"] = { User: models.User };
    internal["models/Session.js"] = { Session: models.Session };
    for (const name of ["Routine", "RoutineExercise", "RoutineMediaCleanupJob"]) models[name] = (await load(`models/${name}.js`))[name];
    models.Routine.hasMany(models.RoutineExercise, { foreignKey: "routineId", as: "exercises", onDelete: "CASCADE" });
    models.Routine.belongsTo(models.User, { foreignKey: "trainerId", as: "trainer" });
    models.UserSubscription.belongsTo(models.MembershipPlan, { foreignKey: "planId", as: "plan" });
  }
  const cleanup = await load("services/routineMediaCleanupService.js");
  // Tests drain explicitly so commit/rollback and retries can be observed.
  internal["services/routineMediaCleanupService.js"] = {
    queueRoutineMediaCleanup: cleanup.queueRoutineMediaCleanup, requestRoutineMediaCleanup: async () => {},
  };
  const service = await load("services/trainerRoutineMutationService.js");
  if (database) for (const name of ["User", "Session", "MembershipPlan", "UserSubscription"]) await models[name].sync();
  const trainer = await models.User.create({ email: "trainer@example.com", role: "entrenador" });
  const other = await models.User.create({ email: "other@example.com", role: "entrenador" });
  const client = await models.User.create({ email: "client@example.com", role: "cliente" });
  const admin = await models.User.create({ email: "admin@example.com", role: "administrador" });
  const app = express(); app.use(express.json());
  for (const [route, path] of [["trainer", "trainer"], ["admin", "admin"], ["client", "client"]]) {
    app.use(`/api/${path}/routines`, (await load(`routes/${route}/routineRoutes.js`)).default);
  }
  async function http(t) {
    const server = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const tokens = new Map();
    return async (path = "", { method = "GET", user = trainer, body, headers = {}, rawBody } = {}) => {
      if (user) {
        if (!tokens.has(user.id)) {
          const token = jwt.sign({ id: user.id }, env.JWT_SECRET, { expiresIn: "1h" });
          await models.Session.create({ userId: user.id, token, revoked: false, expiresAt: new Date(Date.now() + 3600000) });
          tokens.set(user.id, token);
        }
        headers = { Authorization: `Bearer ${tokens.get(user.id)}`, ...headers };
      }
      if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${/^\/(trainer|admin|client)\//.test(path) ? path.slice(1) : "trainer/routines" + path}`,
        { method, headers, body: rawBody || (body instanceof FormData ? body : body ? JSON.stringify(body) : undefined), ...(rawBody ? { duplex: "half" } : {}) });
      const result = await response.json();
      return { status: response.status, body: result };
    };
  }
  const create = (body = {}) => service.saveTrainerRoutine({ trainerId: trainer.id,
    body: { title: "Rutina aislada", exercises: [{ name: "Sentadilla", dayNumber: 1, order: 0 }], ...body } });
  return { models, tables, trainer, other, client, admin, service, cleanup, uploads, deletions, failNext, logs, http, create, load, controls };
}
