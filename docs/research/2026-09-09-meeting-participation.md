# Meeting participation research

Researched September 9, 2026; local compatibility tested September 9–10, 2026. The browser/audio probe, full application build through internal Artifactory, isolated startup, and a real Teams join/leave passed; see [the spike report](2026-09-10-attendee-local-spike.md). The join-only test stored no meeting audio or transcripts and recorded no AWS SDK attempts. Its temporary services were cleaned up. Zoom is blocked by the user's app-development permissions, and Elva's listening/speaking integration remains unimplemented. The user requires self-hosting on the local machine; Attendee remains the candidate for the first cut. Computer use is deferred. Work continues on `feat/meeting-participation` from the committed MCP baseline.

## Recommendation

Use a meeting-bot provider behind a replaceable adapter, not desktop automation. Start with a pasted meeting link and an identifiable participant named "Elva AI assistant"; the plain name passed the Teams test without bypassing name validation. Keep Elva's voice, context, and tool policy in the harness rather than replacing them with a vendor assistant.

Evaluate Attendee locally before committing to the integration. Recall remains a comparison only, not the selected deployment approach. Both document browser-hosted voice agents; neither has been benchmarked here.

## Verified options

| Option | Relevant capability | Tradeoff |
| --- | --- | --- |
| Recall Output Media | Zoom/Teams support; meeting audio becomes a webpage microphone input and webpage audio returns to the meeting. | Publicly reachable agent page; its output-media mode requires a video tile, which can show an Elva placeholder. [1] |
| Attendee | Browser voice-agent integration; bidirectional PCM WebSockets and per-participant input. Source-available/self-hosting option. | Operate the deployment when self-hosting; verify platform credentials, supported versions, resource requirements, and Elastic License 2.0 terms before commercialization. [2][3][4][12] |
| Native Teams media bot | Raw media through Microsoft's C#/.NET library. | Production requires Windows Server in Azure, not a drop-in Node/Mac component. [5] |
| Native Zoom Meeting SDK | Participant integration, with authorization requirements for external meetings. | From March 2, 2026, external-account joins require attribution: OBF for an assistant app or ZAK when joining as a user. Validate the chosen account/SDK flow. [6] |
| Zoom RTMS | Incoming meeting media streams. | Receive-only in Recall's RTMS integration, so not a complete speaking-participant solution. [7] |

Recall's separate Output Audio endpoint explicitly discourages conversational use; use its streaming Output Media path instead. [8] Attendee's managed pricing advertises five free hours, then $0.50/hour; model usage and deployment costs need separate budgeting. [9]

## Fit with the current harness

Source inspection, not graph verification: graph tools were unavailable in this session.

- `src/client/hooks/useRealtimeSession.ts`: browser microphone, WebRTC, audio playback, and attention-controller integration are candidates for reuse in a dedicated auto-start meeting page.
- `src/server/routes/realtime.ts`: existing SDP exchange is a reusable starting point; public meeting-session authentication must be separate from the current local route.
- `src/client/lib/conversationAttention.ts`: invitation-based response control needs multi-participant tests, interruption handling, and protection against treating Elva's output as a new invitation.
- `src/server/routes/mcp.ts`: preserve local-only MCP configuration and approval guards. Do not expose the entire harness through a tunnel.
- `src/server/prompts/elva.md`: keep background speech from authorizing tool execution. Meeting participants must not automatically inherit the owner's tool authority.

The browser approach is compatible in principle with OpenAI's documented WebRTC call interface. This is an integration hypothesis, not a successful end-to-end test. [10]

## Proposed first milestone, pending design approval

1. Join/leave a standard Zoom or Teams meeting by URL; show joining, lobby, connected, disconnected, and failed states.
2. Receive live audio, remain quiet until addressed, and speak replies into the meeting. Include mute/stop and prevent self-echo loops.
3. Keep local credentials and approvals private. Expose only a dedicated authenticated meeting surface, with short-lived session credentials, revocation, and session-scoped access.
4. Confirm participant notice, provider retention configuration, and which participants may request which tools. Do not promise zero retention without validating provider settings.
5. Test fixtures first, then opt-in meetings on both platforms. Measure time to join, response latency, interruption behavior, admission failures, audio feedback, and clean shutdown.

Recall documents lobby admission requirements and excludes direct Teams calls, town halls, breakout rooms, and some other meeting types. Standard meeting links are the proposed scope, not all Teams calling scenarios. [11]

Hosting decision: self-host the meeting bridge on the user's local machine. Self-hosting the bridge would not by itself make Elva's current cloud voice model local.

## Local compatibility gate

Read-only checks found an ARM64 Mac with Docker already running. Docker reports a Linux aarch64 engine, 14 CPUs, and approximately 15.6 GiB of assigned memory. These are resource assignments, not a performance benchmark or confirmed capacity for Attendee.

Attendee's current Dockerfile explicitly targets `linux/amd64` and installs AMD64 Chrome. [13] The approved emulation test passed for a reduced browser/audio image using upstream's Chrome version. The full image and isolated application startup subsequently passed, followed by a real Teams join/leave using temporary no-capture/no-cloud overrides. Python installation used internal Artifactory, including source builds. The temporary `boto3`/`botocore` upgrade to `1.35.99` remains the only dependency pin change. Earlier HTTP 403 responses did not recur; their cause is not established. TLS verification remains enabled. Native Apple Silicon operation, production browser sandboxing, and real meeting audio input/output remain unverified. See `2026-09-10-attendee-local-spike.md` for the evidence and limitations.

The documented browser voice-agent path expects HTTPS and an automatically started microphone session. [2] Do not assume an ordinary container-to-host HTTP URL will work. Validate a private trusted-HTTPS route or use the PCM WebSocket integration; do not publish the main harness or bypass its local MCP guards.

Do not install additional tools without also recording the installation or manual setup step in `/Users/nge1/myapps/set-mac-up/setup.sh`.

## Primary sources

1. Recall Output Media: https://docs.recall.ai/docs/stream-media
2. Attendee voice agents: https://docs.attendee.dev/guides/voiceagents
3. Attendee realtime audio: https://docs.attendee.dev/guides/realtimeaudio
4. Attendee platform and self-hosting overview: https://attendee.dev/
5. Microsoft application-hosted media requirements: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots
6. Zoom authorization requirements: https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/
7. Recall Zoom RTMS integration: https://docs.recall.ai/docs/meeting-direct-connect-for-zoom-rtms
8. Recall Output Audio limitations: https://docs.recall.ai/reference/bot_output_audio_create
9. Attendee pricing: https://attendee.dev/pricing
10. OpenAI WebRTC call creation: https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create
11. Recall Teams limitations: https://docs.recall.ai/docs/microsoft-teams
12. Attendee license: https://github.com/attendee-labs/attendee/blob/main/LICENSE
13. Attendee Dockerfile: https://github.com/attendee-labs/attendee/blob/main/Dockerfile
