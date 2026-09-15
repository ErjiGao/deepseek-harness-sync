# deepseek-harness-sync

[English](README.md) | 中文

用**你自己的 GitHub 私有仓库**，在多台电脑之间同步 DeepSeek Harness（DSH）配置。

```text
设备 A 的 DSH 配置  →  harness-sync push  →  你的私有仓库
                                                    ↓
设备 B 的 DSH 配置  ←  harness-sync pull  ←  你的私有仓库
```

---

## 1. 它做什么，不做什么

**做**：

- 读取 `$DSH_HOME` 下的**白名单配置**（见 §9），按**原文**打包成一个带版本号的快照；
- 通过 `git` 推送到你自己的私有仓库，或从中拉取并应用；
- 每次覆盖前自动备份，保留最近 5 份，随时 `rollback`。

**不做**：

- **不解析、不理解、不改写你的配置。** `settings.yaml` 按逐字节原文存取，你的注释、锚点、格式全部保留。
- 不同步会话记录、附件、统计数据库、`node_modules`。
- 不接触任何凭证；仓库里、插件配置里、日志里都不会出现 token。
- 没有数据库、云服务器、Docker、账号系统、第三方同步服务器。

---

## 2. 开始之前：两条硬性前提

### 2.1 配置仓库**必须**是 Private

仓库里会有你的**机器名**、**插件清单**、**`settings.yaml`**。`init` 会尽力阻止你犯错：

- 有 token 时，查 GitHub API 并断言 `private === true`，**是 public 就直接失败**；
- 没有 token 时无法查 API（凭证助手只给 git 用），此时会**明确警告**，请你自行确认。

### 2.2 需要 Git，以及能 push 的凭证

`harness-sync` 用 `git` 干活（这也是白拿的：历史、冲突检测、跨平台凭证管理全都由 git 提供）。见 §4。

---

## 3. 架构：一个核心，两个门面

```text
终端     ──►  bin/harness-sync.js   （CLI）        ─┐
                                                   │
对话/GUI ──►  lib/index.js          （DSH 宿主插件）├─►  lib/core/*   全部逻辑
               · 4 个工具（模型可调用）              │
               · /harness-sync（人可调用）           │
               · lib/host/api.js（回环 HTTP 桥）      │
                                                   │
设置页面 ──►  lib/client.js         （浏览器插件）   ─┘
               · 设置 →「配置同步」页
               · 一键「上传到 GitHub」按钮
```

三个入口跑的都是同一套 `lib/core`，所以终端里的 `harness-sync push`、对话里的 `/harness-sync push`、
设置页面上的「上传到 GitHub」按钮**行为完全一致**，不可能各自漂移。

**关于 `dsh` 子命令的重要说明**：DSH **不支持**插件注册 CLI 子命令 —— `dsh` 的命令语法是固定的，只有
默认启动、`dsh web`、`dsh plugin`。所以 `harness-sync` 是一个**独立的可执行命令**，而不是 `dsh harness-sync`。
这不是偷懒，是 DSH 当前的架构边界。

CLI 独立于 DSH 运行：**DSH 没启动也能用**。插件那一半是可选的。

---

## 4. 安装

### 方式 A：从你的 GitHub 仓库安装（换电脑推荐）

```bash
dsh plugin --profile web add github:<你的账号>/deepseek-harness-sync
```

如果 `dsh` 不在 PATH 上：

```bash
npx @deepseek-ai/dsh plugin --profile web add github:<你的账号>/deepseek-harness-sync
```

> 本包**零构建**（没有 `prepare` 脚本、没有依赖）。这一点很关键：pnpm 默认会拦截从 Git 安装的包的构建脚本，
> 必须手工往 `pnpm-workspace.yaml` 的 `allowBuilds` 里加白名单才能装好 —— 本插件刻意避开了这个坑，
> 所以 `github:` 安装开箱即用，新电脑上不需要 Node 工具链。

### 方式 B：本地目录

```bash
git clone https://github.com/<你的账号>/deepseek-harness-sync.git
dsh plugin --profile web add /绝对路径/deepseek-harness-sync
```

### 生效

`dsh plugin` 会**自动**把这个包加进 profile 的 `dsh.profile.bundles`（因为它在 `package.json` 里声明了
`dsh.bundle`），**不需要手改任何文件**。然后**重启 `dsh web`**。

### 找到 CLI

装进 profile 后，`harness-sync` 位于：

```text
$DSH_HOME/profiles/web/node_modules/.bin/harness-sync
```

三种调用方式，任选：

```bash
# 1. 直接路径（Windows 加 .cmd）
"$DSH_HOME/profiles/web/node_modules/.bin/harness-sync" status

# 2. 用 node 跑插件目录里的入口（永远可用）
node /绝对路径/deepseek-harness-sync/bin/harness-sync.js status

# 3. 建议：加个别名
alias hsync='node /绝对路径/deepseek-harness-sync/bin/harness-sync.js'
```

> **插件安装和配置恢复是两件事。** 插件从**插件仓库**装；配置从**另一个私有仓库**拉。
> 两个仓库分开，正是为了让插件不依赖任何一台电脑上的本地文件。

---

## 5. 创建配置仓库（**必须 Private**）

1. 打开 <https://github.com/new>。
2. 名字例如 `deepseek-harness-config`。
3. **选中 Private。** ← 这一步不能省。
4. **不要**勾选 "Add a README"／`.gitignore`／license —— 留空仓库最省事。
   （如果勾了也没关系，第一次 `push` 会在它之上生成新提交。）
5. Create repository。

仓库的最终内容（由本插件生成，**不要手改**）：

```text
deepseek-harness-config/
├── config/
│   └── harness-config.json   # 快照：版本 + 时间 + 设备 + 各文件原文
├── metadata.json             # 小索引：版本、时间、设备、各文件 sha256
├── README.md
└── .gitignore                # 机密二次兜底
```

### 复用你已经有的仓库

如果你已经有一个仓库（例如另一个工具在用的），可以直接复用，**不会破坏里面已有的内容**：

```bash
harness-sync init --url https://github.com/<你>/DSH-Sync-Data.git --branch main
```

四个路径的冲突处理各不相同：

| 路径 | 冲突处理 |
|---|---|
| `config/harness-config.json` | 本插件独有，每次覆盖 |
| `metadata.json` | 本插件独有，每次覆盖 |
| `README.md` | **只在不存在、或确认是本插件写的时才写**。别人的 README 原样保留，并打印 `kept the repository's own README.md` |
| `.gitignore` | 不存在则创建；已存在则**只追加**本插件那一块（带标记、幂等，重复 push 不会追加第二次） |

已在一个**含 88 个文件、并自带自己 README 的真实仓库镜像**上实测：push 之后原有 README 逐字节未变、
`snapshots/` 下 88 个文件全部保留，只新增了 `.gitignore`、`config/harness-config.json`、`metadata.json`。

> 提示：`dsh-config-manager` 之类的工具用 `snapshots/<uuid>/…` 布局，本插件用 `config/` 与
> `metadata.json`，两者文件名不冲突，可以长期共存。

---

## 6. GitHub 授权

三种方式，**按优先级**。

### 6.1 系统 Git 凭证管理器（默认，推荐）

**什么都不用配。** 直接 `harness-sync push`，第一次会由 Git Credential Manager（Windows／macOS）
或 libsecret（Linux）弹出浏览器授权，之后长期有效。

**这条路下 token 完全不经过本插件** —— 它不读、不写、不打印、不存储。

### 6.2 环境变量（CI／无凭证管理器的机器）

```bash
export GH_TOKEN=github_pat_xxx      # 或 GITHUB_TOKEN
```

**最小权限**：建一个 **fine-grained PAT**：

- Repository access → **Only select repositories** → 只勾 `deepseek-harness-config`；
- Permissions → Repository permissions → **Contents: Read and write**（就这一项）；
- 有效期按需设置。

插件会通过 `GIT_CONFIG_COUNT` 环境变量把 token 注入给 git 子进程。**已验证**该机制下：

| 要求 | 是否满足 |
|---|---|
| 不写入 Git（远程 URL、`.git/config`） | ✅ token 不进入任何文件 |
| 不写入配置仓库 | ✅ |
| 不出现在日志／终端 | ✅ 所有 git 输出回显前做脱敏 |
| 不接受 `--token` 参数 | ✅ 故意不支持（命令行参数会被同机其它进程看到） |
| 最小必要权限 | ✅ fine-grained PAT，仅 `Contents: Read and write` |

### 6.3 GitHub CLI

若装了 `gh` 且已 `gh auth login`，插件会自动执行 `gh auth token` 取用，走 6.2 的通道。本机没装 `gh` 也没关系。

> **OAuth Device Flow 没有实现**（P1）。它需要你自己注册一个 GitHub OAuth App 才有 client_id，
> 还要再找地方安全存 token —— 比上面三条路都更麻烦。

---

## 7. 首次配置

```bash
harness-sync init
```

交互式询问：

```text
GitHub username: 你的账号
Repository name [deepseek-harness-config]:
Branch [main]:
```

也会校验：仓库可达性、是否 Private。非交互式（脚本／CI）：

```bash
harness-sync init --user <账号> --repo <仓库> --branch main
# 或直接给 URL
harness-sync init --url https://github.com/<账号>/<仓库>.git
```

`init` 会写 `$DSH_HOME/harness-sync/config.json`（**该文件结构上没有 token 字段**，读到 token 字段会直接报错）

---

## 8. 日常使用

### `push` —— 上传本机配置

```bash
harness-sync push
```

```text
Push
  Repository:             https://github.com/you/deepseek-harness-config.git
  Branch:                 main
  Device:                 DESKTOP-ABC
  Version:                4 → 5
  Files:                  7
       profiles/web/cordis.patch.yml
       profiles/web/cordis.yml
       profiles/web/package.json
       profiles/web/pnpm-workspace.yaml
       settings.yaml
       ...
OK    pushed version 5 to main
```

`push` **只读本地配置，从不写本地配置**。它做两件防护：

1. 上传前做**机密扫描**，命中即拒绝（见 §10）；
2. 如果远端在你上次同步之后前进过，**拒绝覆盖**并给出三选一菜单（见 §8.4）。

### `pull` —— 应用远端配置

```bash
harness-sync pull
```

```text
OK    backed up current configuration to .../backup/harness-config-2026-09-15-1830.json
  written  settings.yaml
  same     profiles/web/cordis.yml
OK    applied version 5
```

**每次 pull 之前一定先备份，不问、不可跳过。**

### `sync` —— pull → 检查差异 → 同步

```bash
harness-sync sync
```

判定表（**永不静默覆盖**）：

| 本地 vs 远端 | 动作 |
|---|---|
| 内容一致 | 报告 `already synchronized`，不做任何写入 |
| 远端更新、本地干净 | 自动 pull |
| 本地有改动、远端未动 | 自动 push |
| **双方都有内容／都变了** | **停下**，给三选一菜单，退出码 2 |

特别地：**一台从没同步过的新设备跑 `sync` 会停下**，不会把你其它机器上的真实配置覆盖成一份刚装好的默认配置。

### `status` —— 查看状态

```bash
harness-sync status
```

```text
GitHub repository: connected
Local config: found
Remote config: found

Local version: 5
Remote version: 4

Status: local configuration has unpushed changes
```

下面是明细块（仓库、分支、profile、设备、认证方式、上次同步时间、逐文件清单、机器相关依赖警告）。

`Status` 的可能取值：

| 值 | 含义 | 退出码 |
|---|---|---|
| `synchronized` | 两边一致 | 0 |
| `local configuration has unpushed changes` | 本地领先 | 1 |
| `remote configuration is newer` | 远端领先 | 1 |
| `diverged — both sides changed` | 双方都变了 | 2 |
| `the configuration repository could not be reached` | 网络／认证问题 | 1 |
| `this device is not initialized` | 还没 `init` | 1 |

### `diff` —— 逐文件看差异

```bash
harness-sync diff
```

```text
Differences — left is this device, right is DESKTOP-XYZ
  "-" lines are only here, "+" lines are only in the repository

settings.yaml:
  @@ after 2 unchanged line(s) @@
  -   model: device-a
  +   model: device-b
```

### 8.4 冲突处理

版本号规则：本地记 `localVersion`（本地快照版本）与 `baseVersion`（最后一次成功同步时**远端**的版本）。
`push` 前先 fetch，若 `remoteVersion > baseVersion`，说明**远端在你不知道的时候前进过**，于是：

```text
Remote configuration has changed.

Local:  version 12
Remote: version 11

Please choose:

1. Pull remote configuration      harness-sync pull
2. Force push local configuration harness-sync push --force
3. Show differences               harness-sync diff
```

在终端里是有编号的可交互菜单；在 GUI 斜杠命令或脚本里（非交互）则打印上面这段并以**退出码 2** 结束。

> **`--force` 的准确语义（重要）**：它**不是** `git push --force`。
> `harness-sync` 每次先把本地工作副本重置到远端最新提交，再在其上追加一个新版本，所以推送**总是快进**。
> 它**只覆盖配置内容**，**永远不会改写或丢弃远端历史**。远端仍然是 `v1 → v2 → v3`，你可以从任何一步回退。
> 这也意味着：所谓的"强制推送"依然可以事后挽救。

### `rollback` —— 恢复备份

```bash
harness-sync rollback --list    # 列出（新→旧）
harness-sync rollback           # 恢复最近一次
harness-sync rollback --to 2    # 按列表序号
harness-sync rollback --to harness-config-2026-09-15-1830.json
harness-sync rollback --to D:/somewhere/my-export.json   # 也可以直接给导出文件的路径
```

**rollback 自身也是可撤销的**：执行前会先把当前配置也备份一份。

> 通过 HTTP 桥（设置页面）调用时，`to` 只接受**序号**或**文件名**，不接受路径 —— 浏览器侧无法指定任意文件。

### `export` —— 把当前配置导出成一个文件

```bash
harness-sync export
```

把本机当前配置写成一个可恢复的快照文件：

```text
Export
  File:                   harness-config-2026-09-15-1932.json
  Location:               ~/.dsh/harness-sync/exports/harness-config-2026-09-15-1932.json
  Files:                  7
  Profile:                web
OK    wrote a restorable snapshot of this device
```

- 导出文件放在 **`exports/`**，与 `pull` 自动维护的 `backup/` **分开**：`backup/` 会被轮转裁剪到 5 份，
  而 `exports/` **永远不会被自动删除**（你主动要的东西不该被下一次 pull 悄悄清掉）。
- 导出文件就是普通的快照，所以可以直接用 `harness-sync rollback --to <路径>` 还原。
- 在设置页面里点 **「导出备份」**，宿主写完之后会**同时触发浏览器下载**，于是它既在你的下载目录里，
  也留在 `exports/` 里。

```text
Backups in .../harness-sync/backup (newest first)
  1. harness-config-2026-09-15-1851-2.json  v0  5 file(s)  2026-09-15 18:51  before rollback to harness-config-2026-09-15-1851.json
  2. harness-config-2026-09-15-1851.json    v0  5 file(s)  2026-09-15 18:51  before pull to v1
```

### 在 Web GUI / 对话里用

插件注册了 4 个工具（模型可调用）和 1 个斜杠命令（人可直接敲）：

| 工具 | 作用 |
|---|---|
| `harness_sync_status` | 只读，看状态 |
| `harness_sync_push` | 上传（可带 `force`、`dryRun`） |
| `harness_sync_pull` | 应用（可带 `dryRun`） |
| `harness_sync_rollback` | 恢复备份（可带 `list`、`to`） |

```text
/harness-sync status
/harness-sync push
/harness-sync sync
/harness-sync rollback --list
```

### 在设置页面里一键同步（图形界面，不需要终端）

插件在 **设置（Settings）** 面板里注册了自己的页面：**「配置同步」**（`order: 60`，排在官方页面之后）。
**重启 `dsh web` 后**，打开侧栏底部的设置，导航里就会出现它。

| 控件 | 作用 |
|---|---|
| **上传到 GitHub**（主按钮） | `push` —— 把本机配置作为新版本提交并推送 |
| 拉取 | `pull` —— 应用仓库配置（会先自动备份） |
| 一键同步 | `sync` —— 先比较两边再决定；**分叉时不会擅自覆盖** |
| 导出备份 | `export` —— 把当前配置写成一个快照文件，并触发浏览器下载到本机 |
| 刷新 | 重新读取状态 |
| 高级 ▸ 预演上传 / 预演拉取 / 查看备份 / 回滚最近一次 / 强制上传 | 对应 `--dry-run`、`--list`、`rollback`、`--force` |

页面同时显示：仓库、分支、设备名、本地/远端版本、上次同步时间、认证方式、**仓库是否私有（以及有没有被真正校验过）**、
逐文件清单、以及**换电脑会失效的 `link:` 依赖警告**。每次操作的完整命令输出直接显示在页面下方。

**未初始化时**，页面会变成连接表单：填入仓库 URL 与分支，点「连接仓库」即可完成 `init`，
并在连接之前就展示「将会同步哪些文件」。

> 配色全部使用主题自带的 `--dsw-*` token（每个都带兜底值），所以亮色 / 暗色 / 第三方主题下都正常。
> 界面是**手写的浏览器 bundle**（`lib/client.js`），**没有 JSX、没有打包步骤**，理由见 §14。

#### 这个页面的安全边界

浏览器半边是静态资源，无法调用内核的 `/api`，因此宿主半边在**回环 Web 服务器**上注册私有路由
`/harness-sync/api/*`，页面用同源 `fetch` 访问。它在内核 `/api` 的 cookie 栅栏之外，所以每次请求都过三道检查：

1. **对端 socket 必须是回环地址**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）；
2. **`Sec-Fetch-Site: cross-site` 一律拒绝**（浏览器设置，页面无法伪造），若带 `Origin` 则必须与 `Host` 同源；
3. **改变状态的动作只接受 `POST`**（`init`/`push`/`pull`/`sync`/`rollback`），`status` 只接受 `GET`。

未知端点返回 **404**（不会落到命令上假装成功）；响应里**永远不含任何凭证**。

---

## 9. 同步什么 / 绝不同步什么

### 同步（**白名单**，不是"遍历后排除"）

| 路径（相对 `$DSH_HOME`） | 内容 |
|---|---|
| `settings.yaml` | 用户设置主文档（主题、语言、默认模型、默认预设…） |
| `profiles/<profile>/package.json` | `dsh.profile.bundles` + `patchReload` |
| `profiles/<profile>/cordis.patch.yml` | 你的补丁层 |
| `profiles/<profile>/cordis.yml` | profile 根（启动器期望它存在） |
| `profiles/<profile>/pnpm-workspace.yaml` | linker / `allowBuilds` 策略 |
| `profiles/<profile>/pnpm-lock.yaml` | 精确版本 |
| `profiles/<profile>/.dsh-market/state.json` | 哪些插件被你禁用 |
| `.agent-presets/**` | 你自建的 agent 预设（**存在才同步**） |
| `skills/**` | 你的技能（**存在才同步**） |
| `AGENTS.md` | 用户全局指令基线（**存在才同步**） |
| `cordis.patch.yml`（home 根） | 全局补丁层，优先级高于 profile 层（**存在才同步**） |

### 绝不同步

| 类别 | 例子 | 为什么 |
|---|---|---|
| **机密** | `.credentials.yaml`、`dsh-pocket/token`、`.env` | 就是机密 |
| **机器相关** | `bin/dsh.cmd`、`profiles/node_modules/` | 硬编码本机路径／可重建 |
| **运行时状态** | `sessions/`、`attachments/`、`storages/`、`tokenledger.sqlite*`、`llm-deepseek/` | 会话与遥测，且体积大（本机实测 `sessions` 19.7 MB、`attachments` 10.5 MB） |
| **第三方私有数据** | `dsh-config-manager/`、`integrations/`、`.src/` | 不属于配置 |

`$DSH_HOME/.env` **故意不同步**：DSH 只允许这个文件承载代理凭证。想同步代理设置请用 README 里的
`git config --global http.proxy`（见 §11）。

---

## 10. 安全性

### 10.1 为什么是白名单，而不是"遍历 + 排除"

因为在一台真实机器上实测发现了这个：

| 文件 | SHA-256 |
|---|---|
| `$DSH_HOME/.credentials.yaml` | `85AC4345…64CE` |
| `$DSH_HOME/dsh-config-manager/vault/.credentials.yaml` | **同一个哈希（逐字节相同的明文副本）** |

第三方插件可以把你的凭证库**明文复制**到自己的目录里。任何"递归遍历 `$DSH_HOME` 再排除
`*.credentials.yaml`"的写法都会把它传上去。

所以 `lib/core/manifest.js` **从不枚举 `$DSH_HOME`**，每个路径都是写死的；而且
`assertManaged()` 会在**落盘之前**重新校验快照里的每一个路径（拒绝绝对路径、盘符、UNC、`..`、
反斜杠、NUL，以及任何不在白名单里的路径）。有一条回归测试专门断言：**收集结果里不存在任何
SHA 等于凭证库的文件**。

### 10.2 `settings.yaml` 不是天然安全的

DSH 的设置服务支持 `role('secret')` 字段，而且**有官方插件真的这么声明**
（`dsh-web-search-deepseek` 声明了 `apiKey`）；同时文件型 provider **没有** `${env:VAR}` 间接引用。
所以一旦你把 key 填进 UI，它就明文躺在 `settings.yaml` 里。

因此上传前有**两层检查**：

1. **内容形态**：`ghp_` / `github_pat_` / `sk-` / `AKIA` / `AIza` / `xox*` / JWT / `-----BEGIN … PRIVATE KEY-----`；
2. **叶键名**：`apiKey` / `token` / `secret` / `password` / `credential` … 且值看起来是真值（不是
   `${env:…}`、不是全大写环境变量名）。

命中即**拒绝 push**（退出码 1），并且**不打印命中的内容** —— 只给文件与行号。

### 10.3 沙箱披露

插件自己 `spawn` 的 `git` **不受 DSH 沙箱约束**，以你的完整用户权限运行。这是必要的（要读写
`$DSH_HOME`），但也意味着：**请只在自己的机器上运行它，并且只把它指向你自己的私有仓库。**

### 10.4 删除语义（需要你知道）

`pull` 会**删除**那些在快照里被明确记录为「不存在」的固定文件（例如源机器上没有 `AGENTS.md`，
而你本机有）。这样做是为了让"删除"也能同步。因为每次 pull 前都会备份、且会打印 `deleted <路径>`，
所以它是可撤销的 —— 但它确实是**会删文件**的操作。

---

## 11. 故障排查

### `cannot reach the repository` / `Failed to connect` / `Connection was reset`

本机到 GitHub 的网络不通，或需要代理。先确认 git 本身能连：

```bash
git ls-remote https://github.com/<你>/<仓库>.git
```

需要代理就配 git（**这是唯一推荐的代理配置位置**）：

```bash
git config --global http.proxy  http://host:port
git config --global https.proxy http://host:port
```

### `Authentication failed` / `could not read Username`

git 拿不到凭证。三选一：

1. 在终端里对仓库跑任意一次 git 命令，让 Git Credential Manager 弹窗登录；
2. `export GH_TOKEN=...`（fine-grained PAT，`Contents: Read and write`，只勾这一个仓库）；
3. `gh auth login`。

注意 `harness-sync` 总是设置 `GIT_TERMINAL_PROMPT=0`，**不会**卡在等输入上；凭证管理器的
图形／浏览器流程不受影响。

### `repository not found`

仓库名写错、或凭证没有访问该仓库的权限（私有仓库对无权限者返回 404）。

```bash
harness-sync status        # 看当前配的 repoUrl 和 branch
```

要改配置就重新 `init`（会保留已有版本历史）。

### `refusing to push: N credential-like value(s) found`

扫描命中了。**它不会告诉你命中的内容**（故意的），只给文件和行号。

打开那个文件，把值换成运行时的环境变量引用，或在 DSH 里改成不落盘的方式，然后重新 push。
若确实是误报（例如某个字段名恰好叫 `token` 但值不是机密），改一下字段名即可绕开。

### 从 `github:` 安装时 pnpm 提示 `Ignored build scripts`

本包**零构建**，正常情况下不会出现。如果出现，说明你装的是别的包，或你在改这个插件时加了
`prepare` 脚本。解决办法是往 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds`
里加对应的键 —— 但更好的办法是**不要加构建步骤**，本插件刻意保持零构建就是为了避开这件事。

### `link:` / `file:` 依赖警告

`push` / `pull` 会报告形如：

```text
WARN  2 dependency spec(s) point at a directory on THIS machine and will not resolve elsewhere:
         profiles/web/package.json:11  link:D:/somewhere/dsh-gaussian-dft
         profiles/web/pnpm-lock.yaml:27  link:D:/somewhere/dsh-vasp-dft
```

**这些会被原样同步**（插件不替你改写）。新设备上需要你手工决定：

- 把那个插件也发布／clone 过去，然后改成本地路径或仓库地址；
- 或者从 `dsh.profile.bundles` 和 `dependencies` 里删掉，然后 `pnpm install`。

### 新设备 `pnpm install` 失败

通常就是上面的 `link:` 依赖。在 profile 目录里执行：

```bash
cd "$DSH_HOME/profiles/web"
pnpm install --no-frozen-lockfile
```

（锁文件里带着本机路径时，冻结校验会失败。）

### `Status: the configuration repository could not be reached`

同上，先解决网络／认证。`status` 会把 git 的原始错误和对应建议一起打出来。

### 版本号看起来不对

规则是：`localVersion` 是"本地内容对应的版本"，若本地有未推送改动则显示 `localVersion + 1`
（也就是**它将被推送成的版本**）；`remoteVersion` 是远端快照的版本。两者相等且内容一致时才是
`synchronized`。

### 想彻底卸载

```bash
dsh plugin --profile web remove deepseek-harness-sync
```

`dsh plugin` 会自动把它从 `dsh.profile.bundles` 里摘掉。然后按需删除：

```text
$DSH_HOME/harness-sync/            # 本插件的数据：config.json、repo/、backup/、exports/
```

配置仓库在 GitHub 上，需要你自己去删。

---

## 12. 命令参考

```text
harness-sync <command> [options]

init       连接一个私有配置仓库
status     对比本机与仓库
push       上传本机配置
pull       应用仓库配置到本机
sync       pull → 检查差异 → 同步
diff       逐文件显示差异
rollback   恢复本地备份
export     把本机当前配置导出成一个快照文件
```

| 选项 | 说明 |
|---|---|
| `--root <dir>` | 把 `<dir>` 当作 harness home（替代 `$DSH_HOME` / `~/.dsh`） |
| `--data-root <dir>` | 本插件数据目录（替代 `<harness home>/harness-sync`） |
| `--profile <name>` | 要同步的 profile，默认 `web` |
| `--device <name>` | 写进快照的设备名，默认本机主机名 |
| `--url` / `--user` / `--repo` / `--branch` | `init` 的非交互输入 |
| `--force` | 即使远端已前进也继续（`push`） |
| `--dry-run` | 只报告，不写入 |
| `--list` / `--to` | `rollback` 列出／选择备份 |
| `--no-color` | 关闭颜色 |
| `-h, --help` / `-v, --version` | 帮助／版本 |

**退出码**：`0` 成功 ｜ `1` 出错 ｜ `2` 已分叉，需要你选择（pull 或 force-push）

**环境变量**：`DSH_HOME`、`HARNESS_SYNC_HOME`、`HARNESS_SYNC_DEVICE`、`GH_TOKEN`／`GITHUB_TOKEN`、`NO_COLOR`

---

## 13. 换电脑后的完整恢复流程

```bash
# 1. 装插件（零构建，不需要工具链）
dsh plugin --profile web add github:<你的账号>/deepseek-harness-sync

# 2. 重启 dsh web
dsh web

# 3. 连接你的私有配置仓库（交互式）
harness-sync init

# 4. 先看清楚会发生什么
harness-sync status
harness-sync pull --dry-run

# 5. 应用
harness-sync pull

# 6. 如果 profile 的 bundle 列表变了，装依赖并重启
cd "$DSH_HOME/profiles/web" && pnpm install
dsh web
```

> 记住：**插件仓库**和**配置仓库**是两个仓库。前者让它"能跑"，后者让配置"回来"。

---

## 14. 开发

```bash
npm test
```

90 个测试，全部跑在**临时目录**里的伪造 harness home 和**本地 `git init --bare`** 假远端上 ——
**测试永远不会读取或写入真实的 `$DSH_HOME`**。覆盖：

- 路径解析优先级、白名单拒绝（穿越／绝对路径／盘符／非配置路径）；
- 收集器：**凭证副本回归测试**（断言收集结果里不含任何 SHA 等于 `.credentials.yaml` 的文件）；
- 机密扫描：命中即拒绝，且**不回显命中内容**；以及一条**假阳性回归测试** —— 真实机器上
  `pnpm-lock.yaml` 里的 `'@deepseek-ai/dsh-credentials': ^0.1.0-rc.6 || …` 曾把每一次 push 全都拦下来，
  现在「包名 + 版本区间」被正确识别为非机密；
- 快照确定性序列化、畸形快照拒绝；
- 原子写、路径穿越拒绝、`absent` 删除、无临时残留；
- 备份轮转（保留 5 份）与回滚往返；
- 插件契约：与 cordis 加载器一致的调用方式、`inject` 只声明 `tools`、无 `commands` 时仍能加载、参数校验、斜杠命令；
- **复用他人仓库的安全性**：预置一份带 README 与 `.gitignore` 的仓库，push 后外来 README 逐字节不变、
  外来 `.gitignore` 规则全部保留、本插件区块只追加一次；
- **双设备端到端演练**：A push → B pull → B 改并 push → A push **必须被拒绝（退出码 2）** → A `--force` → B 拉到 A 的内容；
- **设置页面的 HTTP 桥**：非回环对端 403、跨站 `Sec-Fetch-Site` 403、跨域 `Origin` 403、畸形 `Origin` 403、
  改状态的动作只收 POST（否则 405）、`status` 只收 GET、未知端点 404、非 JSON body 400、
  以及「响应里不含凭证」；
- **浏览器 bundle**：按加载器的方式（`window.__ModuleLoader__.load({id, factory})` → `factory(require)`）真实加载，
  断言 `id` 等于包名、**只 require `react` 这一个基线模块**、导出的是可挂载的 cordis 插件、
  在 `settings.section` 上恰好注册一个页面、返回 disposer、且文件里没有 ESM / 顶层副作用。

目录：

```text
bin/harness-sync.js      CLI 入口
lib/run.js               参数解析 + 命令分发（CLI 与插件共用）
lib/index.js             DSH 宿主插件入口（工具 / 斜杠命令 / 挂载 HTTP 桥）
lib/client.js            浏览器半边：设置页面的手写 bundle（无构建）
lib/ui.js                终端输出
lib/host/
  api.js                 回环 HTTP 桥 + 三道请求检查
lib/core/
  paths.js               $DSH_HOME / 数据目录解析
  manifest.js            白名单与 assertManaged()   ← 安全边界
  collect.js             读取配置（白名单）
  snapshot.js            快照信封、哈希、确定性 JSON
  apply.js               原子写入（先全量校验再落盘）
  backup.js              备份 / 轮转 / 恢复
  guard.js               机密扫描 + 私有仓库校验
  github.js              git 传输层：认证注入、错误翻译
  state.js               本插件配置（结构上无 token 字段）
  diff.js                行级差异
lib/commands/            init / status / push / pull / sync / diff / rollback
test/                    core / plugin / api / client / e2e
```

---

## 15. 已知限制

- **`--force` 只覆盖配置内容，不改写远端历史**（这是刻意的，见 §8.4）。
- **不做自动后台同步**（P1）。目前是显式命令。
- **不做 OAuth Device Flow**（P1），理由见 §6.3。
- **不做配置内容合并**。冲突时让你选，而不是三路合并你的 `settings.yaml`（合并一个保注释的
  YAML 文档比"让你选"危险得多）。
- **目录树只新增/覆盖，不删除**。`.agent-presets/**` 和 `skills/**` 里被远端删掉的文件不会在本机被删；
  只有白名单里的**固定文件**会走 `absent` 删除语义。
- **无 token 时无法自动确认仓库是否 Private**，只能警告（§2.1）。
- **每次 pull 前自动备份，保留 5 份**，暂不可配置（改 `config.json` 的 `keepBackups` 可调）。
- **设置页面需要重启 `dsh web`** 才会出现：新增 bundle 会改变 profile 的层栈，无法热加载。
- **设置页面依赖内建 Web 服务器**。桌面版 Electron 以 `file://` 加载客户端、并用 IPC 承载 fetch，
  此时页面上能渲染但按钮会明确报告「宿主不可达」，而不是静默失败。
- **浏览器半边是手写 bundle，因此不能用 JSX/TypeScript**。这是刻意的取舍：换来零构建、换电脑免工具链
  （DSH 的客户端 bundle 走经典 `<script>`，不支持 ESM，也必须有已构建好的产物入库）。

## 16. License

MIT
