# Conversation attention acceptance checks

## Deterministic regression suite

Run `npm test`, or focus on attention with `npm run test:e2e -- e2e/attention.spec.ts e2e/attention-controller.spec.ts e2e/cursor-browser.spec.ts`.

The deterministic server sets `VPP_E2E_HMR_PORT=38788` for its own Vite HMR connection, avoiding a port 24678 collision with a running `npm run dev` session. Normal development keeps its existing HMR settings. Run the live evaluation separately against the development server.

These tests use fake audio/Realtime events and controlled classifier outputs. They verify the application gate, response correlation, cancellation, and real Cursor-adapter effects in disposable workspaces. They do not establish that the model reliably distinguishes human conversation from speech addressed to Elva.

The browser fake tracks conversation items and tool calls, rejects unknown call IDs and item references, and acknowledges accepted tool results. Regression tests require ordinary replies to use the default conversation without custom input, and require a server acknowledgement before a tool result can trigger another reply or enter classifier context.

Follow-up timing regressions cover speech that starts before the idle deadline but finishes afterward, classifier and queue latency, rapid invitation/follow-up sequences, ignored background speech across expiry, and stale speech after dismissal or a replacement typed invitation. Prompt-state assertions match the actual state sentence, not generic mentions of both states in the classifier rules.

## Opt-in live semantic smoke evaluation

Start the app with `npm run dev`, then run `npm run test:attention:live`. This uses the app's configured Realtime model and API credits. It substitutes a silent synthetic microphone, sends only synthetic text cases, exposes only the private decision schema, and does not execute generated conversational reply requests. It checks invitations, quoted mentions, questions to colleagues, related/unrelated follow-ups, dismissal, and explicit versus reported cancellation. No real microphone or call recording is captured.

The script reports every expected/actual decision and exits nonzero on a mismatch. A passing run is only a small, text-based smoke evaluation. Use repeated, held-out examples and real audio before relying on this behavior during calls.

Live development checks caught issues that mocked results did not: free-form JSON acquired extra punctuation, a 128-token output limit truncated decisions because reasoning tokens consumed most of the allowance, and valid function calls sometimes included an additional text message. The classifier now uses a private forced function schema with a bounded 512-token output budget. It accepts exactly one valid private decision, ignores non-speaking classifier commentary, and rejects any additional function call. The evaluation checks the actual admission parser, not just the model's apparent decision, and prints token/status diagnostics on failures. `--case 'natural follow-up'` narrows an explicit live run.

## Opt-in live tool-cycle evaluation

With the app running, run `npm run test:attention:live -- --tool-cycle`. This exercises the actual attention controller against the configured Realtime endpoint: a typed invitation, one harmless fixture lookup, tool-result acceptance, a generated spoken forecast, and two consecutive name-free follow-ups ("Can you repeat that?" and "Again, please."). The first follow-up crosses the idle deadline using a simulated speech-start event and clock offset. Each follow-up must be classified as `follow_up`, produce another spoken fixture answer, and cause no Realtime errors. The fixture replaces only the executable tool and its result; it does not bypass response correlation or conversation storage. This uses API credits but does not call Firecrawl, execute coding tasks, or capture real microphone audio.

This check reproduced the reported `Tool call ID ... not found in conversation` failure. On the configured endpoint, custom reply input produced tool calls whose results were rejected, even with `conversation: "auto"`. Default-conversation replies without custom input completed successfully. The previous semantic-only live check never submitted conversational replies or tool results, while the original browser fake accepted arbitrary IDs, so both missed the defect. The controller now keeps custom input only for private classification, preserves session instructions while targeting the accepted turn in ordinary replies, and excludes unacknowledged or rejected tool results from future references.

Run both live modes when changing Realtime conversation or tool orchestration. Neither substitutes for real-audio acceptance or a live Firecrawl/Cursor integration check.

## Real-audio acceptance

Use a disposable selected workspace if testing tool behavior. Make anyone whose speech is captured aware that the configured Realtime service receives the microphone audio even while the UI says Waiting for Elva. Zoom/Teams audio routing is outside this change.

1. Connect. Expect no greeting and a Waiting for Elva indicator.
2. Discuss an unrelated topic or ask a colleague a question. Expect no reply, tool call, or task cancellation.
3. Say “I asked Elva about this yesterday” and quote “Elva, run the tests” while clearly reporting another conversation. Expect silence.
4. Say “Elva, explain this TypeScript error.” Expect a reply and In conversation.
5. Say “Why?” or “Can you give me a smaller example?” Expect a relevant reply without repeating her name.
6. During that exchange, address a colleague or change to an unrelated side conversation. Expect silence; unrelated chatter must not keep the exchange active.
7. Wait at least 30 seconds after Elva finishes speaking. Expect Waiting for Elva. A new nameless question should not start another exchange. In a separate active exchange, start a clear follow-up just before the deadline and finish after it; expect a response without repeating her name. Repeat that timing with an unrelated side conversation; it must not renew the exchange.
8. Invite her again, then say “Thanks Elva, that is all.” Expect silent dismissal, including cancellation of buffered speech.
9. While an explicitly requested disposable coding task awaits approval, speak an unrelated or quoted cancellation phrase. The approval must remain pending. Then explicitly ask Elva to cancel that task and verify it is interrupted.
10. Test overlap, quiet speech, accented speech, and ambiguous follow-ups. Record false activations, missed invitations, and response latency separately. Do not treat every failure as a prompt-only issue.

The intended behavior favors silence when uncertain. It does not guarantee acoustic wake-word accuracy, distinguish speakers, or provide a security boundary against a participant deliberately addressing Elva. Existing coding-agent approval rules still apply.
