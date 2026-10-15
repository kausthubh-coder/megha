// Set up a fresh checkout: install dependencies from the lockfile, then pick a free port for the site.
//   node scripts/setup.mjs [--skip-install]
// Prints the PORT to use; `PORT=<n> bun run dev` starts the site on it.

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.argv.includes("--skip-install");

export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export async function freePort(start = 3000, tries = 50) {
  for (let p = start; p < start + tries; p++) if (await portIsFree(p)) return p;
  throw new Error(`no free port in ${start}-${start + tries - 1}`);
}

// Run only when executed directly (doctor.mjs imports portIsFree from here).
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/setup.mjs")) {
  if (!skipInstall) {
    console.log("bun install --frozen-lockfile");
    const r = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) { console.error("bun install failed; fix that first (is bun on PATH?)"); process.exit(1); }
  }
  const port = await freePort(Number(process.env.PORT) || 3000);
  console.log(`\nPORT=${port}`);
  console.log(`Start the site with: PORT=${port} bun run dev`);
  console.log("Check the machine with: bun run doctor");
}
