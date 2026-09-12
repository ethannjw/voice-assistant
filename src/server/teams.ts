import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseTeamsOptions, validateMeetingUrl } from "./meeting/options";

try {
  const options = parseTeamsOptions(process.argv.slice(2));
  if (options.help) {
    console.log("npm run teams -- [--meeting-url URL] [--workspace PATH] [--port 8787] [--name 'Elva AI assistant'] [--duration 120]\nOmit the URL to enter it interactively without saving it in shell history. Open the printed UI address and choose Join meeting. The UI must remain open for approvals and meeting control.");
  } else {
    if (!options.meetingUrl) {
      if (!stdin.isTTY) throw new Error("Supply --meeting-url or run in an interactive terminal.");
      const input = createInterface({input: stdin, output: stdout});
      try { options.meetingUrl = validateMeetingUrl(await input.question("Teams meeting URL: ")); } finally { input.close(); }
    }
    if (options.workspace) {
      const workspace = path.resolve(options.workspace);
      if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory.");
      process.env.ELVA_INITIAL_WORKSPACE = workspace;
      process.env.WORKSPACE_ROOT = workspace;
    }
    process.env.ELVA_MODE = "teams";
    process.env.ELVA_MEETING_URL = options.meetingUrl;
    process.env.ELVA_MEETING_NAME = options.name;
    process.env.ELVA_MEETING_DURATION = String(options.durationMinutes);
    if (options.port) process.env.PORT = String(options.port);
    await import("./index");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Teams startup failed.");
  process.exitCode = 1;
}
