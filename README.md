# @shatyuka/dsh-llm-codebuddy

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin for **Tencent CodeBuddy**.

Sign in through your browser — **no API key required** — and use CodeBuddy's own model list.

## Install

Add the plugin to a dsh profile — the `web` profile backs the Web UI:

```bash
dsh plugin --profile web add @shatyuka/dsh-llm-codebuddy
```

## Sign in

Open **Settings → CodeBuddy** in the Web UI and click **Sign in**. The browser login opens in a new tab; the harness writes the credential automatically. No terminal needed.

You can also sign in from the terminal:

```bash
dsh plugin --profile web exec dsh-codebuddy-login              # sign in
dsh plugin --profile web exec dsh-codebuddy-login --status     # who is signed in, plus the model list
dsh plugin --profile web exec dsh-codebuddy-login --logout     # remove the stored credential
```

Once signed in, CodeBuddy's models appear in the model picker.

## Build

From a source checkout:

```bash
pnpm install
pnpm run build
```

This compiles the host half with `tsc` and bundles the Web client half with `esbuild`, both into `lib/`.

## License

MIT
