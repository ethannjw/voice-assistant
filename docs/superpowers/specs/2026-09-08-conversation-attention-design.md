# Elva Conversation Attention

## Agreed behavior

Elva listens for context but responds only when addressed. An explicit invitation starts an exchange; clear follow-ups do not require repeating her name. Unrelated conversation, quoted mentions of Elva, and uncertain intent remain silent and cannot invoke tools or interrupt coding work. After 30 seconds without an exchange with Elva, a new invitation is required. An explicit dismissal ends the exchange. Connecting is silent. Typed messages are explicit invitations.

Zoom/Teams capture and routing Elva's audio to other call participants are deferred. This change controls responses to the audio already received by the application; it does not add call integration or speaker identification.

## Approach

Disable Realtime automatic response creation and speech-triggered interruption. For each committed audio turn, request a text-only, out-of-band attention decision on the existing Realtime connection. Override the classifier's tools with only a private, forced `attention_decision` function schema, which returns data and never executes actions. Classify the target audio item with bounded recent conversation references, the current attention state, and the last accepted exchange. Its output never enters the normal conversation or audio playback. Live evaluation showed that free-form JSON text acquired extra formatting; structured function arguments avoid relying on that formatting promise.

The application validates the decision and its request correlation before requesting an audible response. Follow-up eligibility is captured when speech starts, falling back to audio commit if no start event is available. An eligible turn can finish speaking or classification after the idle deadline without requiring another wake-up; classification still has its separate 10-second deadline. A newly accepted invitation also opens the exchange for later queued turns. A direct invitation can start a new exchange. Background speech does not renew attention. Classification errors, malformed decisions, overdue checks, and stale responses fail closed. Decisions are serialized and bounded to avoid an unbounded backlog during a busy call.

Only explicitly authorized response chains may execute tools. Tool results are correlated with their originating chain; a dismissed or superseded chain cannot spontaneously resume speaking. Ignored speech does not cancel tools or audio. Only an accepted explicit cancellation may abort coding work. Accepted speech can interrupt Elva's current reply.

Ordinary replies use the default conversation without custom input so generated calls and their results share durable conversation storage. Per-response instructions preserve the session prompt and target the accepted invitation, treating other turns as context rather than new requests. Only private classification uses bounded custom input. A tool result enters classifier context and permits continuation only after the server acknowledges its creation; rejected results cannot leave dangling item references.

## UI and timing

Show Waiting for Elva versus In conversation while connected. The initial inactivity timeout is 30 seconds. Accepted user turns and authorized assistant replies renew the window; background speech does not. Do not expire the window while authorized audio is playing. Dismissal and disconnect clear attention immediately. Reconnection cannot reuse earlier decisions.

Recording a speech-start snapshot does not itself extend the timer or interrupt audio or tools. A dismissal or replacement typed invitation invalidates previously captured follow-up eligibility; a later explicit invitation can establish a new exchange for subsequent queued turns.

## Constraints and limits

Use the configured Realtime model and connection. Add no dependencies, API keys, alternative providers, or tool installations. Keep existing workspace and Cursor/Codex behavior intact. Attention classification adds latency and model usage. Semantic decisions remain probabilistic: deterministic tests verify orchestration, not acoustic accuracy or perfect knowledge of the intended addressee. Document a small opt-in live evaluation/manual call-style check separately from the offline suite.

## Validation

Test silent connection, disabled automatic response/interrupt flags, addressed turns, name-free follow-ups, expired exchanges, quoted mentions/background decisions, dismissal, malformed/failed/timed-out classification, duplicate and stale events, reconnects, typed invitations, unauthorized tool calls, ignored interruption phrases, accepted cancellation, and tool-chain continuation. Run both typechecks, production build, and the full deterministic E2E suite. Do not call paid services in default tests.
