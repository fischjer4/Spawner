# Sidekick

A personal macOS menu-bar companion for Zoom calls. It watches Wispr Flow's meeting transcripts and completed hotkey dictation, uses Jev through Vercel AI Gateway to recognize research and implementation requests, launches a Replicas agent, and notifies you with a written answer. Optional **Read to me** playback uses your Mac’s current audio output.

## Use the app

Open **Sidekick.app**. It stays running in the Dock and menu bar when its window closes and can start at login. Click its Dock icon to reopen the window, or right-click the icon and choose **Quit** to stop Sidekick.

1. In **Settings → Connections**, save a Vercel AI Gateway key and a **personal Replicas API key**. Test Jev, refresh environments, and choose your agent environment.
2. For meetings, turn on **Live Transcript in Wispr before recording**. Or use your usual **Wispr dictation hotkey** and say the complete command, such as “Replicas, research whether Electron supports menu-bar apps.” No Notetaker session is needed for dictation. Sidekick ignores existing history at startup and handles each new completed dictation once.
3. Say **“Replicas, go research…”**, **“Replicas, implement…”**, or **“Replicas, create an issue in Linear…”**. Continue your conversation. Sidekick notifies you when a task finishes; click the notification to read the answer and sources. **Continue in Replicas** opens that workspace in your installed Replicas app so you can follow up in the same conversation.
4. Click **Read answer** or the macOS notification itself to open that exact answer, already expanded in Sidekick, or choose its **Read to me** action (sometimes inside Options). You can also choose **Read to me** in a task’s answer panel. Use headphones during calls. Playback starts only when you click the button; answers never play automatically.

Dictation needs Wispr’s **local history storage** enabled. It runs after Wispr finishes transcribing; Wispr still pastes the text into the focused app. Each dictation supplies its own context, without pulling in other dictations or an unrelated meeting. Incomplete commands ask you to dictate the full question again. Diagnostics labels the source **Dictation** and shows the same Jev, Replicas, answer, and timing stages. The history adapter reads only text and completion metadata, not audio, screenshots, or textbox contents.

You can also click **New research** (or press **N**) to type a question to test the research path independently of Wispr. Sidekick needs no Loopback, virtual microphone, Zoom integration, or audio recording permissions. Wispr still handles recording and transcription.

**Command–Shift–period** immediately stops playback. Pausing listening stops new requests; already-running cloud research continues. Use **Cancel task** to interrupt it. Closing the window leaves Sidekick running in the menu bar.

Sidekick executes **Replicas** research and implementation tasks. A request addressed to T3 is retained as “Needs attention”; it is never silently sent to Replicas. T3 integration is not implemented.

## Interface (0.5.0)

**Inbox** groups work into In progress, Needs attention, and Ready to review. Open a row to view the original result in an animated panel, read it aloud, or continue in Replicas. **Archive finished** clears completed results from Inbox without losing them; **History** holds archived tasks. Settings brings Connections and Preferences together. Diagnostics is separate from everyday work and no longer defaults to a stale transcript. The light theme uses white and soft-gray surfaces with a restrained violet accent, brief transitions, and reduced-motion support. **Escape** closes a task or the new-research form; keyboard focus stays inside the answer panel while it’s open.

## Where it runs and what it stores

The menu-bar app, file watcher, job tracking, and audio playback run on your Mac. Jev, response summaries, and speech generation use AI Gateway; the research agent runs in Replicas. No Sidekick web server or hosted backend is required.

App data is in `~/Library/Application Support/Sidekick`. Credentials are encrypted using Electron safeStorage with a macOS Keychain-protected key. They are never sent to the renderer. The SQLite database stores original requests, selected context, task modes, results, processed request IDs, and settings. The recent transcript buffer is in memory; only a task's selected context is persisted. **Archive** moves finished tasks out of Inbox into History without deleting local answers or remote Replicas threads. **Move to Inbox** restores them. Running tasks cannot be archived.

On a candidate request, recent transcript text goes to AI Gateway for classification. The **original request and relevant conversation text** go to the chosen Replicas environment without an intermediate rewriting/summarization call. A title is derived locally for the workspace name; it does not replace the request. Replicas replies naturally with its findings or work performed. Sidekick sends that response to AI Gateway to create a short summary and extract cited links, while preserving the original answer locally. Sidekick does not capture raw audio. Wispr's own recording/transcription behavior is unchanged.

## Research and implementation

Jev routes information-gathering requests to **research** (plan mode on, no project edits or external actions) and requests to do work to **implementation** (plan mode off). Implementation includes code changes and tasks in connected tools, such as creating a Linear issue or using an applicable skill. “Research how to add a drawer” stays research; “add the drawer” or “research the bug and fix it” is implementation. Creating an issue about research is implementation because the requested action creates an issue.

Implementation uses the repositories, skills, and connected tools in the **selected Replicas environment**, not automatically those installed on this Mac. Sidekick supplies the original words and a short mode instruction, without a mandatory Markdown response format. Agent questions and permission requests stay in Replicas; Sidekick surfaces them rather than answering on your behalf. Only the agent’s final response is summarized for optional playback. Existing saved tasks default to research. The manual **New research** form remains an explicitly labelled research shortcut.

## Request detection

Sidekick groups consecutive transcript fragments from the same speaker, separates prior context from the candidate request, and asks Jev about the whole request window. Casual remarks after a command do not erase it. Requests can address the assistant directly or ask someone to have it do the research: “Can we have Replicas research this?”, “Let’s get Replicas to check that,” and similarly softened requests count. References such as “this” use the latest relevant discussion; uncertainty about a claim is a reason to research it, not a reason to mark the request unfinished. Explicitly deferred ideas, capability-only questions, historical quotes, negations, and withdrawals still do not launch research. The current gates are an invocation score of 0.8 and completeness score of 0.7, plus a research, implementation, or cancellation action. These are operating thresholds, not calibrated accuracy guarantees. A brief detection status appears in Inbox for 30 seconds; the full trace stays in Diagnostics.

Version 0.2.4 fixes transcript ingestion for resumed recordings and final writes carrying an `endedAt` marker. Diagnostics retain that marker and explain why new speech was accepted; old text is never replayed by this fix.

Version 0.2.7 keeps **Read to me** visible when the answer exists but its summary failed; clicking retries summary preparation. Summary URL validation runs locally for compatibility with the selected Gateway model. macOS notifications retain their native objects, offer review/read actions, and restore those actions after restart. Preferences includes a test notification and a link to macOS notification settings. Allow banners/alerts for Sidekick; Focus or screen sharing may suppress banners. Notification send/failure events and safe summary errors appear in Diagnostics.

## Live diagnostics

Open **Diagnostics** for a compact **Latest run** card with the source and start time. **Transcript Jev checked** shows the exact request once, with earlier conversation expandable beneath it; the matching scores, action, and delivery status sit directly below. **Run history** selects an **Earlier run**, with **Back to latest** to resume following new requests. Multiple checks within a growing request are selectable; newer transcript lines outside that check are explicitly marked. Ordinary conversation does not replace the latest request, while a new pending request shows its own unscored text instead of a previous score. **Run details** and **Debug tools** keep event payloads, file reads, copy/clear actions, and phrase testing collapsed. Attempted sends are distinguished from confirmed workspaces.

**Try a phrase · Jev only** sends the context and phrase you enter to Gateway, displays the result, and never creates or cancels Replicas work. **Copy diagnostics** copies recent text, prompts, answers, and timings for debugging; it does not include service keys. This history is bounded to 30 request groups (60 events each), eight file reads (80 lines each), and stays in memory until the app exits. **Clear** removes the displayed history without changing tasks or replaying transcript text.

## Trigger evals (Evalite)

The Evalite suites run 37 anonymized/synthetic cases twice each, uncached, through the real meeting/dictation watcher, Jev decision call, local task store, and Replicas HTTP client. They cover the reported request with and without casual trailing conversation, a request split across transcript updates, contextual references, quotes, hypotheticals, negation, withdrawal, and cancellation of existing research.

```sh
npm ci --prefix evals
npm run eval          # run once, write evals/results/latest.json, exit
npm run eval:ui       # run once and keep the results UI at http://localhost:3006
npm run check:evals
# Optional focused run using the same production path:
SIDEKICK_EVAL_SUITE='Delegated requests' npm run eval
```

These commands make paid Gateway model calls using Sidekick's saved connection and selected models. The launcher decrypts the key through Electron and passes it privately to the eval process; it does not write keys to reports. Alternatively, supply `AI_GATEWAY_API_KEY` and optionally `SIDEKICK_EVAL_SETTINGS` as environment variables. Missing credentials fail the run. Only the final Replicas HTTP transport is substituted: actual request payloads and plan-mode flags are recorded, and no remote agents are created or interrupted. These are routing/handoff evals, not tests of remote skill execution or code quality.

Every trial scores launch count, research/implementation mode, original transcript preservation, cancellation, launch timing across transcript chunks, execution health, and **All required outcomes**. A premature launch, unwanted cancellation, timeout, or model error fails the case even if its final launch count looks correct. The CLI requires 100% across the suite. Expected labels stay out of model inputs; traces show the actual Jev inputs/decisions and exact handoff payloads. Separate unit tests verify that the scorers reject known bad outcomes.

Evalite is pinned to `1.0.0-beta.16` in a separate development package because its optional AI SDK integration requires SDK 6, while Sidekick uses SDK 7 for Jev. Evals import the app's production code and use Evalite's [manual tracing API](https://v1.evalite.dev/api/report-trace/) instead of a mismatched SDK wrapper. The UI uses Evalite's in-memory storage to avoid a native SQLite adapter crash under Node 24; `npm run eval` persists a JSON report, while `npm run eval:ui` keeps results in memory for that server session (this Evalite beta only exports JSON in exit mode). Starting `eval:ui` runs the suite again.

These are developer-labelled regression checks, not a general accuracy estimate or a live Zoom/Replicas end-to-end test. On October 22, 2026, both the UI run and CLI/export run passed 30/30 uncached trials. The CLI report contains 46 model traces. These scores assess triggering and cancellation, not brief or research-answer quality; inspection found some briefs unnecessarily describe the wake name “Replicas” as unclear, which is a separate quality issue. Earlier standalone reports in `evals/` retain the failures that led to the detector changes, as well as the final 22/22 regression result and separate 4/4 phrasing check. The Evalite report records fresh runs independently of those earlier results. After the ended-marker fix, the expanded suite passed 34/34 trials, including resumed-recording and final-flush cases twice each. The model calls are real; Replicas launch attempts are counted without creating remote workspaces. Version 0.2.5 broadens recognition to conversational delegation. The focused old-prompt run failed 3/16 trials, including both meandering-context requests; the revised prompt passed the full 50/50 trial suite at the same 0.8/0.7 gates. Reports are `evals/results/delegation-before-noisy.json` and `evals/results/delegation-after-full.json`. These developer-authored regressions are not a general accuracy estimate.

## Current boundaries

- Wispr's transcript file and database schema are internal implementation details. An update may require an adapter change. The inspected version uses a **five-second debounce** for transcript autosave, so speech can take several seconds—or longer during continuous speech—to appear. Actual live-call timing has not yet been measured.
- The watcher accepts unseen speech timestamped after Sidekick started and within the last 60 seconds, even if Wispr retains an `endedAt` marker from a prior stop or writes it before the final transcript flush. It baselines existing files on startup and expires an idle session after five minutes without fresh speech. Very quiet meetings may temporarily show as idle until speech resumes.
- Three research jobs may run concurrently. Jobs use Replicas plan mode plus explicit research-only instructions, not an independent permissions sandbox. Choose an appropriate environment.
- Research and cancellation requests are recognized; ambiguous cancellation does not stop multiple jobs. Playback is controlled in the app. Spoken follow-ups currently create a fresh task with recent conversation, rather than resuming the old agent thread.
- Replicas workspaces display a readable, hyphenated research title (the Replicas API rejects whitespace in names). Creation uses a unique temporary recovery name, then renames the workspace once its remote ID is saved; a failed rename does not interrupt research and Refresh retries it.
- Replica creation is never blindly retried. If the response is lost, Refresh reconciles the unique workspace name against recent API-created workspaces. A restart preserves known remote IDs and restores interrupted playback as a written answer.
- Replicas answers normally, so its thread stays readable and can be continued. Sidekick summarizes completed answers separately. If summarization fails, the original response remains available and Refresh retries the summary. Failed turns, pending requests, and unsupported provider histories require manual review. Claude, Codex transcript/history, and Cursor assistant text are supported; other provider-specific history formats may need an adapter. Existing responses from the older structured format are still readable.
- The app is built and locally signed for this Mac, not notarized for public distribution. Gateway and Replicas access need one-time setup.

## Development

Requires macOS 15+, Apple Silicon, Xcode command-line tools, and Node 24+.

```sh
npm install
npm run check
npm test
npm start
```

If npm's install-script policy skips the Electron binary, run `node node_modules/electron/install.js` once. The development launcher removes `ELECTRON_RUN_AS_NODE` inherited from some terminal hosts.

```sh
npm run package
```

The app is produced at `release/mac-arm64/Sidekick.app`. For local use, sign it with `codesign --force --deep --sign - release/mac-arm64/Sidekick.app` and copy it into `~/Applications`.

`npm run smoke` uses the real Electron renderer, preload boundary, native SQLite, and the local Wispr folder. Use an isolated data directory: `SIDEKICK_TEST_DATA=/tmp/sidekick-test npm run smoke`. It does not call paid models or create remote workspaces. It writes a screenshot to `/tmp/sidekick-smoke.png`.

The automated tests cover real transcript file changes, deduplication, stale/cloud transcript rejection, completion parsing, request cancellation, lost-response recovery, restart behavior, and notification-only completion. Provider responses are fixtures in these tests; they do **not** establish Jev's real-world classification accuracy or validate a live Zoom call.

## Main files

- `src/transcript.ts`: read-only Wispr watcher and normalized utterances.
- `src/services.ts`: AI SDK calls, Replicas API, final-answer parsing.
- `src/engine.ts`: request and research lifecycle, completion handling, speech queue.
- `src/main.ts`: Electron lifecycle, secure IPC, credentials, notifications, native helper.
- `renderer/`: menu-bar companion UI and audio playback.

Primary references: [Jev decisions](https://ai-sdk.dev/docs/ai-sdk-core/decisions), [AI SDK speech](https://ai-sdk.dev/docs/ai-sdk-core/speech), [Replicas API](https://docs.replicas.dev/features/api), [Wispr live transcript](https://docs.wisprflow.ai/articles/4091106439-the-live-transcript-in-notetaker-beta).

Version 0.3.0 removes the brief-generation call and adds implementation routing. The release run passed **74/74 uncached trials** (37 cases × 2), including exact original-transcript preservation and the actual HTTP `plan_mode` flag. Report: `evals/results/research-implementation-release.json`. An earlier completeness rewrite regressed research cases and was not shipped; its results are retained alongside the release report. These checks cover local ingestion, real Jev classification, and the Replicas handoff. Remote agents, skill execution, and project changes are outside this evaluation boundary.


### Split live requests (0.4.2)

A standalone “Replicas.” stays pending for the same speaker’s next words, even when Jev gives the bare name a low score. Meeting requests can grow for up to three minutes, with a 60-second idle timeout. Recognized requests wait 15 seconds after that speaker’s last received transcript update before handoff, allowing Wispr’s delayed chunks and scope corrections to arrive. This adds a deliberate live-meeting delay; completed hotkey dictation still goes straight through. Another speaker’s chatter neither inherits the wake name nor extends the wait. Earlier context is captured when the request starts. The final request is sent intact, including research-only instructions; an oversized request is rejected explicitly instead of silently truncated.

The timed regression replays the reported request across three transcript arrivals, 12.12 and 10.20 seconds apart. Those gaps come from speech-end timestamps; file-arrival timing is reconstructed, and prior discussion is shortened. The old implementation failed all four baseline trials (two missed launches, two premature handoffs). The fix passed 16/16 focused uncached trials using real Jev, covering delayed scope changes, requests spanning more than 30 seconds, withdrawals, and speaker isolation. These tests substitute only Replicas HTTP transport; they do not run remote agents. Reports: `evals/results/streaming-before.json` and `evals/results/streaming-after.json`.

The 0.4.2 release regression passed **90/90 uncached trials** (45 cases × 2), plus 39 local tests and the hidden Electron UI/IPC smoke check. Full report: `evals/results/streaming-release.json`. The UI check verifies exact input/score pairing for earlier and latest Jev checks, no stale score during a pending check, and that ordinary speech does not replace the latest scored request.


### Visible request capture (0.5.0)

A request card appears above the current page as soon as Sidekick hears an assistant name. It shows **Heard you → Collecting / Understanding your request → Ready to send**, the original words as they arrive, the speaker, and a countdown. **Send now** skips settling after Jev verifies the current request; it does not bypass intent, scope, or task-mode checks. If more words arrive during that check, the finish action resets and the expanded request is checked again. An action against an outdated preview is rejected. **Cancel** removes only that pending request, including while Jev is responding, and cannot silently cancel a different request or a running task. A started task appears in Inbox. The menu-bar tooltip also reflects the request state; Sidekick does not bring its window forward when speech arrives.

Jev now classifies each turn as **collecting**, **ready**, or **not_request**, alongside its existing intent and completeness scores. An incomplete developing request stays open even if the initial invocation score is low. When Wispr supplies a speaker name, Sidekick uses the name to keep that person’s fragments together across changing numeric speaker IDs. Without a name it uses the numeric ID; it does not infer speaker identity from audio. An unfinished wake yields to another speaker’s request instead of blocking it.

The inspected meeting NDJSON files expose segment timestamps, not an end-of-request signal. Ordinary live speech therefore retains the 15-second delayed-transcript fallback. An explicit final phrase such as **“that’s all,” “you can start now,” or “send it now”** reduces the grace period to 2.5 seconds after the latest received text, still requiring Jev to accept the request as ready. Wispr dictation’s completed status continues to allow immediate processing. Ending a sentence or writing a transcript segment alone does not shorten the wait.

The focused real-Jev run passed **12/12 uncached trials**, covering explicit finish, quoted finish, unfinished scope, Send now, Cancel, and named-speaker continuity. Report: `evals/results/capture-focused.json`. The renderer smoke check uses isolated credentials and substitute model/remote-agent responses, while exercising actual preload, IPC, engine controls, task persistence, and layout; real-model routing evidence is kept separate in Evalite.

The 0.5.0 full release run passed **102/102 uncached real-Jev trials** (51 cases × 2). Report: `evals/results/capture-release.json`. Replicas HTTP transport remains substituted, so this establishes routing, timing, transcript preservation, and handoff behavior—not remote implementation quality. Local tests and hidden Electron UI checks additionally cover stale-preview rejection, cancellation during a model call, late text during Send now, and exactly one handoff through the real control IPC.
