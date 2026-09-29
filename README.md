# dsh-llm-codebuddy

**English** | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin for **Tencent CodeBuddy**.

Sign in through your browser — **no API key required** — and use CodeBuddy's own model list.

## Features

- **Browser OAuth sign-in** — authorize in a normal browser tab; no API key needed, ever. Sign in to either the China or the international site.
- **Full model catalog** — CodeBuddy's own models, with context windows, output caps, and credit multipliers; server-side additions and removals are picked up automatically.
- **Streaming chat** — responses stream in real time.
- **Tool calls** — function calling, with a clear error when a model does not support it.
- **Reasoning effort** — pick a thinking level for models that support one.
- **Image input** — attach images for vision-capable models (models without vision support may be routed to a different model by the server).
- **Usage indicator** — a quota bar in the Web UI sidebar for both personal and enterprise plans, with an optional custom cap and a configurable danger threshold.

## Compatibility

| Requirement | Version |
| --- | --- |
| DeepSeek Harness (`dsh`) | `>= 0.1.7-rc.1` |

Web UI features such as the settings page, model picker, and usage indicator require the `web` profile.

## Install

Add the plugin to a dsh profile — the `web` profile backs the Web UI:

```bash
dsh plugin --profile web add @shatyuka/dsh-llm-codebuddy
```

## Sign in

Open **Settings → CodeBuddy** in the Web UI and pick a site: **Sign in (China)** for [copilot.tencent.com](https://copilot.tencent.com) or **Sign in (Intl)** for [www.codebuddy.ai](https://www.codebuddy.ai). The browser login opens in a new tab; the harness writes the credential automatically. No terminal needed.

The two sites are the same service on different hosts but hold **separate accounts** — one site's account does not work on the other — so the site is chosen per sign-in and recorded with the credential. Every later request goes to the host that issued it. To move to the other site, sign out and sign in again.

Alternatively, sign in from the terminal:

```bash
# A CLI fallback; the Web UI sign-in above is recommended.

# Sign in to the China site (the default; equivalent to --site cn)
dsh plugin --profile web exec dsh-codebuddy-login

# Sign in to the international site
dsh plugin --profile web exec dsh-codebuddy-login --site intl

# Show the signed-in account, its site, and the model list
dsh plugin --profile web exec dsh-codebuddy-login --status

# Remove the stored credential
dsh plugin --profile web exec dsh-codebuddy-login --logout
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
