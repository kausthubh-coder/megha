import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // public/setup.md is what the copied prompt points agents at. Serve it as UTF-8 text everywhere, so
  // fetch tools read it as text and browsers show it instead of downloading it. It changes with each
  // deploy, so caches revalidate after five minutes.
  headers() {
    return [
      {
        source: "/setup.md",
        headers: [
          { key: "Content-Type", value: "text/markdown; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
