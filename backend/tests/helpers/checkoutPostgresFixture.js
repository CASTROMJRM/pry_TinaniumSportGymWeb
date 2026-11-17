import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as crypto from "node:crypto";
import * as Sequelize from "sequelize";
import * as mercadoPago from "mercadopago";
import jwt from "jsonwebtoken";

export async function checkoutPostgresFixture(database) {
  const env = { MERCADOPAGO_ACCESS_TOKEN: "TEST-isolated-no-provider-network", MERCADOPAGO_WEBHOOK_SECRET: "isolated-test-webhook-key",
    JWT_SECRET: "isolated-test-only", FRONTEND_URL: "https://web.example.test", BACKEND_PUBLIC_URL: "https://api.example.test" };
  const context = vm.createContext({ process: { env }, console, Date, Buffer, URL, setTimeout, clearTimeout });
  const base = new URL("../../", import.meta.url), cache = new Map();
  const external = { sequelize: Sequelize, "node:crypto": crypto, mercadopago: mercadoPago, jsonwebtoken: { default: jwt } };
  function synthetic(key, values) {
    if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context, identifier: key }));
    return cache.get(key);
  }
  async function moduleFor(url) {
    if (url.href === new URL("config/sequelize.js", base).href) return synthetic("isolated-db", { sequelize: database });
    if (cache.has(url.href)) return cache.get(url.href);
    const module = new vm.SourceTextModule(await readFile(url, "utf8"), { context, identifier: url.href });
    cache.set(url.href, module); return module;
  }
  const linker = async (specifier, parent) => {
    if (external[specifier]) return synthetic(specifier, external[specifier]);
    assert.ok(specifier.startsWith("."), "Unexpected dependency " + specifier);
    return moduleFor(new URL(specifier, parent.identifier));
  };
  async function load(path) {
    const module = await moduleFor(new URL(path, base));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  }
  const models = await load("models/index.js");
  const service = await load("services/mercadoPagoCheckoutService.js");
  return { models, service, env, load };
}
