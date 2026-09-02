import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run wants a self-contained server bundle.
  output: "standalone",
  /* config options here */
};

export default nextConfig;
