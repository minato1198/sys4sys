import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@sys4sys/shared"],
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
