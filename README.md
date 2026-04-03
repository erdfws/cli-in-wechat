# cli-in-wechat

让你直接在微信里调用电脑上的 AI 助手，并把生成的文件发回微信。

**支持的工具：** Claude Code / Codex CLI / Gemini CLI / Kimi Code / OpenCode / Qwen Code

## 适合谁

- 想在微信里让 AI 帮你写文档、整理内容、生成文件的人
- 想让电脑上的 AI 工具通过微信随时待命的人
- 不想一直开着终端窗口盯着的人

如果你不是程序员，也可以使用。你只需要会：

- 按说明安装一次
- 扫码登录
- 在微信里直接发自然语言

## 它是什么

这是一个运行在你电脑上的桥接服务。  
微信是遥控器，电脑是执行端。

```
微信 ClawBot (手机)
    ↕  iLink Bot API — 微信官方消息通道 (不封号)
桥接服务 (你的电脑)
    ↕  spawn / Agent SDK
claude -p / codex exec / gemini -p / kimi --print / opencode -p
```

## 🌟 相比原版的增强特性 (Enhanced Features)

本项目基于原项目 [sgaofen/cli-in-wechat](https://github.com/sgaofen/cli-in-wechat) 进行二次深度开发，主要包含以下独有改进与提升：

1. **新增通义千问完全适配 (Qwen Code Adapter)**：新增了 `src/adapters/qwen.ts`，全面支持通过 `@qwen` 指令在微信中直接唤起阿里云通义千问模型，并且完美兼容 `plan` 等审批模式。
2. **大幅强化自动文件收发与多媒体系统**：重构了文件路径提取引擎并独立封装多媒体模块（`media.ts`）。现在不仅能精准识别大语言模型回复中包含的包裹式/隐式待发送文件路径，还能非常稳定地利用 CDN 处理各类图片、媒体文件回传微信。即使偶遇传图失败，也会智能回退成常规文本防止漏信。
3. **完善基础设施与命令管理**：拆分并精简了本地终端 CLI 解析与后台守护进程管理（`account.ts` / `daemon.ts`）；增加并重构了可靠性非常高的多媒体和路由测试用例（覆盖率直达 100% 测试通过）。

## 你可以用它做什么

- 在微信里直接问 AI 问题
- 让 AI 读取你发过去的文件
- 让 AI 在你电脑上生成文件，再自动发回微信
- 通过不同 AI 工具完成不同任务
- 在后台常驻运行，随时通过微信调用

## 最短上手

### 1. 安装

先准备：

- Node.js 18+
- 微信已启用 ClawBot 插件
- 至少安装一个 AI CLI 工具

最常见安装方式：

```bash
npm install -g @openai/codex
```

也可以用其他工具：

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @google/gemini-cli
curl -LsSf https://code.kimi.com/install.sh | bash
brew install opencode-ai/tap/opencode
npm install -g @qwen-code/qwen-code
```

### 2. 下载并启动

```bash
git clone https://github.com/sgaofen/cli-in-wechat.git
cd cli-in-wechat
npm install
npm run up
```

如果这是你第一次使用，建议先运行：

```bash
npm run dev
```

先完成扫码登录，再改用：

```bash
npm run up
```

这样更容易看到二维码和初次登录提示。

### 3. 在微信里直接发消息

你可以直接发：

```text
帮我总结今天的会议内容
```

或者：

```text
生成一份周报，并把文件发给我
```

## 最常用命令

日常只需要记住这几个：

```bash
npm run up       # 后台启动
npm run down     # 停止后台
npm run check    # 查看是否运行中
npm run logs     # 查看最近日志
```

开发排障时用：

```bash
npm run dev:debug
```

多微信账号管理：

```bash
npm run acc:list
npm run acc:add
npm run acc:default -- <accountId>
npm run acc:remove -- <accountId>
```

## 微信里怎么用

### 直接发消息

默认会发给上次使用的 AI 工具。

| 你在微信里输入 | 作用 |
|---|---|
| 直接打字 | 发给上次使用的工具 |
| `@claude 写排序算法` | Claude Code |
| `@codex fix the bug` | Codex CLI |
| `@gemini 解释代码` | Gemini CLI |
| `@kimi 重构模块` | Kimi Code |
| `@opencode 分析项目` | OpenCode |
| `@qwen 优化代码` | Qwen Code |

切换后后续消息默认发给该工具。

### 发送文件

```
/sendfile ./output.txt           ← 发送本地文件到微信
/sendfile /tmp/screenshot.png    ← 支持图片、视频、音频等所有类型
```

如果你直接对 AI 说“把文件发给我”或“发送给用户”，桥接层会自动把这个意图翻译成交付指令，要求模型在最终回复里带上可回传的文件路径。

你也可以手动要求 AI 在生成文件后显式声明：

```text
[[sendfile:./dist/report.pdf]]
```

支持相对路径和绝对路径。相对路径会基于当前 `/dir` 工作目录解析。

### 最常见的微信话术

```text
帮我写一份会议纪要
```

```text
读取我刚发的文件，然后总结重点
```

```text
生成一个 PPT，并把文件发给我
```

```text
把这段内容整理成 Markdown 文件，发给我
```

## 常见问题

### 关闭终端窗口后还会运行吗

如果你用的是：

- `npm run dev`：不会，关终端就停
- `npm run up`：会，后台继续运行

### 如何更换绑定的微信账号

停止程序后，删除这个文件，再重新启动扫码：

[`~/.wx-ai-bridge/credentials.json`](/Users/bz/.wx-ai-bridge/credentials.json)

### 能绑定多个微信吗

现在支持多个微信 ClawBot 账号同时运行。

常见操作：

```bash
npm run acc:add
npm run acc:list
npm run acc:default -- <accountId>
npm run acc:remove -- <accountId>
```

说明：

- 每个账号都有独立的登录凭证、轮询进度、上下文 token、会话状态
- 启动服务时会同时启动所有已绑定账号
- 默认账号主要用于本地 `send` 之类命令

### 文件没有作为附件发回来，而是显示成文本内容

通常表示附件上传失败，系统自动退回成普通文字消息。  
这时请看日志。

### 文件发送调试

推荐先用调试模式启动：

```bash
npm run dev:debug
```

最小验证顺序：

```text
/sendfile ./ai-agent-intro.md
```

```text
生成一个 ./tmp/report.md，并把文件发给我
```

重点日志含义：

- `[media] uploading ...`：开始走 CDN 文件上传
- `[media] getuploadurl response keys: ...`：已拿到上传参数
- `[发送文件] CDN上传成功: ...`：文件附件发送成功
- `[发送文件] 作为文本内容回退发送: ...`：附件上传失败，但文本文件已退回成普通文字消息
- `[autoSendFiles] 检测到 ...`：agent 输出里识别到了待发送文件路径

常见问题：

- `缺少 context_token`：用户必须先给 bot 发过至少一条消息
- `文件不存在`：agent 返回了路径，但本地没有生成该文件
- `CDN上传失败`：通常是上传协议、网络、或接口返回格式异常；请贴出完整日志继续排查
- 文本文件被直接显示成内容而不是附件：说明附件上传失败，系统走了文本回退逻辑

## 高级功能

如果你已经熟悉这个项目，可以继续看下面这些能力。

### AskUserQuestion

Claude Code 需要你做选择时，问题自动转发到微信：

```
你发: @claude 帮我新建项目

微信收到:
  Claude Code 需要你的回答:
  ❓ What language?
    1. Python
    2. TypeScript
    3. Rust

你回复: 2
→ Claude 继续执行
```

### 工具接力

```
@claude 分析这个项目的架构
>> @codex 根据分析修复代码
>> 继续优化
@claude>codex 先分析再修复
```

### 恢复历史会话

```
/resume
/resume 3
/session set <uuid>
```

### CLI 工具认证

```bash
claude
codex
gemini
kimi login
# OpenCode: 设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量
qwen
```

## 完整命令列表

### 设置

| 命令 | 作用 | 工具 |
|---|---|---|
| `/status` | 查看所有配置 | 通用 |
| `/model <名>` | 切模型 | 所有 |
| `/mode <auto\|safe\|plan>` | 权限模式 | 所有 |
| `/effort <low\|med\|high\|max>` | 思考深度 | Claude |
| `/turns <数>` | 最大轮次 | Claude |
| `/budget <$>` | API 预算 | Claude |
| `/dir <路径>` | 工作目录 | 通用 |
| `/system <提示>` | 系统提示 | Claude |
| `/tools <列表>` | 允许工具 | Claude |
| `/notool <列表>` | 禁用工具 | Claude |
| `/verbose` | 详细输出 | Claude |
| `/bare` | 跳过配置加载 | Claude |
| `/adddir <路径>` | 额外目录 | Claude/Codex |
| `/name <名>` | 会话命名 | Claude |
| `/sandbox <ro\|write\|full>` | 沙箱 | Codex |
| `/search` | web 搜索 | Codex |
| `/ephemeral` | 临时模式 | Codex |
| `/profile <名>` | 配置 | Codex |
| `/thinking` | 深度思考 | Kimi |
| `/sendfile <路径>` | 发送文件到微信 | 通用 |
| `/approval <模式>` | 审批模式 | Gemini |
| `/include <目录>` | 上下文目录 | Gemini |
| `/ext <名>` | Extensions | Gemini |

### 操作

| 命令 | 作用 |
|---|---|
| `/diff` | 查看 git 差异 |
| `/commit` | 创建 git 提交 |
| `/review` | 代码审查 |
| `/plan [描述]` | 规划 / 切 plan 模式 |
| `/init` | 创建项目配置文件 |
| `/files` | 目录结构 |
| `/compact` | 压缩上下文 |
| `/stats` | 使用统计 |

### 会话

| 命令 | 作用 |
|---|---|
| `/new` | 新会话 |
| `/clear` | 清除所有 |
| `/cancel` | 取消任务 |
| `/fork` | 分支会话 |
| `/resume` | 浏览历史会话，选编号恢复 |
| `/resume <编号\|uuid>` | 恢复指定会话 |
| `/session` | 查看当前会话 ID |
| `/session set <id>` | 跨通道漫游 |

### 快捷

| 命令 | 等效 |
|---|---|
| `/yolo` | mode=auto + effort=max |
| `/fast` | effort=low |
| `/reset` | 重置所有设置 |
| `/cc` `/cx` `/gm` `/km` `/oc` `/qw` | 快速切工具 |

## 权限模式

| 模式 | Claude | Codex | Gemini | Kimi | OpenCode | Qwen |
|---|---|---|---|---|---|---|
| `auto` | `--dangerously-skip-permissions` | `--yolo` | `--approval-mode yolo` | `--print` (自带) | `-p` (自带) | `--approval-mode yolo` |
| `safe` | 默认权限 | `--full-auto` | `--approval-mode default` | 默认 | — | `--approval-mode default` |
| `plan` | `--permission-mode plan` | `--sandbox read-only` | `--approval-mode plan` | — | — | `--approval-mode plan` |

## 配置

`~/.wx-ai-bridge/config.json`：

```jsonc
{
  "defaultTool": "claude",
  "workDir": "/Users/you",
  "cliTimeout": 300000,
  "allowedUsers": [],
  "tools": {
    "claude": { "args": ["--max-turns", "50"] }
  }
}
```

## 架构

```
src/
├── index.ts              # 入口
├── config.ts             # 配置
├── ilink/                # 微信 iLink Bot API
│   ├── types.ts          # 协议类型
│   ├── auth.ts           # QR 扫码登录
│   ├── client.ts         # 长轮询 + 发消息 + typing + 发文件
│   └── media.ts          # 媒体上传 (AES-128-ECB + CDN)
├── adapters/             # CLI 工具适配器
│   ├── base.ts           # 接口 + 共享 helpers (跨平台 spawn)
│   ├── claude.ts         # Agent SDK + CLI 降级
│   ├── codex.ts          # codex exec + stdin 传参
│   ├── gemini.ts         # gemini -p + stdin 传参
│   ├── kimi.ts           # kimi --print + --thinking
│   ├── opencode.ts       # opencode -p -f json
│   ├── qwen.ts           # qwen -p + --approval-mode
│   └── registry.ts       # 自动检测已安装工具
└── bridge/               # 桥接逻辑
    ├── session.ts        # 会话持久化
    ├── formatter.ts      # 响应格式化
    └── router.ts         # @ 路由 + / 命令 + >> 接力 + 链式调用
                          # + /resume 历史会话浏览
                          # + AskUserQuestion 微信转发
```

## 微信 iLink Bot API

微信 2026 年 3 月推出的 ClawBot 插件官方 API：

- 域名：`ilinkai.weixin.qq.com`（腾讯官方）
- 认证：QR 扫码 → Bearer token
- 收消息：HTTP 长轮询 (35s)
- 发消息：POST + context_token
- **官方通道，不封号**

## License

MIT
