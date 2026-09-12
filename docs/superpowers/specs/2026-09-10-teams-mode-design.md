# Teams mode

Approved in conversation: Elva remains the same assistant, with the same project, coding tools, MCP configuration and approvals. Teams is an alternative audio transport, not a restricted assistant.

## Behavior

- Preserve `npm run dev` and local microphone/WebRTC behavior.
- Add `npm run teams -- --meeting-url URL --workspace PATH`; prompt for a URL when omitted. Never log the meeting URL or API keys. `--port` allows separate instances.
- Use the existing browser UI for project selection, tool activity, approvals and Elva's live response text. Add mode, URL and meeting status controls. Joining requires the UI to remain connected; disconnecting or closing it leaves the meeting and cancels in-flight tools.
- Share `ConversationAttention` and `useCodexToolExecution` between transports. Do not implement a second tool executor or bypass approvals. Keep provider credentials on the server.
- Teams audio flows through the pinned local Attendee container, an authenticated TLS bridge, and the configured Realtime provider. No local microphone is opened in Teams mode. Incoming meeting audio can be muted independently; generated audio returns to the bot, not the operator's speakers.
- Persist no meeting audio or transcripts by default. Live response text is generated text, not a guaranteed record of audible playback. Existing project configuration remains persistent.
- Retain disabled AWS access, disabled captions/transcription/recording persistence, visible AI identification, limited resources and scoped cleanup. Require participant consent. Meeting guests inherit the same configured tool capabilities once Elva accepts an invitation; this is not speaker authentication.

## Runtime

Ship runtime source under `integrations/attendee`, not a temporary directory. Allow a locally built image via `ATTENDEE_IMAGE`; provide pinned image-build instructions using internal Artifactory. Runtime secrets and ephemeral databases belong to a private per-call directory and unique Compose project. A default two-hour lifetime and explicit leave/watchdogs replace short experimental limits. Docker Desktop on this Mac is the validated deployment target; do not claim other operating systems verified.

## Acceptance

Offline tests cover CLI parsing/redaction, audio gating and multi-item cancellation, controller ownership/disconnect cleanup, unchanged normal mode, Teams mode without local microphone access, identical registered tools and existing tool-result/approval UI paths. Verify the packaged Docker runtime separately without joining a real meeting. Further live calls require the user's test meeting and admission; report these distinctly from deterministic tests.
