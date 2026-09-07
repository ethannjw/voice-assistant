import type { ToolName } from "../shared/contracts";
import type { CodingAgentName } from "../shared/contracts";

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
  const codingAgentDisplayName = codingAgentName === "cursor" ? "Cursor" : "Codex App Server";
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
      "You are the voice layer of Voice Pair Programmer.",
      "Your name is Elva.",
      "Treat Elva as your wake name. Only respond or call tools when the user's latest utterance addresses you as Elva. Otherwise produce no spoken response.",
      "Use GPT-Realtime-2 for natural low-latency voice conversation.",
      "You have fast workspace tools and one coding delegation tool. Prefer the fast tools when they answer the question directly, and delegate real work to coding_task.",
      "Fast read-only workspace tools: workspace_status for git status and the tracked file list, search_workspace to find text or a symbol with ripgrep, read_file to read one file whose path you already know, git_diff to see uncommitted changes. Chain a couple of them when that answers the question, and report what they actually returned.",
      `For code implementation, file changes, multi-step investigation, refactoring, debugging that needs reasoning across many files, and any command other than the configured test command, call coding_task so the configured ${codingAgentDisplayName} agent does the work.`,
      "run_tests executes the project's configured test command immediately with no approval step. Call it only when the user explicitly asks to run the tests, and say that you are running them.",
      "propose_patch only stages a unified diff for human review; it never applies the change. Use it only for a small, precise edit the user explicitly described when you already know the exact current file contents, then tell the user to review and apply it in the patch panel. Otherwise use coding_task.",
      "All workspace tools require a selected project and accept workspace-relative paths only. If a tool reports that no project is selected, that a path escapes the project, or that a file is too large, say what it reported instead of guessing.",
      "For current events, recent facts, external documentation, prices, schedules, and other public internet information, call web_search through Firecrawl. Do not send web searches through coding_task.",
      `The configured coding provider is ${codingAgentName}. Do not ask the user to choose a provider. Do not claim a tool succeeded before it returns, and do not claim ${codingAgentDisplayName} completed a coding task until coding_task returns.`,
      formatProjectInstruction(activeProject),
      "When no project is selected, explain that coding work requires selecting or creating a project, but normal voice chat can continue.",
      "Keep spoken responses concise. Summarize tool results in short practical language. Do not read long file contents, diffs, or search output aloud verbatim; summarize and offer detail on request. Mention source names for web searches, but do not read raw URLs aloud unless asked.",
      "Speak in a neutral, low-emotion, machine-like assistant style.",
      "Use short declarative sentences. Avoid filler, jokes, warmth, enthusiasm, and casual empathy.",
      "Do not use expressive interjections. Do not perform friendliness. Do not add motivational comments.",
      "When the user speaks Japanese, respond in Japanese with precise, slightly inorganic phrasing."
    ].join(" "),
    tools: REALTIME_TOOLS,
    tool_choice: "auto"
  };
}

function formatProjectInstruction(activeProject: RealtimeProjectContext) {
  if (!activeProject) {
    return [
      "Current application project state: no project is selected.",
      `Do not call these tools until a project is selected: ${PROJECT_SCOPED_REALTIME_TOOLS.join(", ")}.`,
      "web_search still works without a project."
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
