import type { APIRequestContext } from "@playwright/test";
import { e2eWorkspace } from "./paths";

export async function selectE2eWorkspace(request: APIRequestContext) {
  const response = await request.post("/api/projects", {
    data: { name: "E2E Workspace", path: e2eWorkspace }
  });

  if (!response.ok()) {
    throw new Error(`Failed to select E2E workspace: ${response.status()} ${await response.text()}`);
  }
}

export async function deselectWorkspace(request: APIRequestContext) {
  const response = await request.post("/api/projects/deselect");
  if (!response.ok()) {
    throw new Error(`Failed to deselect workspace: ${response.status()} ${await response.text()}`);
  }
}
