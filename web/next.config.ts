import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle so the runtime image carries only
  // what is actually reached, rather than the whole node_modules tree.
  output: "standalone",
};

export default nextConfig;
