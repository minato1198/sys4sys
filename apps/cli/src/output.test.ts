import assert from "node:assert/strict";
import test from "node:test";
import { redactEnvFields } from "./output.js";

const value = {
  env: { SECRET: "top-secret" },
  deploy: {
    command: ["node", "server.js"],
    env: { TOKEN: "deploy-secret" },
  },
};

test("redacts env values by default", () => {
  const redacted = redactEnvFields(value, false);

  assert.equal(redacted.env.SECRET, "***");
  assert.equal(redacted.deploy.env.TOKEN, "***");
  assert.deepEqual(redacted.deploy.command, ["node", "server.js"]);
});

test("keeps env values when explicitly requested", () => {
  const untouched = redactEnvFields(value, true);

  assert.equal(untouched.env.SECRET, "top-secret");
  assert.equal(untouched.deploy.env.TOKEN, "deploy-secret");
});
