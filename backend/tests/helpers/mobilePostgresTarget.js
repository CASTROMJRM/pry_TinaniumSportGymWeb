import assert from "node:assert/strict";

export function validateMobilePostgresTarget(value, allowDdl) {
  assert.equal(allowDdl, "true", "Authorize DDL only in the disposable mobile database.");
  assert.ok(value, "MOBILE_TEST_DATABASE_URL is required; application .env is never used.");
  const target = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  assert.ok(["127.0.0.1", "[::1]"].includes(target.hostname), "Only literal loopback addresses are allowed.");
  assert.equal(target.pathname, "/titanium_mobile_test");
  assert.equal(target.search, ""); assert.equal(target.hash, "");
  return target;
}
