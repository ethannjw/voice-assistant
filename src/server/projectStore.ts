import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../shared/contracts";

type ProjectStoreFile = {
  activeProjectId: string;
  projects: ProjectConfig[];
};

export class ProjectStore {
  private activeProjectId = "";
  private projects: ProjectConfig[] = [];

  constructor(
    private readonly filePath: string,
    private readonly defaultProjectPath: string
  ) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as ProjectStoreFile;
      this.projects = parsed.projects.map(normalizeProject);
      this.projects = await filterExistingProjects(this.projects);
      this.activeProjectId = "";
    } catch {
      this.projects = [];
      this.activeProjectId = "";
      await this.save();
    }

    this.removeAutoCreatedDefaultProject();

    if (!this.projects.some((project) => project.id === this.activeProjectId)) {
      this.activeProjectId = "";
      await this.save();
    }

    await this.save();
  }

  listProjects() {
    return [...this.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  getActiveProject() {
    const project = this.projects.find((candidate) => candidate.id === this.activeProjectId);
    return project ?? null;
  }

  async addProject(input: { name?: unknown; path?: unknown }) {
    const projectPath = await validateProjectPath(input.path);
    const name = String(input.name ?? "").trim() || defaultName(projectPath);
    const existing = this.projects.find((project) => project.path === projectPath);
    const now = new Date().toISOString();

    if (existing) {
      existing.name = name;
      existing.lastOpenedAt = now;
      this.activeProjectId = existing.id;
      await this.save();
      return existing;
    }

    const project = createProject(name, projectPath, now);
    this.projects.push(project);
    this.activeProjectId = project.id;
    await this.save();
    return project;
  }

  async clearActiveProject() {
    this.activeProjectId = "";
    await this.save();
  }

  async selectProject(id: string) {
    const project = this.projects.find((candidate) => candidate.id === id);
    if (!project) {
      throw new Error(`Unknown project id: ${id}`);
    }

    await validateProjectPath(project.path);
    project.lastOpenedAt = new Date().toISOString();
    this.activeProjectId = project.id;
    await this.save();
    return project;
  }

  private async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: ProjectStoreFile = {
      activeProjectId: this.activeProjectId,
      projects: this.projects
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private removeAutoCreatedDefaultProject() {
    const autoPaths = [path.resolve(this.defaultProjectPath), process.cwd()];
    const project = this.projects[0];
    const isAutoCreatedDefault =
      project &&
      autoPaths.some((autoPath) => project.path === autoPath && project.name === defaultName(autoPath));

    if (this.projects.length === 1 && isAutoCreatedDefault) {
      this.projects = [];
      this.activeProjectId = "";
    }
  }
}

async function validateProjectPath(input: unknown) {
  const rawPath = String(input ?? "").trim();
  if (!rawPath) {
    throw new Error("Project path is required.");
  }

  const projectPath = path.resolve(rawPath);
  const info = await stat(projectPath);
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory.");
  }

  return projectPath;
}

function createProject(name: string, projectPath: string, now: string): ProjectConfig {
  return {
    id: randomUUID(),
    name,
    path: path.resolve(projectPath),
    lastOpenedAt: now
  };
}

function normalizeProject(project: ProjectConfig): ProjectConfig {
  return {
    ...project,
    name: project.name || defaultName(project.path),
    path: path.resolve(project.path),
    lastOpenedAt: project.lastOpenedAt || new Date().toISOString()
  };
}

function defaultName(projectPath: string) {
  return path.basename(path.resolve(projectPath)) || projectPath;
}

async function filterExistingProjects(projects: ProjectConfig[]) {
  const checked = await Promise.all(
    projects.map(async (project) => {
      try {
        await validateProjectPath(project.path);
        return project;
      } catch {
        return null;
      }
    })
  );

  return checked.filter((project): project is ProjectConfig => Boolean(project));
}
