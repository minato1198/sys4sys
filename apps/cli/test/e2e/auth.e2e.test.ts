import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { E2E_SCOPES, withHarness } from "./harness.js";

interface WhoAmI {
  user?: { email: string; role: string };
  email?: string;
  role?: string;
  authMethod: string;
  scopes: string[];
}

function identity(me: WhoAmI): { email: string; role: string } {
  return me.user ?? { email: me.email ?? "", role: me.role ?? "" };
}

test("live auth flow: login, token creation, token auth, revocation", async () => {
  await withHarness(
    async (h) => {
      await h.loginAdmin();
      const sessionMe = await h.runCliJson<WhoAmI>(["whoami", "--json"]);
      assert.equal(sessionMe.authMethod, "session");
      assert.equal(identity(sessionMe).email, h.adminEmail);
      assert.equal(identity(sessionMe).role, "admin");

      await access(join(h.configDir, "credentials.json"));

      const created = await h.createToken({
        name: "e2e-auth",
        scopes: E2E_SCOPES.ALL_SCOPES,
      });
      assert.match(created.token, /^s4s_/);
      assert.ok(created.prefix);

      const tokenMe = await h.runCliJson<WhoAmI>(["whoami", "--json"], {
        token: created.token,
      });
      assert.equal(tokenMe.authMethod, "token");
      assert.equal(identity(tokenMe).email, h.adminEmail);
      assert.deepEqual(tokenMe.scopes, E2E_SCOPES.ALL_SCOPES);

      const revoke = await h.runCliJson<{ revoked: boolean; id: string }>(
        ["tokens", "revoke", created.id, "--yes", "--json"],
        { token: created.token },
      );
      assert.deepEqual(revoke, { revoked: true, id: created.id });

      const revoked = await h.runCli(["whoami", "--json"], {
        token: created.token,
      });
      assert.equal(revoked.code, 3);
      assert.doesNotMatch(revoked.stdout, new RegExp(created.token));
      assert.doesNotMatch(revoked.stderr, new RegExp(created.token));
      assert.match(`${revoked.stdout}\n${revoked.stderr}`, /401|認証/);
    },
    { setupAdminToken: false },
  );
});
