import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMobilePostgresTarget } from "./helpers/mobilePostgresTarget.js";

test("mobile integration database requires explicit loopback-only disposable target and DDL opt-in", () => {
  const valid = "postgresql://mobile_test@127.0.0.1:55439/titanium_mobile_test";
  assert.equal(validateMobilePostgresTarget(valid, "true").hostname, "127.0.0.1");
  for (const value of [undefined, "postgresql://user@production.neon.tech/titanium_mobile_test", valid.replace("127.0.0.1", "localhost"),
    valid.replace("titanium_mobile_test", "production"), valid + "?host=production.neon.tech", valid + "#x"]) {
    assert.throws(() => validateMobilePostgresTarget(value, "true"));
  }
  assert.throws(() => validateMobilePostgresTarget(valid, undefined));
});
