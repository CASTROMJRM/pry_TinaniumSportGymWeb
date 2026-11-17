import assert from "node:assert/strict";
import { test } from "node:test";
import { enumCheckValues, down } from "../migrations/20261116000100-exercise-videos-and-media-cleanup.js";

test("migration recognizes only the known PostgreSQL enum CHECK forms without evaluating SQL", () => {
  const definition = `CHECK ((("videoType")::text = ANY ((ARRAY['none'::character varying, 'upload'::character varying, 'youtube'::character varying, 'external'::character varying])::text[])))`;
  assert.deepEqual(enumCheckValues(definition, "videoType"), ["none", "upload", "youtube", "external"]);
  assert.deepEqual(enumCheckValues(definition + " NOT VALID", "videoType"), ["none", "upload", "youtube", "external"]);
});

test("migration never normalizes malformed literals or arbitrary CHECK expressions into a known constraint", () => {
  for (const value of ["no ne", 'no"ne', "no(ne)", "no'ne", "none\\x"]) {
    assert.equal(enumCheckValues(`CHECK (("videoType")::text = ANY (ARRAY['${value}'::text,'upload'::text,'youtube'::text,'external'::text]))`, "videoType"), null);
  }
  for (const definition of ["CHECK (my_function(\"videoType\"))", "CHECK (length(\"videoType\")<20)",
    "CHECK (\"videoType\"='none' OR true)"]) assert.equal(enumCheckValues(definition, "videoType"), null);
});

test("down refuses even an empty database without issuing DDL, DML or bookkeeping", async () => {
  let calls = 0;
  await assert.rejects(down({ sequelize: { query() { calls++; } } }), /rollback refused/);
  assert.equal(calls, 0);
});
