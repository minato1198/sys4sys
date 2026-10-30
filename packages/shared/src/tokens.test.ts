import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLE_SCOPES,
  hasAllScopes,
  hasAnyScope,
  hasScope,
  intersectScopes,
  isScopeSubset,
  isScopeSubsetOf,
  scopesForRole,
  tokenCreateSchema,
  tokenScopeSchema,
} from "./tokens.js";

test("role scopes match the documented capability model", () => {
  assert.deepEqual(scopesForRole("viewer"), [
    "services:read",
    "logs:read",
    "incidents:read",
    "approvals:read",
    "hosts:read",
    "ports:read",
    "reports:read",
  ]);
  assert.deepEqual(scopesForRole("operator"), [
    "services:read",
    "services:operate",
    "deploy:execute",
    "logs:read",
    "incidents:read",
    "incidents:write",
    "approvals:read",
    "approvals:decide",
    "approvals:request",
    "hosts:read",
    "ports:read",
    "ports:operate",
    "reports:read",
  ]);
  assert.equal(ROLE_SCOPES.admin.length, 21);
  assert.ok(ROLE_SCOPES.admin.includes("tokens:manage"));
});

test("scopesForRole returns a copy", () => {
  const first = scopesForRole("viewer");
  first.push("tokens:manage");
  assert.equal(scopesForRole("viewer").includes("tokens:manage"), false);
});

test("role ceiling rejects escalation", () => {
  assert.equal(isScopeSubset(["services:read"], "viewer"), true);
  assert.equal(isScopeSubset(["services:write"], "viewer"), false);
  assert.equal(
    isScopeSubset(["services:operate", "deploy:execute"], "operator"),
    true,
  );
  assert.equal(isScopeSubset(["tokens:manage"], "operator"), false);
  assert.equal(isScopeSubset(["tokens:manage"], "admin"), true);
});

test("token scopes must be a subset of the issuing token", () => {
  const issued = ["services:read", "logs:read"] as const;
  assert.equal(isScopeSubsetOf(["services:read"], issued), true);
  assert.equal(isScopeSubsetOf(["services:read", "logs:read"], issued), true);
  assert.equal(isScopeSubsetOf(["services:write"], issued), false);
});

test("scope helpers use exact matching in P0", () => {
  const granted = ["services:read", "logs:read"] as const;
  assert.equal(hasScope(granted, "services:read"), true);
  assert.equal(hasScope(granted, "services:write"), false);
  assert.equal(hasAnyScope(granted, ["services:write", "logs:read"]), true);
  assert.equal(hasAllScopes(granted, ["services:read", "logs:read"]), true);
  assert.equal(
    hasAllScopes(granted, ["services:read", "services:write"]),
    false,
  );
  assert.deepEqual(
    intersectScopes(["services:read", "logs:read", "services:read"], granted),
    ["services:read", "logs:read"],
  );
});

test("tokenCreateSchema enforces expiry boundaries and unknown scopes", () => {
  assert.equal(
    tokenCreateSchema.parse({ name: "ci", scopes: ["services:read"] })
      .expiresInDays,
    90,
  );
  assert.equal(
    tokenCreateSchema.parse({
      name: "ci",
      scopes: ["services:read"],
      expiresInDays: 1,
    }).expiresInDays,
    1,
  );
  assert.equal(
    tokenCreateSchema.parse({
      name: "ci",
      scopes: ["services:read"],
      expiresInDays: 365,
    }).expiresInDays,
    365,
  );
  assert.throws(() =>
    tokenCreateSchema.parse({
      name: "ci",
      scopes: ["services:read"],
      expiresInDays: 0,
    }),
  );
  assert.throws(() =>
    tokenCreateSchema.parse({
      name: "ci",
      scopes: ["services:read"],
      expiresInDays: 366,
    }),
  );
  assert.throws(() => tokenCreateSchema.parse({ name: "ci", scopes: [] }));
  assert.throws(() =>
    tokenCreateSchema.parse({ name: "ci", scopes: ["unknown:scope"] }),
  );
  assert.throws(() => tokenCreateSchema.parse({ name: "", scopes: [] }));
});

test("tokenScopeSchema accepts every declared scope", () => {
  for (const scope of [
    "services:read",
    "services:write",
    "services:operate",
    "services:secrets",
    "deploy:execute",
    "logs:read",
    "logs:manage",
    "incidents:read",
    "incidents:write",
    "approvals:read",
    "approvals:decide",
    "approvals:request",
    "hosts:read",
    "hosts:write",
    "ports:read",
    "ports:operate",
    "reports:read",
    "audit:read",
    "settings:read",
    "settings:write",
    "tokens:manage",
  ]) {
    assert.equal(tokenScopeSchema.parse(scope), scope);
  }
});
