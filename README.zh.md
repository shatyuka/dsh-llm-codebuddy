# dsh-llm-codebuddy

[English](README.md) | **中文**

一个面向 **腾讯 CodeBuddy** 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件。

通过浏览器登录 — **无需 API Key** — 即可使用 CodeBuddy 自带的模型列表。

## 功能

- **浏览器 OAuth 登录** — 在普通浏览器标签页中完成授权，全程无需 API Key；中国站与国际站均可登录。
- **完整模型目录** — CodeBuddy 自带的模型，含上下文窗口、输出上限与积分倍率，服务端新增或下架模型会自动同步。
- **流式对话** — 回复实时流式输出。
- **工具调用** — 支持函数调用，模型不支持时会给出明确提示。
- **推理力度** — 支持思考的模型可自选思考档位。
- **图片输入** — 支持视觉的模型可发送图片（不支持视觉的模型可能会被服务器路由到其他模型）。
- **用量指示器** — 在 Web UI 侧边栏展示个人版与企业版的配额进度条，支持自定义上限与告警阈值。

## 兼容版本

| 要求 | 版本 |
| --- | --- |
| DeepSeek Harness（`dsh`） | `>= 0.1.7-rc.1` |

设置页、模型选择器、用量指示器等 Web UI 功能需要 `web` profile。

## 安装

将插件添加到某个 dsh profile — `web` profile 即 Web UI 后端：

```bash
dsh plugin --profile web add @shatyuka/dsh-llm-codebuddy
```

## 登录

在 Web UI 中打开 **设置 → CodeBuddy**，选择站点：**登录中国站**（[copilot.tencent.com](https://copilot.tencent.com)）或 **登录国际站**（[www.codebuddy.ai](https://www.codebuddy.ai)）。浏览器登录页会在新标签页打开，harness 自动写入凭据，无需使用终端。

两个站点是同一服务部署在不同域名，但**账号互不通用**——一个站的账号无法在另一个站使用——因此站点在每次登录时选择，并随凭据一并记录，之后所有请求都会发往签发该凭据的站点。要换到另一个站，退出登录后重新登录即可。

也可以从终端登录：

```bash
# CLI 备用方式，推荐使用上方的 Web UI 登录。

# 登录中国站（默认，等同 --site cn）
dsh plugin --profile web exec dsh-codebuddy-login

# 登录国际站
dsh plugin --profile web exec dsh-codebuddy-login --site intl

# 查看登录账号、所属站点与模型列表
dsh plugin --profile web exec dsh-codebuddy-login --status

# 删除已保存的凭据
dsh plugin --profile web exec dsh-codebuddy-login --logout
```

登录后，CodeBuddy 的模型会出现在模型选择器中。

## 构建

在源码目录中：

```bash
pnpm install
pnpm run build
```

该命令使用 `tsc` 编译宿主端，使用 `esbuild` 打包 Web 客户端，两者均输出到 `lib/`。

## 许可证

MIT
