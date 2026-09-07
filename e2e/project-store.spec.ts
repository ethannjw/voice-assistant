import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ProjectStore } from "../src/server/projectStore";

test("keeps the selected project after the application restarts", async ({}, testInfo) => {
  const stateRoot = testInfo.outputPath("project-store-state");
  const projectPath = path.join(stateRoot, "selected-project");
  const storePath = path.join(stateRoot, "projects.json");
  const defaultProjectPath = path.join(stateRoot, "default-project");
  await mkdir(projectPath, { recursive: true });
  await mkdir(defaultProjectPath, { recursive: true });

  const firstStore = new ProjectStore(storePath, defaultProjectPath);
  await firstStore.load();
  const selectedProject = await firstStore.addProject({
    name: "Selected project",
    path: projectPath
  });

  const restartedStore = new ProjectStore(storePath, defaultProjectPath);
  await restartedStore.load();

  expect(restartedStore.getActiveProject()).toEqual(selectedProject);
});
