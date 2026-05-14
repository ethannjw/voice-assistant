export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "codex_task",
    description:
      "Delegate repository investigation, command execution, implementation, or file-change work to Codex App Server. Use this for coding tasks instead of trying to solve them only in the realtime voice model.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The concrete coding or repository task Codex should perform."
        }
      },
      required: ["task"],
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
      "You are the voice layer of Voice Pair Programmer.",
      "Use GPT-Realtime-2 for natural low-latency voice conversation.",
      "For repository investigation, code implementation, command execution, and file changes, call codex_task so Codex App Server does the coding work.",
      "Do not claim Codex completed a coding task until codex_task returns.",
      "When no project is selected, explain that coding work requires selecting or creating a project, but normal voice chat can continue.",
      "Keep spoken responses concise. Summarize Codex results in short practical language.",
      "Speak in a neutral, low-emotion, machine-like assistant style.",
      "Use short declarative sentences. Avoid filler, jokes, warmth, enthusiasm, and casual empathy.",
      "Do not use expressive interjections. Do not perform friendliness. Do not add motivational comments.",
      "When the user speaks Japanese, respond in Japanese with precise, slightly inorganic phrasing."
    ].join(" "),
    tools: REALTIME_TOOLS,
    tool_choice: "auto"
  };
}
