# 产品经理技能包 4.0 —— Codex 适配版

本目录原本是给 **Claude Code** 用的技能包。现在同时支持 **OpenAI Codex CLI**，两套互不打架。

---

## 一、给 Codex 用怎么跑

### 1. 在本目录就地使用

Codex CLI 启动时自动读项目根的 `AGENTS.md` 和 `.codex/config.toml`，本目录两个都有。直接：

```bash
codex            # 进入交互模式
```

第一次启动时，hook 系统会：

- **SessionStart**：跑 `.codex/hooks/check-evolution.sh`，扫 feedback 索引
- 后续按需触发：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`

### 2. 复制到别的项目

把这两样拷到目标项目根目录即可：

```
<target>/AGENTS.md
<target>/.codex/
```

`AGENTS.md` 里所有相对路径都基于 `.codex/`，搬过去不用改路径。

### 3. 开启 hook（如果你的 Codex 版本要求显式开启）

`.codex/config.toml` 头部已经写了：

```toml
[features]
codex_hooks = true
```

如果你的 Codex 版本默认未启用 hooks，这一行会自动打开。

### 4. 斜杠命令（可选）

`AGENTS.md` 中提到的 `/product-spec-builder` 等是**约定写法**，不是 Codex 注册过的斜杠命令。你有两种用法：

- **直接说**："调用 product-spec-builder" / "跑一下 code-review" —— AI 会按 `[Skill 调用规则]` 加载对应 SKILL.md
- **挂到 `~/.codex/prompts/`**：自己在 `~/.codex/prompts/product-spec-builder.md` 里写一行 "调用 product-spec-builder"，之后 `/product-spec-builder` 就能用了

---

## 二、文件结构对比

### Claude Code 版（原始）

```
.
├── CLAUDE.md                    # Claude Code 主入口
├── settings.json                # Claude Code hooks
├── agents/                      # Task sub-agent 定义
├── skills/                      # SKILL.md 池
├── hooks/                       # hook 脚本（用 $CLAUDE_PROJECT_DIR）
├── feedback/
└── EVOLUTION.md
```

### Codex 版（新增）

```
.
├── AGENTS.md                    # Codex 主入口
└── .codex/
    ├── config.toml              # Codex hooks 配置
    ├── hooks/                   # Codex hook 脚本（用 stdin.cwd）
    ├── agents/                  # 内联角色定义（不是 Task sub-agent）
    ├── skills/                  # SKILL.md 池（同 Claude 版内容）
    ├── feedback/                # 同 Claude 版
    └── EVOLUTION.md             # 同 Claude 版
```

`.codex/agents/`、`.codex/skills/`、`.codex/feedback/`、`.codex/EVOLUTION.md` **是 Claude Code 版同名目录的副本**。改动时记得两边同步，或者删掉一边只留自己用的那一份。

---

## 三、关键改动

### 1. Sub-Agent → 内联角色

Codex 没有 `Task` 工具。原来"派发 code-reviewer sub-agent"在 Codex 里变成主 Agent 在同一会话内切换角色：

| Claude Code | Codex |
|---|---|
| `Task(subagent_type=code-reviewer, ...)` | 主 Agent `read .codex/agents/code-reviewer.md` + `.codex/skills/code-review/SKILL.md`，以该口吻输出报告，结束时标注"以上为 code-reviewer 报告"切回 |

要严格上下文隔离时改用：

```bash
codex exec --skip-git-repo-check --sandbox workspace-write "<拼好的 prompt>"
```

### 2. Hook：事件名一致，过滤方式不同

Codex hook 配置在 `.codex/config.toml` 的 `[hooks]` 段，事件名跟 Claude Code 一样。**关键差异**：

- Codex 的 `matcher` 是**纯正则**，只能匹配工具名（如 `^Bash$`）；**没有 Claude Code 的 `if:` 字段**
- "只在 git commit 时跑"这类命令级过滤被下沉到脚本里（脚本读 stdin JSON 拿 `tool_input.command` 自己过滤）
- Claude Code 的 `Edit|Write` 在 Codex 中是 `apply_patch`
- `$CLAUDE_PROJECT_DIR` 在 Codex 里不存在；脚本统一读 stdin 的 `cwd` 字段或 `$(pwd)` 兜底

| Claude Code Hook | Codex 对等位置 | 差异 |
|---|---|---|
| `UserPromptSubmit` | `[[hooks.UserPromptSubmit]]` matcher `.*` | 输出字段 `additionalContext` → `systemMessage` |
| `SessionStart` | `[[hooks.SessionStart]]` matcher `startup\|resume` | 同上 |
| `PreToolUse` + `if: Bash(git commit*)` | `[[hooks.PreToolUse]]` matcher `^Bash$` + 脚本里 case 过滤命令 | 过滤逻辑搬到脚本 |
| `PostToolUse` Bash + `if: Bash(git commit*)` | 同上 | 同上 |
| `PostToolUse` matcher `Edit\|Write` | `[[hooks.PostToolUse]]` matcher `^apply_patch$` | 工具名变更 |
| `Stop` 输出 `{"decision":"block",...}` | `[[hooks.Stop]]` 输出 `{"continue":false,"stopReason":...}` | 阻塞字段名变更 |

所有适配后的脚本在 `.codex/hooks/`。

### 3. 工具名对照

| Claude Code | Codex |
|---|---|
| `Bash` | `Bash` / `shell` |
| `Read` | `read`（内置） |
| `Edit` / `Write` | `apply_patch` |
| `Glob` / `Grep` | `shell` + `rg` / `find` |
| `Task(subagent_type=X)` | 内联角色 + `codex exec`（隔离时） |

---

## 四、Windows 上跑脚本的注意

`.codex/hooks/*.sh` 是 bash 脚本，依赖 `jq`、`grep`、`find`、`npx`。在 Windows 上需要装：

- **Git for Windows**（自带 `bash` + 基础 GNU 工具）
- **jq**（`winget install stedolan.jq` 或 `scoop install jq`）
- **Node.js**（`npx tsc --noEmit` 用）

`.codex/config.toml` 里 `command = "bash .codex/hooks/xxx.sh"` 用的是 `bash`，必须在 PATH 里能找到。如果 Codex 在 Windows 上启动 bash 有问题，可以改成 `wsl bash .codex/hooks/xxx.sh` 或 `pwsh -c "bash ..."`。

---

## 五、维护清单

改技能内容时：

- [ ] 改 `skills/<name>/SKILL.md`（Claude Code 用）
- [ ] 同步 `.codex/skills/<name>/SKILL.md`（Codex 用）

改 agent 角色定义时：

- [ ] 改 `agents/<name>.md`（Claude Code，带 `model`/`color` 字段）
- [ ] 同步 `.codex/agents/<name>.md`（Codex，带 `mode: inline-role` 字段）

改 hook 行为时：

- [ ] 改 `hooks/<name>.sh`（Claude Code，用 `$CLAUDE_PROJECT_DIR` 和 `if:` 过滤）
- [ ] 同步 `.codex/hooks/<name>.sh`（Codex，用 stdin.cwd 和脚本内过滤）
- [ ] 改 `settings.json` 和 `.codex/config.toml`（如新增/删除事件）

改主指令时：

- [ ] 改 `CLAUDE.md`（Claude Code）
- [ ] 同步 `AGENTS.md`（Codex，路径前缀 `.claude/` → `.codex/`，Task 派发 → 内联角色）

如果只想保留一个版本，直接把另一边删掉（比如只用 Codex，可删 `CLAUDE.md`、`settings.json`、根目录的 `agents/skills/hooks/feedback/EVOLUTION.md`）。

---

## 六、已知限制

1. **Codex 没有原生 sub-agent**。本包用"内联角色 + 报告前缀切换"模拟，质量取决于主 Agent 自觉性。需要 fresh context 隔离时必须显式 `codex exec`。
2. **Hook 的 stdin JSON schema 在 Codex / Claude Code 之间存在字段命名差异**。脚本用了多字段兜底（`prompt // user_prompt`，`tool_input.command // tool_input.input.command` 等），新版本 Codex 如果改 schema，需要回头补字段。
3. **Stop hook 的 `continue:false` 输出格式来自 Codex 文档；如果你的 Codex 版本忽略该字段、不阻塞**，把 `stop-gate.sh` 输出改成 `systemMessage` 提示用户即可（不再硬阻塞）。
