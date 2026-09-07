import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { e2eRoot, e2eWorkspace } from "./paths";

const execFileAsync = promisify(execFile);

await rm(e2eRoot, { recursive: true, force: true });
await mkdir(e2eWorkspace, { recursive: true });
await mkdir(path.join(e2eRoot, "no-project"), { recursive: true });

await writeFile(
  path.join(e2eWorkspace, "README.md"),
  "# E2E Workspace\n\nE2E_SEARCH_NEEDLE is present in this disposable repository.\n",
  "utf8"
);
await writeFile(path.join(e2eWorkspace, "tool-target.txt"), "baseline\n", "utf8");

await execFileAsync("git", ["init"], { cwd: e2eWorkspace });
await execFileAsync("git", ["config", "user.email", "e2e@example.test"], { cwd: e2eWorkspace });
await execFileAsync("git", ["config", "user.name", "E2E Test"], { cwd: e2eWorkspace });
await execFileAsync("git", ["add", "."], { cwd: e2eWorkspace });
await execFileAsync("git", ["commit", "-m", "test: create e2e fixture"], { cwd: e2eWorkspace });

await writeFile(path.join(e2eWorkspace, "tool-target.txt"), "baseline\nworking tree change\n", "utf8");

console.log(`Prepared disposable E2E workspace at ${e2eWorkspace}`);
