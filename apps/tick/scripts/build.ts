// Build the tick CLI + library into dist/ for npm distribution.
//
//   bun run build
//
// Outputs:
//   - dist/cli.js          — bundled Node-shebanged CLI for `npx -y @frames-ag/tick`
//   - dist/types/lib.d.ts  — TypeScript declarations for programmatic consumers
//                            (matches the `types` field in package.json)
//
// During dev we still run `bun src/cli.ts mcp` directly via Bun; this script
// only matters at publish time and for npx + programmatic consumers.

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = join(OUT_DIR, "cli.js");

const SHEBANG = "#!/usr/bin/env node\n";

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/cli.ts")],
    outdir: OUT_DIR,
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "external",
    // The cli.ts file has its own `#!/usr/bin/env bun` shebang — we strip it
    // below and prepend the Node-compatible one. Bun's bundler doesn't have
    // a native banner option, so we patch after.
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // Bun writes the entrypoint to dist/cli.js automatically. Read it, strip
  // any existing shebang, prepend the Node one.
  const raw = await readFile(OUT_FILE, "utf-8");
  const stripped = raw.startsWith("#!") ? raw.slice(raw.indexOf("\n") + 1) : raw;
  const final = SHEBANG + stripped;
  await writeFile(OUT_FILE, final, "utf-8");

  // Make executable
  await chmod(OUT_FILE, 0o755);

  const sizeKb = (final.length / 1024).toFixed(1);
  console.log(`✓ Built dist/cli.js (${sizeKb} kB) — entry for \`npx -y @frames-ag/tick\``);

  // .d.ts emission for programmatic consumers (`import { curate } from "@frames-ag/tick"`).
  // Uses tsconfig.build.json which inherits skipLibCheck + types from the
  // local tsconfig and flips emit settings to declarations-only.
  const tsc = spawnSync(
    "bunx",
    ["tsc", "-p", "tsconfig.build.json"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (tsc.status !== 0) {
    console.error("✗ tsc declaration emit failed");
    process.exit(1);
  }
  console.log("✓ Emitted dist/types/lib.d.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
