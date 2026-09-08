import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolName } from "../shared/contracts";
import type { CodingAgentName } from "../shared/contracts";

const ELVA_PROMPT = readFileSync(
  fileURLToPath(new URL("./prompts/elva.md", import.meta.url)),
  "utf8"
).trim();

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "coding_task",
    description:
      "Delegate repository investigation, command execution, implementation, or file-change work to the configured coding agent. Use this for coding tasks instead of trying to solve them only in the realtime voice model.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The concrete coding or repository task the configured coding agent should perform."
        }
      },
      required: ["task"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "workspace_status",
    description:
      "Report the selected project's git status and tracked file list. Read-only and fast. Use it to answer questions such as what changed, whether the tree is clean, or which files exist. Requires a selected project.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "search_workspace",
    description:
      "Search the selected project's files for a text pattern with ripgrep and return matching lines with their file paths and line numbers. Read-only and fast. Use it to locate a symbol, string, or config value. Requires a selected project and ripgrep on PATH.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The literal text or regular expression to search for in the project."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "read_file",
    description:
      "Read one text file from the selected project and return its contents. Read-only, reads exactly one file, and accepts workspace-relative paths only. Requires a selected project. Large files are rejected, so narrow the request or use search_workspace first.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative path to a single file inside the selected project, for example src/server/index.ts. Absolute paths and paths outside the project are rejected."
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "git_diff",
    description:
      "Return the selected project's uncommitted working-tree diff. Read-only. Use it to answer what has changed but is not yet committed. Requires a selected project.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_tests",
    description:
      "Run the project's configured test command in the selected project and return its output. This executes a real command immediately with no approval step, so call it only when the user explicitly asks to run the tests. Requires a selected project.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "propose_patch",
    description:
      "Stage a unified diff for human review in the patch panel. It is never applied automatically; the user must press APPLY. Use it only for a small, precise change the user explicitly described, and only when you already know the exact current file contents. For anything larger, multi-file, or requiring investigation, use coding_task instead.",
    parameters: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description:
            "A complete unified diff that applies cleanly with `git apply` against the selected project, including the diff --git header, file paths, and hunk headers."
        }
      },
      required: ["diff"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the public web through Firecrawl for current or external information. Use this directly for recent facts, news, documentation, prices, schedules, and other information that may have changed.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused web search query containing the information the user needs."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
] as const;

export type RealtimeToolName = (typeof REALTIME_TOOLS)[number]["name"];

/**
 * Compile-time guarantee that every workspace tool in `WORKSPACE_TOOL_NAMES` is exposed to the
 * realtime model. Adding a tool to the shared contract without registering it here fails typecheck.
 */
type UnexposedWorkspaceTool = Exclude<ToolName, RealtimeToolName>;
const _everyWorkspaceToolIsExposed: UnexposedWorkspaceTool extends never ? true : never = true;
void _everyWorkspaceToolIsExposed;

/** Workspace tools need a selected project; they are withheld from the model until one exists. */
export const PROJECT_SCOPED_REALTIME_TOOLS = [
  "coding_task",
  "workspace_status",
  "search_workspace",
  "read_file",
  "git_diff",
  "run_tests",
  "propose_patch"
] as const;

export type RealtimeProjectContext = {
  name: string;
  path: string;
} | null;

/**
 * `session.update` payload sent over the data channel right after it opens.
 *
 * The same config is already attached to the SDP exchange, but not every Realtime endpoint
 * (notably relays/gateways in front of the API) applies the multipart `session` part. Re-sending
 * it on the data channel is idempotent and guarantees tools + instructions are registered.
 * `model` is omitted: it selects the endpoint at call creation and is not updatable mid-session.
 */
export function buildSessionUpdate(
  model: string,
  voice: string,
  activeProject: RealtimeProjectContext,
  codingAgentName: CodingAgentName = "cursor"
) {
  const { model: _model, ...session } = buildSessionConfig(
    model,
    voice,
    activeProject,
    codingAgentName
  );
  return { type: "session.update", session };
}

export function buildSessionConfig(
  model: string,
  voice: string,
  activeProject: RealtimeProjectContext,
  codingAgentName: CodingAgentName = "cursor"
) {
  return {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true
        }
      },
      output: {
        voice
      }
    },
    instructions: [
      ELVA_PROMPT,
      formatCodingAgentInstruction(codingAgentName),
      formatProjectInstruction(activeProject)
    ].join("\n\n"),
    tools: REALTIME_TOOLS,
    tool_choice: "auto"
  };
}

function formatCodingAgentInstruction(codingAgentName: CodingAgentName) {
  const displayName = codingAgentName === "cursor" ? "Cursor" : "Codex App Server";
  return [
    `Current coding provider: ${codingAgentName}.`,
    `coding_task delegates work to ${displayName}. Do not ask the user to choose a provider.`,
    `Do not claim a tool succeeded before it returns, and do not claim ${displayName} completed a coding task until coding_task returns.`
  ].join(" ");
}

function formatProjectInstruction(activeProject: RealtimeProjectContext) {
  if (!activeProject) {
    return [
      "Current application project state: no project is selected.",
      `Do not call these tools until a project is selected: ${PROJECT_SCOPED_REALTIME_TOOLS.join(", ")}.`,
      "web_search still works without a project.",
      "If the user requests coding work, briefly explain that selecting or creating a project is required while normal voice chat can continue. Do not repeat this unless it is relevant to a new request."
    ].join(" ");
  }

  return [
    "Current application project state: a project is selected.",
    `Selected project name: ${activeProject.name}.`,
    `Selected project path: ${activeProject.path}.`,
    "For repository-specific requests, assume this selected project is available and use the workspace tools or coding_task. Do not say no project is selected.",
    "Pass every tool path relative to the selected project path, not as an absolute path."
  ].join(" ");
}
