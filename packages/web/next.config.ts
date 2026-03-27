import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:5003/:path*",
      },
    ];
  },
};

export default nextConfig;
