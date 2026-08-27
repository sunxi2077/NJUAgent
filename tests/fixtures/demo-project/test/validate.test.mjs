import assert from "node:assert/strict";
import { parsePort } from "../src/validate.mjs";

assert.equal(parsePort("8080"), 8080);
assert.equal(parsePort("0"), 0);
assert.throws(() => parsePort("abc"));
assert.throws(() => parsePort("70000"));
console.log("all tests passed");
