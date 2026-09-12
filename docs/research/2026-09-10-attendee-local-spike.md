# Attendee local compatibility spike

Tested September 9–10, 2026 on the user's ARM64 Mac. This is a throwaway feasibility experiment, not a meeting integration or production deployment.

## Verdict

**Feasible as a local POC: startup, Teams join/leave, and two completed spoken replies are verified.** The application image built through internal Artifactory in 300 seconds; migrations, Django checks, focused upstream tests, native media imports, application/streamer readiness, and a Celery worker passed. A separate temporary bridge subsequently streamed Teams audio to Elva's configured Realtime provider and played responses through the bot's virtual microphone. A third response exposed a multi-audio-item handling defect and stopped the test safely; the subsequent fix passes focused regressions but still needs another meeting-level test. Local persistence counters and AWS SDK attempts remained zero, and cleanup completed. Main-app integration is not implemented. The temporary `boto3`/`botocore` upgrade to `1.35.99` remains the only dependency pin change. Zoom remains blocked by the user's app-development permissions.

Do not interpret the browser probe as a successful Zoom/Teams call, an Elva integration, or a latency/reliability benchmark.

## Scope and isolation

- Branch: `feat/meeting-participation`; application source unchanged.
- Upstream: `attendee-labs/attendee`, commit `31ebd91f3a318ac4bc266240b8fef3f26bec333a`.
- Docker reports Linux aarch64, 14 CPUs, and approximately 15.6 GiB assigned memory.
- Temporary experiment directory: `/private/tmp/elva-attendee-spike.HgqSzv`.
- Probe image: `elva-attendee-browser-spike:31ebd91`.
- Full image: `elva-attendee-spike:31ebd91`; build completed with exit status 0.
- Probe container: non-root, 4 CPUs, 4 GiB memory, 512 MiB shared memory, all capabilities dropped, no new privileges, no external network, no host mounts, and a 110-second timeout.
- The reduced browser probe and startup tests used no real microphone, desktop, meeting URL, account credentials, or paid model requests. Join-only tests use the user-supplied meeting link; the later audio POC additionally uses Elva's existing configured Realtime provider with the user's consent. Unrelated containers were not stopped or modified.

## Passing checks

The reduced image uses Ubuntu 22.04 and the Chrome/ChromeDriver versions from the pinned upstream Dockerfile. The Chrome package SHA-256 was checked against upstream's value.

1. AMD64 image build completed on the ARM64 Docker host.
2. Google Chrome `134.0.6998.88` and matching ChromeDriver started under Xvfb.
3. Chrome loaded an internal localhost HTML fixture.
4. A generated 440 Hz WAV, supplied through Chrome's synthetic microphone facility, reached a browser Web Audio analyser: RMS `0.21593514619244503`.
5. A browser-generated 880 Hz oscillator reached a PulseAudio virtual sink: 143,212 captured samples, RMS `0.7044356163303356`.
6. The test exited successfully and its container was automatically removed.

These checks use synthetic audio, not a real meeting/WebRTC transport. Chrome's sandbox was disabled inside the isolated fixture container. Sandboxed browser operation and upstream's complete voice-agent streaming path are unverified.

## Full-build attempts

The first two full builds used the pinned, unmodified upstream checkout, with automatic cancellation below 6 GiB free disk or after 15 minutes per attempt. The third used the index-only override below; the fourth also changed the two AWS package pins as described below. All attempts used the same limits. Pinning source alone does not pin mutable Ubuntu repositories and every transitive dependency.

1. **First attempt:** failed fetching Ubuntu packages with connection errors to `archive.ubuntu.com:80`.
2. **Connectivity check:** Ubuntu HTTP and HTTPS endpoints responded successfully afterward.
3. **Bounded retry:** progressed to upstream Dockerfile line 89, then failed downloading `av==12.0.0` from `files.pythonhosted.org` with `CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate`.
4. **Independent reproduction:** both curl and Python HTTPS requests failed certificate verification inside the probe image. This was not just a pip-specific error.
5. **Certificate diagnosis:** the endpoint presented a corporate TLS-inspection issuer. With approval, its matching public CA certificate was exported from the macOS System keychain; `security verify-cert` returned `CSSMERR_TP_NOT_TRUSTED`.

The exported certificate was **not** trusted or installed in Docker. No private keys were accessed, macOS trust settings were not changed, and TLS verification was not disabled.

## Internal Artifactory attempt

On September 10, the user provided this default uv index:

```toml
[[tool.uv.index]]
name = "artifactory"
url = "https://art-toucan.autodesk.com/artifactory/api/pypi/autodesk-pypi-virtual/simple"
default = true
```

Attendee's Dockerfile uses pip rather than uv. The temporary checkout therefore adds these settings immediately before its first pip install, inherited by subsequent build stages:

```dockerfile
ARG PIP_INDEX_URL
ENV PIP_EXTRA_INDEX_URL="" PIP_CONFIG_FILE=/dev/null
RUN test -n "$PIP_INDEX_URL"
```

The build supplies `PIP_INDEX_URL` using the URL above as a Docker build argument. This replaces the default index, clears extra indexes, and disables pip configuration-file overrides. No uv installation, host-wide pip configuration, credentials, dependency-version changes, or TLS exceptions were added.

Verified results:

- The internal `simple/av/` endpoint returned HTTP 200 from the test container with normal TLS verification.
- Build logs show Artifactory as the sole pip index and the source of the PyAV archive.
- `av==12.0.0` compiled and installed successfully; the build then reached the main requirements installation.
- Artifactory rejected `botocore-1.35.64-py3-none-any.whl` with HTTP 403. A separate request reproduced the response: `{"errors":[{"status":403,"message":"HTTP 403 Forbidden"}]}`.
- The response does not establish whether authentication, package permissions, or repository policy is responsible. Do not label this a confirmed security-policy block.

## Alternative AWS package versions

On September 10, the user asked whether other versions are available and usable. Both `boto3==1.35.99` and `botocore==1.35.99` were downloaded from the same approved Artifactory index, and their SHA-256 hashes matched the index declarations. This is verified download availability, not merely an index listing. No authentication changes or alternate repository endpoints were used.

Compatibility based on the downloaded wheel metadata:

| Dependency | Requirement from the candidate pair | Existing or candidate version |
| --- | --- | --- |
| Python | >=3.8 | Container uses 3.10 |
| botocore | >=1.35.99,<1.36.0 | Candidate 1.35.99 |
| s3transfer | >=0.10.0,<0.11.0 | Existing 0.10.3 |
| jmespath | >=0.7.1,<2.0.0 | Existing 1.0.1 |
| python-dateutil | >=2.1,<3.0.0 | Existing 2.9.0.post0 |
| urllib3 on Python >=3.10 | >=1.25.4,<3,!=2.2.0 | Existing 2.7.0 |

Only these two pins were changed in the temporary checkout:

```text
boto3==1.35.99
botocore==1.35.99
```

The fourth full-build attempt downloaded both candidates and progressed past them. It then stopped on HTTP 403 downloading `charset-normalizer==3.4.0`. Consequently, this pair is a compatible candidate according to metadata, but full dependency resolution, Attendee startup, and runtime tests have not passed. Do not claim the upgrade is end-to-end validated.

## Historical wheel-only audit

The isolated Python 3.10 Linux AMD64 audit completed all 109 requirements in 93 seconds using only Artifactory. It attempted wheel downloads without dependencies or installation:

- 92 requirements downloaded successfully.
- 11 returned HTTP 403: `charset-normalizer==3.4.0`, `dj-database-url==2.3.0`, `drf-spectacular==0.27.2`, `prompt_toolkit==3.0.48`, `redis==5.2.0`, `rpds-py==0.21.0`, `sqlparse==0.5.1`, `trio-websocket==0.11.1`, `lxml==6.1.1`, `gdown==6.0.0`, and `Cython==3.2.4`.
- Six had no compatible wheel: `django-allauth==65.1.0`, `django-concurrency==2.6.0`, `psycopg2==2.9.10`, `webrtcvad==2.0.10`, `signxml==4.5.1`, and `livekit==1.1.8`. This does not establish source-distribution availability or buildability.

These are historical observations, not current blockers. The normal installation below supersedes this wheel-only audit. No further pins were changed after the audit.

## Normal dependency installation: passed

On September 10, 2026, a disposable Linux AMD64 container based on `elva-attendee-base-spike:31ebd91` ran normal `python3 -m pip install -r /probe/requirements.txt`, with a 600-second deadline, through the supplied Artifactory index only. Source distributions were allowed; extra indexes remained disabled and TLS verification remained enabled. The command exited with status 0 and reported successful installation.

- All 11 pins previously returning HTTP 403 downloaded and installed without further version changes. The reason for the earlier responses is not established.
- `django-allauth==65.1.0`, `psycopg2==2.9.10`, and `webrtcvad==2.0.10` built successfully from source and installed.
- `django-concurrency==2.6.0`, `signxml==4.5.1`, and `livekit==1.1.8` downloaded as wheels and installed.
- The container was disposable and removed on exit. This test did not create the complete application image or start Attendee, invoke AWS APIs, or join a meeting.

Use actual installation and runtime results as the acceptance criteria. Missing wheels alone are not an installation failure and do not require a separate approval gate.

## Zoom live-test prerequisites

The user provided an authorized test meeting URL; it is intentionally omitted from this document. No Zoom join was attempted after discovering the credential requirement and account-permission block.

Inspection of the pinned source confirmed that choosing `zoom_settings.sdk=web` does **not** remove the Zoom app credential requirement:

- `bots/bots_api_utils.py`, `validate_meeting_url_and_credentials`, rejects Zoom bot creation without project Zoom credentials or a Zoom OAuth app.
- `bots/zoom_web_bot_adapter/zoom_web_bot_adapter.py`, `ZoomWebBotAdapter.__init__`, obtains the client ID and secret and signs a Meeting SDK JWT. `zoom_meeting_sdk_signature` rejects missing values.

The meeting URL/passcode is not a substitute for these credentials. Configure them privately; do not paste client secrets into chat or commit them. Meeting/account authorization and admission may impose additional requirements, which have not been tested.

The signed-in Zoom Marketplace UI allowed opening the app-creation dialog, but all app types were disabled. The General App tooltip explicitly reported that the user lacked permission. No Zoom app or credentials were created; the user subsequently supplied a Teams test link instead.

## Full-image and startup verification: passed

The full image built successfully in 300 seconds. The isolated startup fixture then completed in 73 seconds, with cleanup exit status 0:

- Six test-only safeguards passed, covering AWS client/API-call blocking, disabled metadata lookup, local media storage, disabled capture configuration, and disabled captions/name-validation bypass actions.
- Postgres and Redis became healthy; all Django migrations and system checks passed.
- Upstream `bots.tests.test_webpage_streamer_manager` passed.
- Zoom SDK, PyAV, and GStreamer imported successfully.
- The application login page and webpage-streamer keepalive endpoint returned HTTP 200.
- One Celery worker responded to `inspect ping`.
- All fixture services and their isolated network were removed afterward.

## Join-only runtime safeguards

These are temporary test-harness overrides, not a production no-recording feature. Stock `recording_settings.format=none` does not disable transcription, and the Teams adapter normally enables captions. The join-only controller disables all pipeline media flags, audio/caption callbacks, and transcription persistence. Its Teams adapter skips caption enabling, media sending, normal screenshot capture, and the upstream display-name-validation bypass. Native join and leave logic remains real, not mocked.

All Django media storage aliases point to ephemeral local files. A startup guard blocks botocore client creation and API calls before network access, disables metadata lookup, removes cloud credential environment variables, and points AWS credential/config files to `/dev/null`. No host cloud credentials are mounted. These checks validate the Python SDK path; they are not a packet-level audit of browser egress.

Only the join-probe container receives an external network for Teams. Postgres and Redis remain on the internal network, with no published ports. The successful test uses the visible name `Elva AI assistant`, muted camera/microphone through the normal prejoin flow, a 120-second lobby timeout, a 180-second bot uptime limit, and a 240-second host-side deadline. A successful observed join is followed by a leave request after 20 seconds. The meeting link is supplied privately over stdin and omitted from this document.

## Live Teams result: passed

The first two attempts used `Elva (AI assistant)` and ended with Attendee's waiting-room timeout error. Diagnostic flags showed the bot still on the prejoin form, not a confirmed lobby. That error alone must not be interpreted as a host failing to admit the bot.

Inspection found that the name-validation pattern handled by Attendee excludes parentheses. A deterministic regex check rejected the original name and accepted `Elva AI assistant`. The test retained the disabled validation-bypass hook and changed only the visible name for the next attempt, alongside additional read-only diagnostics.

The validation-compliant name succeeded:

- `Joined - Not Recording` observed 42 seconds after the controller started; two participant records were present.
- A leave request was issued after 20 seconds in the joined state.
- Recorded event sequence: join requested, bot joined meeting, leave requested, bot left meeting, post-processing completed.
- Final state: `Ended`; join process exit status 0.
- Audio chunks: 0; utterances: 0; recording files: 0; blocked AWS SDK attempts during the live process: 0.
- Fixture containers and both fixture networks were removed; cleanup exit status 0.

This is one successful meeting join using safety-specific test overrides, not an unmodified production deployment or a reliability benchmark. The earlier synthetic audio test is separate; no real meeting audio reception or output was tested here.

## Standalone audio POC: live round trip

On September 10, a separate throwaway bridge was added under the existing temporary spike directory, without changing application source or UI. It reuses Elva's `ConversationAttention` controller and session prompt, connects to the existing configured Realtime proxy/model, and exposes a token-authenticated, certificate-verified local WebSocket for Attendee. No new host dependencies were installed; the bridge uses the existing Playwright-bundled WebSocket implementation, which is a POC-only internal dependency.

The audio-specific Attendee overrides enable only mixed PCM streaming, keep captions/recordings/transcription persistence disabled, and retain the existing AWS SDK guard. Replies use the bot's virtual microphone. Temporary playback code tracks scheduled audio sources, clears queued/current output on cancellation, and reports elapsed playback for conversation truncation. Main-app execution, workspace, and MCP tools are deliberately not connected to this voice-only POC.

Initial checks passed:

- Six synthetic bridge/playback tests: PCM validation, attention-gated output, late-audio suppression and truncation after cancellation, ignored uninvited turns, browser-source cancellation accounting, multi-item reply completion, and per-item interruption offsets.
- Two runner-result tests ensure success requires successful bot, bridge, and cleanup exits.
- Eleven Docker safety tests, including the original six guards, audio-only pipeline/caption/queue checks, and verification that the local TLS certificate supplements rather than replaces system trust. Certificate verification and hostname checking remain enabled; extra trust applies only to the local bridge connection.
- A synthetic text invitation through the configured live Realtime provider generated 216,000 bytes of PCM. This test did not listen to a meeting or prove audible playback.
- Docker-to-host TLS certificate validation, WebSocket upgrade, and heartbeat exchange passed; fixture cleanup exited 0. An earlier first attempt timed out during the WebSocket handshake; the instrumented rerun passed, so the transient failure remains unexplained rather than claimed fixed.

Run the temporary POC from the local machine with `python3 /private/tmp/elva-attendee-spike.HgqSzv/audio_poc.py`; add `--preflight` to check transport without joining. The live runner uses the privately stored meeting link, leaves after four minutes joined, enforces a process deadline, and cleans up its own fixture services. Participants must consent to audio streaming to the configured Realtime provider. Use headphones during the acoustic test.

Artifacts: `audio_poc.py`, `audio.compose.yaml`, `poc_server.mts`, `poc_bridge.ts`, `poc.test.ts`, and `runtime/poc_*`. Credentials and the random connection URL stay outside this repository. The runner regenerates its two-day local TLS certificate on each invocation. Logs contain counters and state transitions rather than meeting audio/transcripts; preflight and live logs use separate names. Provider-side handling is governed by the configured provider, not the local no-recording overrides.

### Live audio attempts: waiting for meeting start/admission

Two audio-enabled attempts timed out without reaching a joined state; both sent zero meeting audio to Realtime and received no spoken reply. Both ended with zero stored audio chunks, utterances, recordings, media files, and blocked AWS SDK attempts. Cleanup completed successfully.

A subsequent join-only control, using the previously successful path without the audio bridge, revealed the actual Teams screen message: “Hi, Elva AI assistant. Someone will let you in when the meeting starts.” The initial diagnostic incorrectly treated the disabled join button and absent name input as a prejoin failure because its lobby-text pattern did not recognize this wording. That pattern is now corrected. The control also timed out awaiting admission; it did not establish that the new audio path is broken or that it works end-to-end.

The host subsequently started the supplied meeting and admitted `Elva AI assistant`, allowing the audio test below. The final non-meeting transport preflight also passed after the certificate-trust change. Each test has a bounded lifetime and cleans up its own fixture services.

### First successful live audio round trip

After host admission on September 10, 2026:

- The bot reached `Joined - Not Recording`, with two participant records. This occurred 115 seconds after joining began, including time awaiting admission; it is not a measured audio-response latency.
- The authenticated Docker-to-host WebSocket connected to the configured Realtime session.
- At the first completed-reply checkpoint, 2,124,960 bytes of meeting PCM had reached Realtime, one attention check had completed, and one reply had been generated.
- Realtime returned 410,400 bytes of 24 kHz mono PCM, corresponding to 8.55 seconds. The bot browser reported playback started and then stopped, with 8,550 ms played through its virtual microphone.
- The user replied “yes she can” during the live voice check. Together with the telemetry, this establishes the first listening-and-speaking POC round trip, not production readiness.

The session ultimately completed two replies, then stopped safely during a third with `MULTIPLE_AUDIO_ITEMS`. Final bridge counters were 5,663,520 input bytes, 1,286,400 generated output bytes, five attention checks, three reply/playback starts, and two completed playbacks. Generated bytes are not equivalent to audio heard: the third playback was interrupted by the failure.

The bot left and reached `Ended`. Stored audio chunks, utterances, recording files, media files, and blocked AWS SDK attempts were all zero; fixture cleanup exited 0. The original runner incorrectly returned success based on the bot exit alone despite the bridge failure. The runner now includes bridge and cleanup exit status in its result.

The temporary bridge now accepts sequential audio items within a response, sends its playback-end marker only at whole-response completion, and calculates interruption truncation separately for partial/unplayed items. Two new regressions reproduce the previous failure and pass after the fix. A subsequent synthetic provider request generated 192,000 PCM bytes successfully, and Docker TLS/heartbeat preflight passed with bot, bridge, and cleanup exits all 0. The revised multi-item handling has not yet been re-tested in Teams.

The experiment remains outside the application source/UI. Execution and MCP tools remain disconnected from the meeting bot. Follow-up recognition, acoustic echo robustness, live barge-in, speaker attribution, long-running reliability, and latency still need dedicated acceptance tests. No bot is currently running after cleanup.

## Remaining verification

Expand beyond the first confirmed live audio round trip. Speaker attribution, acoustic echo prevention, live interruptions, meeting tool permissions, response latency, production browser sandboxing, and persistent Elva integration remain unverified. Synthetic playback/attention checks are not a substitute for those meeting-level tests.

## Evidence and reproducibility

Temporary artifacts, which may be removed by OS cleanup:

- `probe/Dockerfile`, `probe/compose.yaml`, `probe/smoke.py`: reduced browser/audio fixture.
- `browser-build.log`, `browser-smoke.log`: successful reduced-image build and test.
- `build_guard.py`: disk/time-bounded full-build launcher, now using the supplied internal index.
- `attendee-build-first-attempt.log`, `attendee-build.log`: the two full-build failures.
- `attendee-build-artifactory.log`: successful PyAV compilation and the subsequent HTTP 403 failure.
- `inspect_artifactory_versions.py`, `artifactory-versions.log`: bounded version inspection, candidate downloads, SHA-256 verification, and dependency metadata.
- `attendee-build-boto-1.35.99.log`: the two upgraded AWS packages downloaded successfully; the next package denial is recorded here.
- `audit_package_pins.py`, `package-pin-audit.log`: completed 109-requirement wheel-download audit.
- `upstream/`: pinned source checkout with the index-related Dockerfile override and two experimental AWS package pin changes described above.
- `attendee-build-normal-install.log`: successful full-image build.
- `compose.yaml`, `stack_smoke.py`, `stack-service.log`: passed isolated application/worker/streamer startup fixture.
- `runtime/`: temporary local settings, no-cloud guard, safety tests, and join-only controller/adapter overrides.
- `live.compose.yaml`, `live_join.py`: bounded live test and cleanup runner; meeting links are not part of its source.
- `teams-join.log`, `teams-join-diagnostic.log`: unsuccessful attempts with the original display name.
- The earlier successful join/leave counters are recorded above. The shared `teams-join-valid-name.log` was subsequently overwritten by the later control run; that control is also preserved as `teams-join-control-lobby.log`.
- `poc-first-bot.log`, `poc-first-bridge.log`: first live audio attempt, with zero media counters and no successful join. Subsequent tool output records the second attempt with the same outcome.
- `poc-first-audio-roundtrip-bot.log`, `poc-first-audio-roundtrip-bridge.log`: archived first live round trip, two completed responses, subsequent multi-item bridge failure, and clean bot departure with zero persistence counters.
- `poc-bot.log`, `poc-bridge.log`: working live-run logs; `poc-preflight-bot.log`, `poc-preflight-bridge.log`: separate non-meeting connectivity logs. Each working pair is overwritten by the next run of that type.

The Docker probe image and partial build cache remain available for investigation; no broad cache pruning was performed. The experiment is not a persistent installation.

The required manual setup reminder was added to `/Users/nge1/myapps/set-mac-up/setup.sh`; its shell syntax check passed. No new host application was installed.
