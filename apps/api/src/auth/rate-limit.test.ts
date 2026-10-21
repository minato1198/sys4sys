import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  checkLoginRate,
  clearLoginFailures,
  recordLoginFailure,
  resetRateLimitStoreForTests,
} from "./rate-limit.js";

describe("login rate limit", () => {
  beforeEach(() => resetRateLimitStoreForTests());

  it("blocks after the configured number of failures", () => {
    for (let attempt = 0; attempt < config.LOGIN_MAX_ATTEMPTS; attempt += 1) {
      expect(checkLoginRate("127.0.0.1|user@example.com").allowed).toBe(true);
      recordLoginFailure("127.0.0.1|user@example.com");
    }

    const result = checkLoginRate("127.0.0.1|user@example.com");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBeGreaterThan(0);
  });

  it("clears the bucket after a successful login", () => {
    recordLoginFailure("key");
    clearLoginFailures("key");

    expect(checkLoginRate("key").allowed).toBe(true);
  });

  it("keeps buckets independent", () => {
    recordLoginFailure("first");
    expect(checkLoginRate("first").allowed).toBe(true);
    expect(checkLoginRate("second").allowed).toBe(true);
  });
});
