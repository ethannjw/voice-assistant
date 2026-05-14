import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_RESULTS = 100;
const SKIP_DIRECTORIES = [".git", "node_modules", "dist", "build", "Library"];
const MAX_DEPTH = 4;
const MAX_ENTRIES_PER_LEVEL = 80;

export type DiscoveredProject = { name: string; path: string };

export async function discoverRepositories(): Promise<DiscoveredProject[]> {
  const configuredRoots = String(process.env.PROJECT_SEARCH_ROOTS ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const roots = uniquePaths(configuredRoots.length ? configuredRoots : [path.dirname(process.cwd())]);
  const found = new Map<string, DiscoveredProject>();

  for (const root of roots) {
    await collectGitRepositories(root, MAX_DEPTH, found);
    if (found.size >= MAX_RESULTS) break;
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function collectGitRepositories(
  directory: string,
  depth: number,
  found: Map<string, DiscoveredProject>
) {
  if (depth < 0 || found.size >= MAX_RESULTS) return;

  let info;
  try {
    info = await stat(directory);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;

  const resolved = path.resolve(directory);
  try {
    if ((await stat(path.join(resolved, ".git"))).isDirectory()) {
      found.set(resolved, { name: path.basename(resolved), path: resolved });
      return;
    }
  } catch {
    // Continue scanning descendants.
  }

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRECTORIES.includes(entry.name))
      .slice(0, MAX_ENTRIES_PER_LEVEL)
      .map((entry) => collectGitRepositories(path.join(resolved, entry.name), depth - 1, found))
  );
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}
