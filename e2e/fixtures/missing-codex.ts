import { CodexAppServer } from "../../src/server/codex";

process.env.PATH = "/missing-e2e-executable";
const agent = new CodexAppServer();
try {
  await agent.runTextTurn(process.cwd(), "must fail safely");
  process.exitCode = 1;
} catch (error) {
  console.log(`Handled startup failure: ${error instanceof Error ? error.message : error}`);
} finally {
  await agent.dispose();
}
