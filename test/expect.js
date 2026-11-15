// The part of vitest's API the tests ported from layr_code use (describe, it, afterEach, expect and its matchers), on
// node:test and node:assert, so `node --test` runs them with nothing to install.
import assert from "node:assert/strict";
import { afterEach as nodeAfterEach, describe as nodeDescribe, it as nodeIt } from "node:test";

export const describe = nodeDescribe;
export const it = nodeIt;
export const afterEach = nodeAfterEach;

const ASYMMETRIC = Symbol("asymmetric");

/** Does `actual` equal `expected`, where `expected` may hold asymmetric matchers (expect.objectContaining…)? */
function equals(actual, expected) {
  if (expected && expected[ASYMMETRIC]) return expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => equals(actual[i], e));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    // undefined properties count as missing, as in vitest's toEqual.
    const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
    const [a, e] = [keys(actual), keys(expected)];
    return a.length === e.length && e.every((k) => equals(actual[k], expected[k]));
  }
  return Object.is(actual, expected);
}

/** Is `expected` (a partial object) inside `actual`, recursively? */
function matches(actual, expected) {
  if (expected && expected[ASYMMETRIC]) return expected.test(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e))
    );
  }
  if (expected && typeof expected === "object") {
    return (
      !!actual && typeof actual === "object" && Object.keys(expected).every((k) => matches(actual[k], expected[k]))
    );
  }
  return Object.is(actual, expected);
}

const show = (v) => {
  try {
    return JSON.stringify(v, (_, x) => (x && x[ASYMMETRIC] ? `<${x.name}>` : x));
  } catch {
    return String(v);
  }
};

function check(pass, negate, message) {
  if (pass === negate) assert.fail(negate ? `not: ${message}` : message);
}

function errorMatches(error, expected) {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "string") return message.includes(expected);
  return error instanceof expected;
}

function matchers(actual, negate = false) {
  return {
    toBe: (e) => check(Object.is(actual, e), negate, `expected ${show(actual)} to be ${show(e)}`),
    toEqual: (e) => check(equals(actual, e), negate, `expected ${show(actual)} to equal ${show(e)}`),
    toMatchObject: (e) => check(matches(actual, e), negate, `expected ${show(actual)} to match ${show(e)}`),
    toBeNull: () => check(actual === null, negate, `expected ${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, negate, `expected ${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, negate, "expected a value"),
    toBeGreaterThan: (n) => check(actual > n, negate, `expected ${actual} > ${n}`),
    toBeLessThan: (n) => check(actual < n, negate, `expected ${actual} < ${n}`),
    toHaveLength: (n) => check(actual?.length === n, negate, `expected length ${n}, got ${actual?.length}`),
    toContain: (e) =>
      check(
        typeof actual === "string" ? actual.includes(e) : [...actual].some((x) => Object.is(x, e)),
        negate,
        `expected ${show(actual)} to contain ${show(e)}`,
      ),
    toMatch: (re) =>
      check(
        typeof re === "string" ? actual.includes(re) : re.test(actual),
        negate,
        `expected ${show(actual)} to match ${re}`,
      ),
    toThrow: (e) => {
      let thrown;
      let threw = false;
      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      check(threw && errorMatches(thrown, e), negate, `expected a throw matching ${e}, got ${threw ? thrown : "none"}`);
    },
  };
}

export function expect(actual) {
  return {
    ...matchers(actual),
    not: matchers(actual, true),
    rejects: {
      async toThrow(e) {
        let error;
        try {
          await actual;
        } catch (err) {
          error = err ?? new Error("rejected");
        }
        if (!error) assert.fail(`expected a rejection matching ${e}`);
        if (!errorMatches(error, e)) assert.fail(`expected a rejection matching ${e}, got: ${error.message ?? error}`);
      },
    },
  };
}

const asymmetric = (name, test) => ({ [ASYMMETRIC]: true, name, test });
expect.objectContaining = (e) => asymmetric("objectContaining", (a) => matches(a, e));
expect.arrayContaining = (e) =>
  asymmetric("arrayContaining", (a) => Array.isArray(a) && e.every((x) => a.some((y) => equals(y, x))));
expect.any = (type) =>
  asymmetric("any", (a) =>
    type === String ? typeof a === "string" : type === Number ? typeof a === "number" : a instanceof type,
  );
