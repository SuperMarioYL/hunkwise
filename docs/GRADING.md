# 判定规则

这份文档是 Hunkwise v0.1 判分规则的唯一权威来源。README、探针表、存证记录都引用这里；
如果代码和这里不一致，以这里为准，并按下面的「修改规则」一节同步两边。

先说结论：**答案键是代码从 diff 里当场算出来的，全程不调用任何模型。** 同一份分支跑两次，
`probes.json` 逐字节相同；同一个答案错两次，那个片段就是没覆盖，没有第三次。

## 1. 判分的对象是「片段」，不是「人」

一次评审的产物是若干条探针（probe）。探针唯一的来源是片段里的事实（fact）。

```
git diff --unified=0  →  片段（hunk）  →  事实（fact）  →  探针（probe）  →  覆盖（coverage）
```

- **片段**：`git diff -U0` 里的一个 `@@` 块。id 取改动后的行区间，形如 `src/auth/session.ts:7-9`；
  纯删除的片段没有改动后的区间，用删除前的区间。
- **事实**：从片段的新增/删除行里按固定规则识别出的行为变化。四类，见 §2。
- **探针**：一道四选一题，题目问这条事实，四个选项里只有一个是片段里的原文。
- **覆盖**：一个片段的所有探针都答对，该片段才算覆盖。覆盖数 / 非豁免片段总数 就是 `coverage`。

片段是分母，事实是分子。没有事实的片段不进分母（`no_fact`），文件级豁免的片段也不进分母（§3）。

## 2. 四类事实

| kind | 什么时候触发 | 正确答案是什么 |
| --- | --- | --- |
| `guard_removed` | 删掉了一行「同行的条件 + 提前退出」，如 `if (!user) return null;`；或删掉一个 `if (...) {` 块，块体恰好是一条 `return` / `throw` / `continue` / `break`；或删掉 `assert(...)` / `invariant(...)` / `ensure(...)` | 被删的那行条件原文（块删除时是 `if (...) {` 那一行） |
| `error_path_changed` | 新增或删除的行里有错误路径：`throw`、`raise`、`panic!(`、`reject(`、`.catch(`、`catch (`、`process.exit`、`exit(`、`new XxxError(...)` | 那一行错误处理语句的原文 |
| `new_branch` | 新增的行里有分支关键字（`if` / `else if` / `else` / `switch` / `case` / `catch`）或三元表达式 `? ... :` | 那行分支语句的原文 |
| `symbol_renamed` | 同一位置上一删一增，两行去掉字符串字面量后形状相同、标识符个数相同，且有非关键字的标识符不同 | 改名后的新符号 |

识别是纯文本的（`src/diff.ts` 的 `extractFacts`）：先按行剥离注释、抹掉字符串内容，再匹配。
没有 AST、没有语言服务、没有跨文件推理。代价是只能看见文本层面的事实——一个改了语义但
不落在上面四类里的片段会得到 `no_fact`，而不是一句猜出来的问题。

**答案键的收获方式**（`src/probes.ts`）：

1. 正确答案 = 事实对应的那行原文（去掉 diff 前缀、去掉行尾空白），它一定出现在片段里。
2. 干扰项 = 同一分支其它片段的事实原文，按内容排序后取用；分支太小时用固定的假陈述补足。
3. 选项顺序 = 以片段指纹（`sha256(归一化片段文本)`）为种子的确定性洗牌。
4. 每个片段最多三道题，优先覆盖不同 kind，避免一个删了两行守卫的片段被问两遍同一件事。

所以：没有模型参与出题，也没有模型参与判分。答案键由 `probes` / `review` 写进
`.hunkwise/probes.json`，工作台、`status`、`attest` 用它判分；`hunkwise verify` 不读这个文件，
而是从分支 diff 重新生成同样的探针与答案键，再和存证记录逐项比对。

## 3. 豁免原因

豁免的片段不进覆盖率分母。豁免是显式的：`diff.json` 和 `diff` 表格里都写着原因，不是悄悄跳过。

| 原因 | 含义 | 判定位置 |
| --- | --- | --- |
| `no_fact` | 片段里没有识别出上述四类事实，因此无法出可判分的题 | 内容级 |
| `comment-only` | 所有改动行剥掉注释后为空（`//`、`/* */`、`#`、`<!-- -->`、`--`、`%` 等） | 内容级 |
| `whitespace` | 所有改动行都是空白；或去掉空白后两侧内容完全一致（纯缩进调整） | 内容级 |
| `lockfile` | 文件名是已知锁文件（`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`go.sum`、`Cargo.lock`、`uv.lock`、`Gemfile.lock`、`composer.lock` 等）或以 `.lock` 结尾 | 文件级 |
| `generated` | 路径落在 `dist/`、`build/`、`out/`、`coverage/`、`vendor/`、`node_modules/`、`.next/`、`target/`、`__generated__/` 下，或匹配 `*.min.js`、`*.min.css`、`*.map`、`*.generated.*` | 文件级 |
| `binary` | 二进制文件，没有可读的 `@@` 块 | 结构级 |
| `mode-change` | 只有文件权限变化（如 `100644 → 100755`），没有内容改动 | 结构级 |
| `rename-only` | 100% 相似度的纯重命名，没有内容改动 | 结构级 |

为什么锁文件豁免：让评审者证明自己读过 `package-lock.json` 的版本号变化，不产生任何关于
这次改动的理解。同理，`no_fact` 的豁免是诚实的边界声明——Hunkwise v0.1 不假装能对
「把 `a + b` 改成 `b + a`」出题。

**两种要留意的沉默。** 第一，纯删除的片段只要删除的不是守卫或错误路径，就会得到 `no_fact`；
这意味着删掉一整个文件可能完全没有探针。第二，豁免是文本规则，不认识你的领域——一个
`__generated__/` 目录下的手写文件也会被豁免。遇到这两种情况，把文件移出豁免路径，或者接受
「这条规则看不到它」，不要把它当成已审阅的证据。

## 4. 判分、重试与覆盖

- 一道题答错，可以再答一次；答案错误时服务端返回 `evidence_line` 与 `evidence_text`，
  指向答案在 diff 里的位置（这是提示，不是答案）。
- **两次都错，这道题锁死，所在片段在本次分支状态下永远是未覆盖。** 没有第三次，
  也没有「稍后再试」的旁路。正常流程里，片段要重新进入覆盖，只能改代码产生新的片段指纹再走一遍。
  本地状态不是保险箱：删掉 `.hunkwise/answers.json` 会重置已答状态（见 §5）。
- 片段的 `attempts` 取其最难那道题的尝试次数；一个片段的所有探针都 `correct` 才算 `covered`。
- `coverage.ratio = covered / total`，`total` 不含豁免片段。`total = 0` 时 ratio 记为 1
  （没有需要证明的片段，就不该阻塞）。

工作台的实时覆盖率、`hunkwise status`、`hunkwise attest` 跑的是同一个函数 `grade()`。
`hunkwise verify` 不读磁盘上的探针文件，而是重算 diff 与答案键，再把存证记录逐项对上
（摘要、`diff_sha256`、片段指纹、答案键）。判分规则只有一套，差别只在于 `verify` 复核的是
「重算结果 vs 存证」，所以不存在「界面显示通过、verify 不通过」的两套账。

## 5. 存证能证明什么，不能证明什么

`hunkwise attest` 写下 `.hunkwise/attestations/<head>.json`，其中：

- `diff_sha256`：对归一化后的整个 diff 文档做 sha256，把记录绑死在某一个分支状态上；
- `hunks[].fingerprint`：每个片段自己的指纹；
- `hunks[].covered` / `probes[].correct`：判分结果；
- `digest`：用 `.hunkwise/key`（本地 32 字节随机密钥）对除 `digest` 外的全部字段做 HMAC-SHA256。

`hunkwise verify` 会重新跑 diff、重新生成探针、重新判分，再比对记录。所以：

- **改分支之后再拿旧记录过闸**：`diff_sha256` 与片段指纹对不上，verify 列出未覆盖片段并退出 1。
- **手改记录里的 `covered`**：`digest` 校验失败，退出 1。
- **拿到记录和 key 的人重新签一份**：能签。key 就在仓库里（`.hunkwise/` 已被 gitignore），
  它不是身份系统。**这份记录是「防篡改的」，不是「证明是谁答的」。**
- **答案键就在 `.hunkwise/probes.json` 里**：本地闸门拦不住一个铁了心读答案键的人
  （`verify` 虽然不读这个文件，但它也不负责防作弊）。它拦的是「没读 diff 就点通过」这条默认路径，
  不是作弊器。
- **本地状态可以重置**：删掉 `.hunkwise/answers.json` 或整个 `.hunkwise/` 就能重新答；
  本地 hook 可以被 `git push --no-verify` 绕过。v0.1 是本地闸门，不是服务端强制。
  要服务端强制，需要 v0.2 的团队层（见 README 路线图）；v0.1 不声称自己做到了。

这三条限制写在这里，而不是藏在角落：如果你需要「谁答的」级别的证据，v0.1 不是那个工具。

## 6. 修改规则

改动以下任一项，都算改判分规则，必须同时更新这份文档和 `CHANGELOG.md`：

- 事实识别的触发条件（`src/diff.ts` 的 `extractFacts` / `detectGuardBlocks` / `detectSymbolRenames`）；
- 豁免原因集合（`ExemptReasonSchema`）；
- 选项生成或洗牌（`src/probes.ts`）；
- `MAX_ATTEMPTS`（当前为 2）；
- 存证的字段或 digest 的覆盖范围（`src/attestation.ts`）。

`diff.json` / `probes.json` / `attestation.json` 都带 `schema` 字段
（`hunkwise/diff@1`、`hunkwise/probes@1`、`hunkwise/attestation@1`）。不兼容的改动升版本号，
不要悄悄改语义。
