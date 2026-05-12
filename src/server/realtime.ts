export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "workspace_status",
    description: "Inspect the current git status and tracked files in the local workspace.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "search_workspace",
    description: "Search the local workspace with ripgrep. Use this before reading files.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Ripgrep search pattern."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file from the local workspace by relative path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the workspace."
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "git_diff",
    description: "Show the current unstaged git diff for the workspace.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_tests",
    description: "Run the configured project test command in the workspace.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "propose_patch",
    description:
      "Stage a unified diff for the human to review. This does not apply the patch until the user approves it in the UI.",
    parameters: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description: "A complete unified diff that can be applied with git apply."
        }
      },
      required: ["diff"],
      additionalProperties: false
    }
  }
] as const;

export function buildSessionConfig(model: string, voice: string) {
  return {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad"
        }
      },
      output: {
        voice
      }
    },
    instructions: [
      "You are a voice pair programmer connected to a local coding workspace.",
      "Prefer inspecting the repository before proposing code changes.",
      "Use read-only tools freely. For edits, call propose_patch with a unified diff and explain the intent briefly.",
      "Never claim that a patch was applied until the tool result or UI confirms it.",
      "Keep spoken responses concise. Put file paths, commands, and diffs in tool calls or short text summaries."
    ].join(" "),
    tools: REALTIME_TOOLS,
    tool_choice: "auto"
  };
}
