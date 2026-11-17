import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import * as Sequelize from "sequelize";
import { migrationName } from "../../migrations/20261116000100-exercise-videos-and-media-cleanup.js";

// Execute the actual CLI/runner with a supplied isolated DB and only the
// selected migration visible. No dotenv, application connections or Neon.
export async function migrationRunnerFixture(database, command = "up", { failMetaInsert = false } = {}) {
  const processState = { argv: ["node", "migrate.js", command], exitCode: 0 };
  const logs = [], errors = [], metaTransactions = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const realInterface = database.getQueryInterface();
  const queryInterface = new Proxy(realInterface, { get(target, key) {
    if (key === "bulkInsert") return async (...args) => {
      metaTransactions.push(Boolean(args[2]?.transaction));
      const result = await target.bulkInsert(...args);
      if (failMetaInsert) throw new Error("Injected failure after real SequelizeMeta INSERT");
      return result;
    };
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  const supplied = new Proxy(database, { get(target, key) {
    if (key === "close") return async () => finish();
    if (key === "getQueryInterface") return () => queryInterface;
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  const context = vm.createContext({ process: processState, Date, console: {
    log: (...args) => logs.push(args), error: (...args) => errors.push(args),
  } });
  const sourceUrl = new URL("../../scripts/migrate.js", import.meta.url);
  const source = new vm.SourceTextModule(await fs.readFile(sourceUrl, "utf8"), { context,
    initializeImportMeta(meta) { meta.url = sourceUrl.href; },
    importModuleDynamically(specifier) { return import(specifier); },
  });
  const modules = {
    "fs/promises": { default: { ...fs, readdir: async () => [migrationName] } },
    path: { default: path }, url, sequelize: Sequelize,
    "../config/sequelize.js": { sequelize: supplied, sequelizeAdminDirect: supplied },
  };
  await source.link((specifier) => {
    const values = modules[specifier]; assert.ok(values, specifier);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await source.evaluate(); await completed;
  return { exitCode: processState.exitCode, logs, errors, metaTransactions };
}
