# dsh-language-tutor

在 DSH 里写代码时顺手练外语。

这个插件把语言学习放在正常对话旁边：你的问题照常发给 Agent，写作检查另起一个后台请求；翻译、语法说明和单词卡以 DSH 会话卡片显示，不会混进主模型的上下文。

项目参考了 [pi-language-tutor](https://github.com/mackt/pi-language-tutor) 的使用方式，并按 DSH 的宿主、命令、LLM 和 Web 扩展接口重新实现。原项目的 MIT 许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 能做什么

- 用学习语言提问时，检查拼写和语法，并给出更自然的表达。
- 用母语提问时，教你怎样用学习语言表达同一个意思；重点词汇会自动加入单词卡。
- 点击回答下方的 `🌐`，或运行 `/translate`，生成原文和译文交替出现的双语卡片。
- 运行 `/flashcards` 复习单词。调度使用 FSRS，评分分为 Again、Hard、Good、Easy。
- 可自动翻译较长的最终回答，也可为检查或翻译附带一小段最近的会话上下文。

Web 卡片直接使用 DSH 的按钮、Markdown 渲染器、颜色变量和会话槽位。插件只补了卡片排版，没有另做一套主题。

## 兼容性

当前实现按 DeepSeek Harness `b150a551` 的接口编写，对应 DSH 包版本 `0.1.1-rc.2`。主要使用这些新接口：

- `agent/request`：取得当前会话的模型路由，同时并行启动写作检查；
- `ctx.llm.stream()` 和 `BlockAssembler`：执行并组装辅助模型请求；
- `ctx.commands.register()`：注册 `/lang`、`/translate` 和 `/flashcards`；
- `conversationEvents`、`conversation.chat.node`、`conversation.chat.assistant-actions`：显示学习卡片和翻译按钮。

富交互卡片面向 DSH Web profile。Headless profile 可以加载宿主插件，但不会显示这些 Web 卡片。

## 安装

从源码构建并安装到 `web` profile：

```sh
git clone https://github.com/wangyafu/dsh-language-tutor.git
cd dsh-language-tutor
npm install
npm run build
cd ..
dsh plugin --profile web add ./dsh-language-tutor
```

先检查配置层是否加载，再启动 DSH：

```sh
dsh --profile web --dump-config
dsh --profile web
```

如果不想让 profile 链接源码目录，可以先打包：

```sh
cd dsh-language-tutor
npm pack
dsh plugin --profile web add ./dsh-language-tutor-0.1.0.tgz
```

也可以直接从 GitHub 安装：

```sh
dsh plugin --profile web add github:wangyafu/dsh-language-tutor#<commit>
```

Git 安装会运行仓库里的 `prepare` 构建 TypeScript。pnpm 10 及以上版本可能先拒绝该脚本；按照 DSH 打印的提示，把确切的包名加入该 profile 的 `pnpm-workspace.yaml` `allowBuilds`，再执行一次安装即可。只应给已检查过并固定到 commit 的源码开放构建权限。

卸载：

```sh
dsh plugin --profile web remove dsh-language-tutor
```

## 开始使用

默认学习英语，母语为简体中文。装好后先试这几步：

1. 用英语向 Agent 提一个完整问题。Agent 会正常回答，写作卡片稍后出现在会话里。
2. 换成中文问同样的问题。插件会给出自然的英文整句、重点词汇和相关语法。
3. 点击任意最终回答下方的 `🌐` 查看双语版本。
4. 运行 `/flashcards`，显示答案后给卡片评分。

写作检查失败不会影响 Agent 请求。辅助请求默认跟随当前会话的 provider/model；如果想单独使用便宜一些的模型，可运行：

```text
/lang model deepseek-official/deepseek-v4-flash
```

恢复为跟随会话模型：

```text
/lang model default
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `/lang` | 查看当前设置和用法 |
| `/lang check off\|on\|context` | 关闭检查、普通检查，或带最近会话片段检查 |
| `/lang tutor on\|off` | 开关母语到学习语言的教学模式 |
| `/lang auto on\|off` | 开关自动翻译 |
| `/lang native <code>` | 设置说明和译文语言，如 `zh-CN`、`ja` |
| `/lang learning <code>` | 设置正在学习的语言，如 `en`、`fr` |
| `/lang model <provider/model>` | 指定辅助请求使用的 DSH 模型路由 |
| `/lang model default` | 重新跟随当前会话模型 |
| `/lang context on\|off` | 开关翻译时的最近会话片段 |
| `/translate` | 翻译最后一条助手回答 |
| `/flashcards` | 开始一轮到期卡片复习 |
| `/flashcards stats` | 查看卡片数量和下次到期时间 |
| `/flashcards add <word> :: <note>` | 手动加入一张卡片 |
| `/flashcards stop` | 停止当前复习轮次 |

`/flashcards show ...` 和 `/flashcards rate ...` 是 Web 卡片按钮使用的内部命令，平时不需要手打。

## 配置

大多数设置直接用 `/lang` 修改即可。它们保存在：

```text
$DSH_HOME/state/dsh-language-tutor/settings.json
```

单词卡保存在同目录的 `flashcards.json`。如果没有设置 `DSH_HOME`，默认目录是 `~/.dsh`。

安装时也能在 profile 的 `cordis.patch.yml` 里给插件设初值：

```yaml
- id: language-tutor
  config:
    learning: en
    native: zh-CN
    check: on
    tutor: true
    auto: false
    context: false
    provider: deepseek-official
    model: deepseek-v4-flash
    maxOutputTokens: 1200
    timeoutMs: 30000
    retries: 1
    flashcardSessionLimit: 20
    flashcardNewPerDay: 10
    requestRetention: 0.9
```

`provider` 和 `model` 必须一起填写。已有的 `settings.json` 优先于这些初值，因此升级或重启不会覆盖你通过 `/lang` 做过的选择。

## 一些具体行为

- 少于 4 个有效文字单位、命令、代码围栏、符号过多或明显像代码的输入不会触发检查。
- 一次写作检查最多处理 1500 个字符，最多返回 5 个错误、5 个词汇和 3 个语法点。
- 自动翻译只处理至少 15 个文字单位且不含工具调用的最终回答。
- 翻译最多读取 12000 个字符。5 行以内的代码块原样显示，更长的代码块在双语卡片里折叠为行数提示。
- `check context` 和 `context on` 最多附带最近 8 条消息、约 4500 个字符；它们不会复制整段工具轨迹。
- 辅助请求有独立超时和有限重试。失败只记入 DSH 日志，不会中断主对话。

## 开发

```sh
npm install
npm run check
npm test
npm run build
npm pack --dry-run
```

测试覆盖输入筛选、模型输出解析、Markdown 分段、设置持久化、卡片去重和 FSRS 调度。`client.js` 是 DSH Web 模块加载器直接读取的浏览器包，使用普通 JavaScript 和 `React.createElement`，不需要单独的前端构建步骤。

## License

[MIT](LICENSE)
