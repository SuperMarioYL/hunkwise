[English](./README.en.md) | **简体中文**

<div align="center">

[![npm](https://img.shields.io/npm/v/hunkwise.svg?label=npm&color=4f46e5)](https://www.npmjs.com/package/hunkwise)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-4f46e5.svg)](./LICENSE)
[![no model](https://img.shields.io/badge/%E5%88%A4%E5%AE%9A-no%20model%20in%20the%20loop-16a34a)](./docs/GRADING.md)
[![release](https://img.shields.io/github/v/release/SuperMarioYL/hunkwise?label=release)](https://github.com/SuperMarioYL/hunkwise/releases)

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Noto+Sans+SC&weight=600&size=22&duration=3200&pause=900&color=4F46E5&center=true&vCenter=true&width=780&height=64&lines=%E6%AF%8F%E4%B8%AA%E6%94%B9%E5%8A%A8%E7%89%87%E6%AE%B5%E4%B8%80%E9%81%93%E5%8F%AF%E5%88%A4%E5%88%86%E7%9A%84%E9%A2%98;%E7%AD%94%E6%A1%88%E9%94%AE%E4%BB%8E%20diff%20%E9%87%8C%E7%AE%97%EF%BC%8C%E4%B8%8D%E9%97%AE%E6%A8%A1%E5%9E%8B;%E7%AD%94%E5%AE%8C%E6%89%8D%E7%95%99%E4%B8%8B%E5%AD%98%E8%AF%81%EF%BC%8C%E6%B2%A1%E7%AD%94%E5%AE%8C%E5%B0%B1%E9%98%BB%E6%96%AD;verify%20%E9%80%80%E5%87%BA%E7%A0%81%200%20%2F%201%EF%BC%8C%E6%9C%AC%E5%9C%B0%E5%8F%AF%E5%A4%8D%E6%A0%B8)](https://github.com/SuperMarioYL/hunkwise)

# Hunkwise

**把「我真的看懂了」变成合并前的可校验条件：每个改动片段生成可机器判分的探针，答完才留下理解存证，没答完就阻断合并。**

评审 agent 写的分支时，PR 描述和测试也是 agent 写的，你唯一的第二意见来自同一份自述。
Hunkwise 换掉这个前提：片段里的行为变化被文本规则识别成事实，事实变成题，答案键从 diff 当场算出，
reviewer 答对，`verify` 才退出 0。

<sub>单进程 · 只连本机回环 · 判定路径上没有模型 · 状态全在仓库的 <code>.hunkwise/</code> · 防篡改的 HMAC 存证 · 本地 pre-push 闸门</sub>

</div>

---

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3 -4.3"/></svg> 为什么需要 Hunkwise

一个 PR 改十一个文件，作者是 coding agent。描述写得很顺，测试是绿的，CI 也绿的。
你能做的动作只有一个：approve，或者 request changes。没有任何东西区分「我真的把这次改动重走了一遍」
和「我读了摘要、看了绿灯、点了通过」——而在交付压力下，后者永远更便宜。

于是「合并」这个动作记录的是权限，不是理解。事故复盘时，能拿出来的是谁点了按钮，
不是谁看懂了哪一段。

Hunkwise 把理解拆到片段粒度，并且让它可机器判分：

- **片段（hunk）**：`git diff -U0` 的一个 `@@` 块，id 长这样 `src/auth/session.ts:7-9`。
- **事实（fact）**：片段里可判分的行为变化——被删的守卫、改掉的错误路径、新加的分支、改名的符号。
- **探针（probe）**：一条事实一道四选一题，正确答案是片段里的原文，干扰项来自同一分支的其它片段。
- **存证（attestation）**：每个片段 covered / uncovered，加上 `diff_sha256` 与 HMAC 摘要。

不要求 reviewer 写自由文本，也不用第二个模型来判断「答得好不好」：答对就是答对，
答案键和判分器都在你的机器上，可以自己复核。

**它补的是哪一半。** 自动代码评审（比如 `alibaba/open-code-review` 这类）把「读」这件事搬给模型，
产出更多需要人读的评论；`kyy-logs/code-review-gate-skill` 那类工具用模型在新鲜上下文里回答探针，
并明确写着「不是人类评审」。Hunkwise 不和你争评论质量，它问的是人：这一段的守卫去哪了？
答完留下记录，答不完就不放行。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16a4 4 0 1 1 .9 -7.9a6 6 0 0 1 11.6 1.7a3.5 3.5 0 0 1 -.5 6.9h-11"/><path d="M12 12v6"/><path d="M9 15l3 3l3 -3"/></svg> 安装

需要 Node 22+。Hunkwise 不下载任何二进制、不连任何外部服务。

```bash
# 方式 A：npm（尚未发布；发布后可用）
npm i -D hunkwise      # 或 npm i -g hunkwise

# 方式 B：从源码构建（今天可用的方式：在一个本地 checkout 里打包）
git clone https://github.com/SuperMarioYL/hunkwise.git   # 公开仓库随发布上线后可用
cd hunkwise && npm ci && npm run build && npm pack
# 在你要评审的仓库里安装打出来的包
npm i -D /path/to/hunkwise/hunkwise-0.1.0.tgz
```

> **发布状态。** `hunkwise` 还没有发布到 npm，公开仓库也还没有上线，所以上面 `npm i` 和
> `git clone` 两条路都要等发布；今天能用的是方式 B 的本地 checkout 打包。发布不改变任何命令，
> 只改变你从哪里拿到这个包。

> **npx 的注意点。** 只靠 `npx hunkwise ...` 临时下载也能跑 `init` / `diff` / `review` / `verify`，
> 但 `install-hook` 会拒绝把 hook 指向 npx 的临时缓存（`~/.npm/_npx/...` 会被清掉）。
> 要在仓库里挂 pre-push，先把 hunkwise 装成这个仓库的 devDependency 或全局包，再跑 `install-hook`。
> 这是刻意的：hook 指向一个明天就不存在的路径，比没有 hook 更糟。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l5 5l-5 5"/><line x1="12" y1="19" x2="19" y2="19"/></svg> 快速开始（10 分钟）

在一个有 `origin` 的仓库里，切到要评审的 agent 分支，然后按顺序复制粘贴：

```bash
# 1) 初始化：写 .hunkwise/config.json、本地 HMAC key，并把 .hunkwise/ 加进 .gitignore
npx hunkwise init

# 2) 让 base 分支在本地存在
git fetch origin main

# 3) 把分支拆成片段，打印片段表，写 .hunkwise/diff.json
npx hunkwise diff --base origin/main

# 4) 生成探针，写 .hunkwise/probes.json
npx hunkwise probes

# 5) 起工作台（只绑 127.0.0.1），在浏览器里答题
npx hunkwise review --base origin/main
#   6 hunks, 3 exempt, 4 probes
#   workbench: http://127.0.0.1:4321 (loopback only; Ctrl+C to stop)

# 6) 随时看覆盖率（另一个终端）
npx hunkwise status
#   3/3 hunks covered (100%), 3 exempt, 4 probes

# 7) 封存存证
npx hunkwise attest
#   sealed 3/3 hunks (100%), 3 exempt
#   record: .hunkwise/attestations/<head>.json

# 8) 过闸：覆盖满了退出 0，有未覆盖片段退出 1 并列出片段 id
npx hunkwise verify --base origin/main
#   covered 3/3 hunks for <head> (3 exempt)

# 9) 让同一条命令在 pre-push 上跑
npx hunkwise install-hook
```

工作台左边是带高亮的 unified diff，右边一次一道题，顶部是实时覆盖率。答错一次会告诉你答案在
diff 的哪一行，并允许再答一次；**同一道题错两次就锁死，所在片段在本次分支状态下保持未覆盖**。
刷新页面不会丢已答的题——答案存在 `.hunkwise/answers.json`，绑定当前 `diff_sha256`；
分支一变，旧答案自动作废。

> 上面注释里的数字来自演示仓库（6 个片段、3 个进分母），你的仓库不会是同一组数；命令本身和
> 退出码是固定的。如果 `npm i -D hunkwise` 改动了 `package-lock.json` 并提交了它，那段 diff 会
> 以 `lockfile` 豁免，不影响覆盖率分母；`package.json` 不在锁文件名单里，它照常进入评分
> （识别不到事实时才是 `no_fact`）。

不想开浏览器时，页面用的是这几个接口（工作台自己也在用）：

```console
$ curl -s 127.0.0.1:4321/api/probes
$ curl -s -XPOST 127.0.0.1:4321/api/answer \
    -d '{"probe_id":"src/auth/session.ts:7-9#1","answer_index":2}'
{"probe_id":"src/auth/session.ts:7-9#1","correct":true,"attempts":1,
 "evidence_line":6,"evidence_text":"  if (!user) {",
 "coverage":{"total":3,"covered":3,"exempt":3,"ratio":1}}
$ curl -s -XPOST 127.0.0.1:4321/api/seal
```

`answer_index` 不会下发给浏览器，`/api/probes` 只返回题干和选项；`/api/diff` 在片段的所有探针答对前
不返回事实的 `detail`（它就是正确选项的原文）。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16l13 -8z"/></svg> 演示

完整录屏：[`docs/demo.cast`](./docs/demo.cast)（asciicast v2，96×30，约 12 秒）。
回放：

```bash
asciinema play docs/demo.cast
```

录屏是一次真实运行，不是手工拼的输出：脚本在一个临时仓库里装好发布包，走完
`init → diff → probes → review → 答题 → attest → verify (0) → install-hook`，
再切到第二个没评审完的分支，展示 `verify` 退出 1 和 `git push` 被 hook 挡住。
录制脚本是 [`docs/record-demo.sh`](./docs/record-demo.sh)。

```console
$ npx hunkwise diff --base origin/main
HUNK                     FACTS               FINGERPRINT   EXEMPT
-----------------------  ------------------  ------------  --------
package-lock.json:12-14  -                   6423404c9341  lockfile
package-lock.json:45-47  -                   437cc0f047d0  lockfile
src/api/handler.ts:3-3   -                   6ca2e53878df  no_fact
src/api/handler.ts:5-8   new_branch          a5787c4cc0f7  -
src/auth/errors.ts:5-5   error_path_changed  e7a3b31ff628  -
src/auth/session.ts:7-9  guard_removed       c98bb1f8f548  -

6 hunks, 3 exempt, 4 facts written to .hunkwise/diff.json

$ npx hunkwise verify --base origin/main
covered 3/3 hunks for 3f79732815f8 (3 exempt)

$ npx hunkwise verify --base origin/main     # 第二个分支，只答了一半
hunkwise: 1/2 non-exempt hunks are uncovered
  src/auth/errors.ts:5-5  not covered
```

这次运行的全部数字（命令、退出码、片段数、覆盖率）记录在
[`docs/demo-results.json`](./docs/demo-results.json)，README 只引用它：

| 观测项 | 已评审分支 | 未评审完的分支 |
| --- | --- | --- |
| 片段总数 | 6 | 2 |
| 进入分母的片段 | 3 | 2 |
| 豁免 | 3（2 lockfile + 1 no_fact） | 0 |
| 事实 / 探针 | 4 / 4 | 2 / 2 |
| 覆盖率 | `3/3`（ratio 1） | `1/2`（ratio 0.5） |
| `verify` 退出码 | `0` | `1` |

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2"/><circle cx="12" cy="14" r="2"/><path d="M14 12l2 -2"/></svg> 架构

一个 Node 进程，少量只读的 git 子进程调用，没有数据库、没有守护进程、没有账号。

```
git diff -U0 <base>...HEAD
        │
        ▼
  src/diff.ts ────────────────  片段 / 事实 / 指纹 / 豁免原因
        │  .hunkwise/diff.json
        ▼
  src/probes.ts ──────────────  四类模板 · 兄弟片段当干扰项 · 指纹种子洗牌
        │  .hunkwise/probes.json
        ▼
  src/server.ts ── src/ui/workbench.html      左：diff   右：一题   上：覆盖率
        │  POST /api/answer   POST /api/seal
        ▼
  src/attestation.ts ─────────  zod schema · 覆盖率运算 · HMAC-SHA256
        │  .hunkwise/attestations/<head>.json
        ▼
  src/gate.ts  ←  src/cli.ts    verify 重算 diff 与答案键，exit 0 / 1
```

- `src/cli.ts` 只做参数解析和输出，命令有 `init`、`diff`、`probes`、`review`、`status`、`attest`、
  `verify`、`verify-push`、`install-hook`。
- `src/server.ts` 只绑 `127.0.0.1`：没有路由返回 `answer_index`，`/api/diff` 在片段的所有探针答对前
  隐去事实的 `detail`，`/api/probes` 只给题干和选项；答题状态落在磁盘，刷新可续。
- `src/gate.ts` 是 `verify` 和 pre-push 复用的一层：它不读磁盘上的 `probes.json`，也不信任记录，
  每次都从当前分支重算 diff、重新出题、重新判分，再比对 `diff_sha256`、片段指纹和 HMAC 摘要。
- `src/attestation.ts` 是唯一写存证的地方；`grade()` 被工作台、`status`、`attest` 共用。
  `verify` 沿用同一套判分规则，但它自己做记录比对（摘要、`diff_sha256`、指纹、重新算出的答案键），
  所以不存在「界面显示通过、verify 不通过」的两套账。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3l8 -8"/><path d="M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9"/></svg> 能力（v0.1）

| 命令 | 做什么 | 退出码 |
| --- | --- | --- |
| `hunkwise init` | 建 `.hunkwise/`、`config.json`、本地 HMAC key（0600），把 `.hunkwise/` 写进 `.gitignore` | 0 / 1 |
| `hunkwise diff [--base <ref>]` | 打印片段表（事实、指纹前缀、豁免原因），写 `diff.json`；`--base` 省略时用 `config.json` 的 `base` | 0 / 1 |
| `hunkwise probes` | 从 `diff.json` 生成 `probes.json`，确定性、可重复 | 0 / 1 |
| `hunkwise review [--base <ref>]` | 在 `127.0.0.1:4321` 起工作台，实时覆盖率，答题可续；`--base` 省略时用 `config.json` 的 `base` | 0 / 1 |
| `hunkwise status` | 从磁盘读同一份判分结果，打印 `covered/total` | 0 / 1 |
| `hunkwise attest` | 写 `.hunkwise/attestations/<head>.json`，含 `diff_sha256` 与 HMAC 摘要 | 0 / 1 |
| `hunkwise verify [--base] [--head]` | 重算 diff 与答案键，未覆盖片段逐条列出 | 0（全覆盖）/ 1（有未覆盖或记录失效） |
| `hunkwise verify-push` | pre-push 入口：读 git 传来的 refs，逐个 commit 校验，不用 checkout HEAD 冒充 | 0 / 1 |
| `hunkwise install-hook` | 写 `.git/hooks/pre-push`；拒绝覆盖别人的 hook，拒绝 `core.hooksPath` 和 npx 缓存路径 | 0 / 1 |

已经做到的：

- 四类文本事实 + 八种显式豁免原因（见 [`docs/GRADING.md`](./docs/GRADING.md)）；
- 一个片段 1–3 道题，答案键是片段原文，选项顺序由片段指纹决定，同一 diff 逐字节可复现；
- 每片段独立判分；答错一次给证据行，两次锁死，片段保持未覆盖；
- `verify` 不信任磁盘缓存：它从分支重算 diff 和答案键，所以分支改动、手改存证记录（包括记录里的
  答案键）都会让它退出 1；改 `probes.json` 不影响 `verify`，因为它根本不读这个文件；
- 本地 `pre-push` hook，单独校验每个被推送的 commit；
- 全部状态是 `.hunkwise/` 下的扁平 JSON，没有数据库、没有网络调用。

明确不做（v0.1 的边界，写在这里免得你误以为有）：

- **不做服务端强制。** 这是本地闸门：CLI + pre-push hook。`git push --no-verify` 能绕过它。
  「分支保护 / 服务端拒绝合并」是 v0.2 团队层的事，v0.1 不声称自己做到了。
- **存证是防篡改，不是身份。** HMAC key 就在仓库里（`.hunkwise/` 已被 gitignore），
  拿到记录和 key 的人可以重签一份。它证明「记录没被改过」，不证明「是谁答的」。
- **不做模型判分，也不做自由文本。** 只有四类文本事实；一个改语义但不落在四类里的片段会得到
  `no_fact` 豁免，而不是一句猜出来的问题。
- **不做 AST / 类型推断 / 跨语言语义分析。** 规则是文本级的，v0.1 只在 JS/TS 上实测过。
- **不做托管服务、账号、多人同步、团队看板**；不做历史回填、批量给旧 PR 打分；不做计费。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h4"/><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2"/></svg> 覆盖率怎么算

一句话：**答案键来自 diff 事实，不来自模型；一个片段的题全对才算覆盖，错两次就永远不算。**

| 事实 kind | 触发 | 正确答案 |
| --- | --- | --- |
| `guard_removed` | 删掉同行的条件 + 提前退出，或删掉块体只有一条 `return` / `throw` 的 `if (...) {` 块 | 被删那行原文 |
| `error_path_changed` | 新增/删除的行里有 `throw`、`raise`、`panic!(`、`reject(`、`.catch(`、`process.exit`、`new XxxError` 等 | 那行错误处理语句原文 |
| `new_branch` | 新增行里有 `if` / `else if` / `switch` / `case` / `catch` 或三元表达式 | 那行分支语句原文 |
| `symbol_renamed` | 同位置一删一增，形状相同、标识符个数相同、有非关键字标识符不同 | 新符号 |

豁免原因（不进分母）：`no_fact`、`comment-only`、`whitespace`、`lockfile`、`generated`、
`binary`、`mode-change`、`rename-only`。锁文件与生成物被豁免，是因为让人证明自己读过
`package-lock.json` 的版本号不产生任何对这次改动的理解。

完整规则、每类的边界、以及「存证能证明什么 / 不能证明什么」都在
[`docs/GRADING.md`](./docs/GRADING.md)。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06 .06a2 2 0 1 1 -2.83 2.83l-.06 -.06a1.65 1.65 0 0 0 -1.82 -.33a1.65 1.65 0 0 0 -1 1.51v.17a2 2 0 1 1 -4 0v-.09a1.65 1.65 0 0 0 -1.08 -1.51a1.65 1.65 0 0 0 -1.82 .33l-.06 .06a2 2 0 1 1 -2.83 -2.83l.06 -.06a1.65 1.65 0 0 0 .33 -1.82a1.65 1.65 0 0 0 -1.51 -1h-.17a2 2 0 1 1 0 -4h.09a1.65 1.65 0 0 0 1.51 -1.08a1.65 1.65 0 0 0 -.33 -1.82l-.06 -.06a2 2 0 1 1 2.83 -2.83l.06 .06a1.65 1.65 0 0 0 1.82 .33h.01a1.65 1.65 0 0 0 1 -1.51v-.17a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51a1.65 1.65 0 0 0 1.82 -.33l.06 -.06a2 2 0 1 1 2.83 2.83l-.06 .06a1.65 1.65 0 0 0 -.33 1.82v.01a1.65 1.65 0 0 0 1.51 1h.17a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0 -1.51 1z"/></svg> 配置

`init` 之后只有两个文件是配置，其余都是运行状态：

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `.hunkwise/config.json` | `{"schema":"hunkwise/config@1","base":"origin/main"}` | `init --base <ref>` 只在首次写 config 时设定 base；config 已存在时 `init` 不覆盖（要换 base 直接改这个文件） |
| `.hunkwise/key` | 32 字节 hex，权限 `0600` | HMAC key；`init` 只在缺失时创建，不覆盖已有 key |
| `.hunkwise/diff.json` | 片段、事实、指纹、豁免 | `diff` / `review` 写 |
| `.hunkwise/probes.json` | 探针与答案键 | `probes` / `review` 写；它是工作产物、不是信任锚——`verify` 不读它，直接从 diff 重算探针与答案键 |
| `.hunkwise/answers.json` | 答案与尝试次数 | 工作台写，绑定当前 `diff_sha256` |
| `.hunkwise/attestations/<head>.json` | 存证记录与摘要 | `attest` / `/api/seal` 写 |

命令行参数：

| 参数 | 作用 |
| --- | --- |
| `--base <ref>` | `diff` / `review` / `verify` / `verify-push` / `install-hook` 的对照分支；省略时用 `config.json` 的 `base` |
| `--head <rev>` | `verify` 校验指定 commit，默认 `HEAD` |
| `--port <n>` | `review` 的端口，默认 `4321`，只绑 `127.0.0.1` |

没有环境变量、没有远程配置、没有账号。`.hunkwise/` 被 `init` 加进 `.gitignore`，
所以 key 和答案不随分支走；换台机器要重新 `init`（旧存证仍可用 `verify` 复核，
前提是 key 一起带过去）。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z"/><path d="M3 10l18 0"/></svg> 团队版（v0.2，尚未实现）

CLI 本身是 MIT、全本地、免费。上面那一层是给需要「拿得出证据」的组织：

- **组织侧存证留存**：记录进团队自己的服务，不是每个 reviewer 的笔记本；
- **合并强制**：把覆盖状态接进 GitLab / Gitee / GitHub 的必需检查，而不是只靠本地 hook；
- **审计导出**：按季度导出 CSV / JSON，回答「这次合并是谁、懂了哪几段」；
- **自托管**：Docker + license 文件，不依赖任何云，满足内网与信创环境的安全评审。

参考价格：**¥1,200 / 席 · 年，20 席起 = ¥24,000 / 年**。面向 200–2000 人、用自托管 GitLab/Gitee、
处在支付或基础设施领域的平台工程 / 研发效能团队。最小的一次「好」是 30 分钟：在你们已经合并的
agent PR 上跑一遍，`verify` 在你们漏掉的那个片段上退出 1，答完再退出 0。两周付费试点
¥5,000，可全额抵扣年费。

v0.1 没有计费代码，也没有云端控制台——这条路是写清楚的方向，不是已经上线的功能。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l6 -3l6 3l6 -3v13l-6 3l-6 -3l-6 3v-13"/><path d="M9 4v13"/><path d="M15 7v13"/></svg> 路线图

**已交付（v0.1）**

- m1：`diff` 把分支拆成片段，识别事实、指纹与豁免原因；
- m2：`probes` 为四类事实生成可判分探针，确定性、可复现；
- m3：`review` 在回环地址起工作台，答题可续，`status` 与工作台同一份判分；
- m4：`attest` 封存 HMAC 存证，`verify` 退出 0/1，`install-hook` 挂到 pre-push。

细节见 [`CHANGELOG.md`](./CHANGELOG.md)。

**下一步（按需求排，不承诺日期）**

- v0.2 团队层：组织侧存证、合并强制、审计导出、自托管镜像；
- 更多事实类型与更少 `no_fact`：目前只有四类文本事实，误判豁免是最大的待办；
- 非 JS/TS 语言的实测与语法细节（Python / Go 的守卫与错误路径写法差异）；
- 一个可复制的 GitLab / Gitee runner recipe，让 `verify` 进 CI，而不只是本地 hook；
- 如果 agent 开始输出「每段意图 + 不变量」，把工作台从「答题」扩到「核对 agent 的不变量」。

**不做**：见上面「能力（v0.1）」里的边界清单——那是 v0.1 的契约，不是待办列表。

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg> 许可

MIT。见 [`LICENSE`](./LICENSE)。

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
