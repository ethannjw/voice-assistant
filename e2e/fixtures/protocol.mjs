import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const disposableRoot = fileURLToPath(new URL("../../.e2e/", import.meta.url));

export function record(message) {
  if (process.env.E2E_AGENT_LOG) {
    appendFileSync(process.env.E2E_AGENT_LOG, `${JSON.stringify(message)}\n`);
  }
}

export function validateWorkspace(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute cwd required");
  const relative = path.relative(disposableRoot, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Disposable cwd required");
}

export async function waitForGate() {
  while (process.env.E2E_AGENT_GATE && !existsSync(process.env.E2E_AGENT_GATE)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function applyEdit(cwd, provider) {
  validateWorkspace(cwd);
  writeFileSync(path.join(cwd, "agent-result.txt"), `implemented by ${provider}\n`);
}
