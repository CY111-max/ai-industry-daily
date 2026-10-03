# AI 智造日报

定时自动采集 AI × 智能制造行业资讯，生成**移动端词云 + 可勾选筛选 + 双板块行业简报**的 H5 页面。

- **定时**：GitHub Actions 每周**一、周四**各采集一次（北京时间 09:00），也可在 Actions 页手动触发。
  GitHub 的排期会排队延迟 1.5~6 小时，所以每个采集日提前埋三次兜底（06:40 / 07:40 / 08:40），先跑成的那次落盘，后面几次发现无新增就不提交——保证 9 点打开页面就有当天内容。
- **词云**：按当日资讯热度自动生成词云，字号随热度变化；点词看中文释义，勾选即筛选资讯列表
- **简报**：每 30 天生成一份，覆盖最近 30 天，**永久保存不删除**。DeepSeek 生成固定两大块 —— ① 智能制造产业影响（落地进展 / 产线变化 / 机遇风险 / 政策）② 市场与金融资本市场影响（投融资 / 资本动向 / 产业链 / 企业机会风险），可一键复制
- **历史**：**纯增量**批次（每批只装本次新增，批次之间不重复）。顶栏 `‹` `›` 逐条切换，或点「历史」直接跳；保留最近 **90 天**。切到某一批资讯时，下方自动显示**覆盖那段日期**的那份简报
- **前端**：单文件 `index.html`，无构建、无依赖；localStorage 缓存优先，秒开后后台刷新

## 目录结构

```
index.html                  # 移动端 H5（全部前端代码，含 LIB 纯逻辑层）
collector/
  run.js                    # 入口：抓取 → 过滤 → 去重 → 补详情 → 摘要 → 落盘 → 按需生成简报
  feeds.js                  # 资讯源清单与解析适配器（RSS / 列表页）
  fetch-utils.js            # 抓取、重试、编码识别（gbk→gb18030）、正文抽取
  dedupe.js                 # URL 归一化 + 批次文件扫描 + 近 14 天滚动去重
  briefing.js               # 简报纯逻辑：覆盖区间匹配 / 分块去重 / 汇总载荷拼装
  briefing-store.js         # 简报读写（briefings/ 永久保存，不参与清理）
  ai.js                     # DeepSeek 摘要 / 简报调用（含两级汇总与 JSON 容错解析）
  config.js                 # 运行时配置（全部可用环境变量覆盖）
.github/workflows/daily.yml # 定时任务（每周一/周四，每批次三次兜底）
data/                       # Actions 产出：批次 YYYY-MM-DD-HHmm.json + briefings/ + index.json（自动提交）
test/                       # node:test 单元测试（npm test，无外部依赖）
serve.js                    # 本地预览用静态服务器
```

## 部署（一次性，全程网页操作）

### 1. 注册 GitHub

打开 https://github.com/signup ，填邮箱 → 设密码 → 取用户名（英文/数字，例如 `chenyou-ai`）→ 收邮件验证。
用户名后面会出现在网址里，想好再定。

### 2. 新建仓库

右上角 `+` → **New repository**：

- Repository name：`ai-industry-daily`
- 选 **Public**（必须是公开，Pages 才免费且能读数据）
- 不要勾 "Add a README file"，其他保持默认
- 点 **Create repository**

### 3. 上传文件

在上传页点 **uploading an existing file**（或 Add file → Upload files）。

在文件资源管理器里打开 `C:\Users\33723\ai-industry-daily`，**按住 Ctrl 逐个选中下面这 8 项**，一起拖进网页的虚线框：

```
index.html   collector   data   .github   .gitignore   README.md   package.json   serve.js
```

> ⚠️ **不要**整个文件夹拖，也不要把 `.git` 拖进去 —— 那是本机的版本记录，传上去会凭空多出几百个无用文件。

等文件列表出来后点 **Commit changes**。上传完回到仓库首页，确认根目录同时有这几项：

```
index.html    collector/    data/    README.md    .github/
```

> **`.github` 没传上去怎么办**（这是最容易漏的一步，它里面装着定时任务）：
> Add file → **Create new file**，文件名里输入 `.github/workflows/daily.yml`（斜杠会自动建成文件夹），
> 把本机 `.github/workflows/daily.yml` 的内容整段粘进去，Commit。
> 传对了的话，仓库顶部会出现 **Actions** 标签页。

### 4. 申请 DeepSeek Key 并加进仓库

1. 打开 https://platform.deepseek.com 注册登录 → 左侧 **API keys** → **创建 API key** → 复制那串 `sk-` 开头的字符（**只显示一次，先存好**）
2. 回 GitHub 仓库 → **Settings** → 左侧 **Secrets and variables** → **Actions** → 绿色按钮 **New repository secret**
   - Name：`DEEPSEEK_API_KEY`
   - Secret：粘贴刚才的 Key
   - 点 **Add secret**

> Key 只存在仓库的加密 Secret 里，运行时以环境变量注入，**不会出现在代码或提交记录中**。一旦泄露，去 DeepSeek 后台吊销重发即可。

### 5. 开启网页托管（GitHub Pages）

**Settings** → 左侧 **Pages** → Source 选 `Deploy from a branch` →
Branch 选 **main**、目录选 **/ (root)** → **Save**。

等 1–2 分钟，页面上方会显示网址：

```
https://<你的用户名>.github.io/ai-industry-daily/
```

用手机浏览器打开这个网址即可，建议加到主屏幕当 App 用。

### 6. 手动跑第一次

仓库顶部 **Actions** 标签 → 左侧 **每日资讯采集** → 右侧 **Run workflow** → 绿色按钮。
约 1–2 分钟跑完（第一次最慢），回到 Pages 网址刷新，就能看到当日资讯 + 摘要 + 双板块简报。

之后每周**一、周四 09:00（北京时间）**自动更新，不用再管；每 30 天会多出一份覆盖最近 30 天的简报。

> 每次跑完 Actions 会自动提交一个 `data:` 开头的 commit，这是正常的——数据就是这么更新的。

## 本地运行

```bash
node collector/run.js --dry-run     # 只抓取不调用大模型（不需要 Key）
DEEPSEEK_API_KEY=sk-xxx node collector/run.js   # 完整跑一遍
node serve.js                       # 起本地服务，浏览器开 http://127.0.0.1:8777
npm test                            # 跑单元测试（node:test，无外部依赖）
```

常用参数：

```bash
node collector/run.js --source=gkzhan                  # 只跑某个源，便于排查
node collector/run.js --date=2026-09-08 --slot=0900    # 指定日期与批次（现在恒为 0900）
```

> 现在一个采集日只有 `0900` 一个批次，保留 `--slot` 是为了兼容既有的批次文件名、
> 并让三次兜底都落到同一个批次上。不带 `--slot` 时会按北京时间自动判断（15 点前算 0900）。
> **Actions 里仍然显式传**：排期本身会延迟 1.5~6 小时，用墙上时间判断会把批次归错日期，
> 所以 workflow 直接按「哪个 cron 触发的」来定批次。

页面上也可以用 `?base=` 指向别的数据目录，例如 `index.html?base=https://example.com/data/`。

## 改成自己的资讯源

编辑 `collector/feeds.js`：

- **有 RSS/Atom 的站点** → 往 `SOURCES` 里加 `{ id, name, type: 'rss', url, encoding }`
- **只有列表页的站点** → `type: 'html-list'`，并在 `parseList()` 里为该 `id` 加一个解析分支
- **相关性过滤** → 调整 `INCLUDE_TERMS`（标题命中其一才收录）与 `EXCLUDE_TERMS`（命中即剔除，用来挡掉数码/娱乐噪音）

> 单源失败只会跳过并打日志，不影响整轮采集。新源先用 `--source=<id> --dry-run` 验证解析结果。

## 数据格式

`data/YYYY-MM-DD-HHmm.json`（一个采集日一个批次；早期只有日期的 `YYYY-MM-DD.json` 仍兼容，页面显示为「全天」）：

```json
{
  "id": "2026-10-01-0900",
  "date": "2026-10-01",
  "slot": "0900",
  "updatedAt": "2026-10-01T01:12:00.000Z",
  "items": [
    { "id": "url-md5", "title": "…", "source": "IT之家",
      "time": "2026-10-01T01:47:00.000Z", "url": "https://…", "digest": "AI 摘要（1-2 句）" }
  ]
}
```

**纯增量**：每个批次只装本次真正新采集到的条目，批次之间不重复、不结转。
同一批次可以重复运行（三次兜底）：以本批次已有内容为底稿只追加新增，本轮无新增则不改写文件，所以兜底运行不会产生空提交。

`data/briefings/YYYY-MM-DD.json`（文件名是生成日；**永久保存，不参与清理**）：

```json
{
  "id": "2026-10-02",
  "from": "2026-09-02",
  "to": "2026-10-02",
  "generatedAt": "2026-10-02T01:20:00.000Z",
  "itemCount": 1794,
  "batchCount": 9,
  "briefing": { "summary": "…", "part1": { "launch": [], "line": [], "risk": [], "policy": [] },
                "part2": { "finance": [], "capital": [], "chain": [], "corp": [] } }
}
```

30 天的资讯量（约 1800 条）远超单次大模型调用的上下文上限，所以简报分两级生成：
一级按批次分块各写一份阶段简报，二级把这些阶段简报汇总成最终简报。

`data/index.json`：`batches` 为全部批次（新的在前，含 id / 日期 / 批次 / 条数 / 更新时间），
`briefings` 为全部简报（按覆盖结束日新的在前，只含元信息、不含正文），`latest` 是最新批次 id。

> 落盘只保留标题、来源、时间、原文链接与 AI 摘要 —— **不保存抓取到的原文正文**，点卡片跳原文站点阅读。

## 说明与注意

- 仓库是公开的，`data/` 与页面 URL 知道即可访问（自用定位，不做鉴权）。
- 本机（浏览器）会缓存最近 7 个批次的数据快照与最近 12 份简报；勾选的关键词、自定义词也存本机，不上传。
- 页面**刷新按钮**的含义是「拉取最新已生成的数据」。真正的重新采集发生在周一/周四 09:00 的定时任务，或在 Actions 页手动 Run workflow。
- GitHub Pages 有约 10 分钟 CDN 缓存，页面请求都带了时间戳参数，正常不会读到旧文件。
- 定时任务**实测会排队延迟 1.5~6 小时**（不是几分钟）。这正是每批次埋三次兜底、且批次由 cron 而非运行时刻决定的原因。
- 批次数据保留 **90 天**（必须大于简报的 30 天覆盖窗口，否则生成简报时源数据会被自己删掉）；**简报永久保留**，不受保留期影响。
- 简报是**按批次日期匹配**的：切到某一批时，显示覆盖那段日期的那一份；若该批次比所有简报都新，则退回显示最新一份。
- 后续要转微信小程序：`index.html` 顶部的 `LIB` 是**与 DOM 无关的纯逻辑层**（取数/缓存/词典匹配/格式化/简报拼装），可直接复用，只需替换下面的 UI 层；数据源为 https 的 Pages 域名，真机需在小程序后台配置 request 合法域名。
