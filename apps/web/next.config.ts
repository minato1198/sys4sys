import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
    ].join("; "),
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "no-referrer",
  },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@sys4sys/shared"],
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8787/api/:path*",
      },
    ];
  },
};

export default nextConfig;
