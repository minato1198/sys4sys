# Security Policy

## Supported Versions

Only the latest commit on the `main` branch is supported with security fixes.

## Reporting a Vulnerability

Please do not open a public issue for security vulnerabilities.

Use GitHub's private vulnerability reporting from the repository's **Security** tab
(**Advisories** → **Report a vulnerability**). If private reporting is unavailable,
contact the maintainer through the contact information on the repository profile.

Please include:

- the affected version or commit
- reproduction steps
- the potential impact
- any suggested mitigation

We aim to acknowledge reports within 7 days.

## Deployment Security Notes

- Keep `HOST=127.0.0.1` unless the API is behind a TLS reverse proxy.
- Set `SESSION_SECRET` to a random value of at least 32 characters.
- Set `COOKIE_SECURE=true` when serving over HTTPS.
- Use a strong `ADMIN_PASSWORD` and change it after the first login.
- Do not expose `apps/demo-api` to untrusted networks; it is a test fixture.
- Keep dependencies updated and run `pnpm audit --prod` before releases.
- Treat service command allowlists and deploy commands as privileged operations.
- API tokens are opaque Bearer tokens stored only as SHA-256 hashes. Prefer `SYS4SYS_TOKEN` or `SYS4SYS_TOKEN_FILE` over command-line token arguments.
- CLI `credentials.json` is a local secret. Keep it outside Git, backups, logs, and shared artifacts.
- Service `env` and `deploy.env` values are encrypted with AES-256-GCM before storage and masked in normal API responses. Use `--show-env` only when an admin with `services:secrets` scope needs plaintext values for a short time.
- Deploy requests store only command/config/env hashes, not plaintext env values. Keep self-approval disabled unless an isolated single-operator environment explicitly needs it.
