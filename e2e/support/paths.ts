import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const e2eRoot = path.join(repositoryRoot, ".e2e");
export const e2eWorkspace = path.join(e2eRoot, "workspace");
export const fakeCodexBinDirectory = path.join(repositoryRoot, "e2e", "fixtures", "bin");
export const fakeCursorAgentPath = path.join(fakeCodexBinDirectory, "agent");
export const cursorPromptMarkerPath = path.join(e2eRoot, "cursor-prompt-started");
export const cursorSessionMarkerPath = path.join(e2eRoot, "cursor-session-started");
export const toolTestCommandPath = path.join(
  repositoryRoot,
  "e2e",
  "fixtures",
  "tool-test-command.cjs"
);
