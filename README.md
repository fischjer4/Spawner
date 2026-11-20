# Spawner

Spawner runs in your Mac's menu bar. Type a question or dictate it with Wispr Flow. Replicas runs the task in the cloud, or T3 Code runs it in a project on your Mac. You'll find the answer in your Inbox.

You'll need a Vercel AI Gateway key for either agent. Replicas also needs a personal API key. T3 Code pairs with Spawner on your Mac. Enter your keys in Settings under Connections. The desktop app needs no environment variables or `.env` file.

## Run Spawner

If you have `Spawner.app`, open it and [connect your agent](#connect-your-agent). To run from source, you'll need an Apple Silicon Mac with macOS 15 or later, Node.js 24 or later, and the Xcode Command Line Tools.

```sh
git clone https://github.com/fischjer4/Spawner.git
cd Spawner
npm ci
npm start
```

## Connect your agent

Open Connections in Settings. Under AI Gateway, click **Get a key**. Paste the key into Spawner and click **Save key**, then **Test Jev connection**. Spawner uses Gateway to recognize spoken requests, summarize answers, and read them aloud when you ask. It encrypts saved credentials with a key protected by macOS Keychain.

Connect the agent you want to use.

- **Replicas.** Click **Open Replicas**. In your Personal settings, open API Keys and create a key. Paste it into Spawner and click **Save key**. Under Agent environment, click **Refresh** and choose where your tasks will run.
- **T3 Code.** Install T3 Code in `/Applications` or `~/Applications`. Open a project and set its default model, or run a thread there once. T3 Code uses the model provider you've configured there. In Spawner, click **Connect / refresh projects** and choose your default local project.

To check the connection without Wispr Flow, click **New research**. Choose your agent under **Run in** and ask "What does this project do?" Look for the task in your Inbox.

## Use Wispr Flow

For hotkey dictation, enable local history storage in Wispr Flow. For meetings, turn on **Live Transcript** before you start recording. With Spawner running, say "T3, find out how this project runs its tests." Use "Replicas" for a cloud task.

If typed requests work but speech doesn't appear in Diagnostics, check the Wispr Flow data folder in Spawner's Preferences. The default is `~/Library/Application Support/Wispr Flow`.

## Developer checks

Run `npm run check` and `npm test` locally without keys. To test the Electron app with a fresh data folder, run `SPAWNER_TEST_DATA="$(mktemp -d)" npm run smoke`.

The optional speech-routing evaluations make paid Gateway calls. Install their dependencies with `npm ci --prefix evals`, then run `npm run eval`.

| Environment variable | When to use it |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Set this to supply your own Gateway key for evaluations. Otherwise they use Spawner's saved key and model settings. |
| `SPAWNER_EVAL_SETTINGS` | When you supply `AI_GATEWAY_API_KEY`, use this to override model settings with JSON such as `{"decisionModel":"typesafe-ai/jev-1.14.0"}`. |
| `SPAWNER_EVAL_SUITE` | Select a single suite with a command like `SPAWNER_EVAL_SUITE='Delegated requests' npm run eval`. |
| `SPAWNER_TEST_DATA` | Set the app data folder for the Electron smoke test. |
