# AI 智造日报

每天自动采集 AI × 智能制造行业资讯，生成**移动端词云 + 可勾选筛选 + 双板块行业简报**的 H5 页面。

- **定时**：GitHub Actions 每天 08:00 / 20:00（北京时间）自动抓取，也可在 Actions 页手动触发
- **词云**：按当日资讯热度自动生成词云，字号随热度变化；点词看中文释义，勾选即筛选资讯列表
- **简报**：DeepSeek 生成固定两大块 —— ① 智能制造产业影响（落地进展 / 产线变化 / 机遇风险 / 政策）② 市场与金融资本市场影响（投融资 / 资本动向 / 产业链 / 企业机会风险），可一键复制
- **历史**：保留最近 30 天，页面顶部可回看任意一天
- **前端**：单文件 `index.html`，无构建、无依赖；localStorage 缓存优先，秒开后后台刷新

## 目录结构

```
index.html                  # 移动端 H5（全部前端代码，含 LIB 纯逻辑层）
collector/
  run.js                    # 入口：抓取 → 过滤 → 去重 → 补详情 → 摘要 → 简报 → 落盘
  feeds.js                  # 资讯源清单与解析适配器（RSS / 列表页）
  fetch-utils.js            # 抓取、重试、编码识别（gbk→gb18030）、正文抽取
  dedupe.js                 # URL 归一化 + 近 7 天滚动去重
  ai.js                     # DeepSeek 摘要 / 简报调用（含 JSON 容错解析）
  config.js                 # 运行时配置（全部可用环境变量覆盖）
.github/workflows/daily.yml # 定时任务
data/                       # Actions 产出：YYYY-MM-DD.json + index.json（自动提交）
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

之后每天 **08:00 / 20:00（北京时间）**自动更新，不用再管。

> 每次跑完 Actions 会自动提交一个 `data:` 开头的 commit，这是正常的——数据就是这么更新的。

## 本地运行

```bash
node collector/run.js --dry-run     # 只抓取不调用大模型（不需要 Key）
DEEPSEEK_API_KEY=sk-xxx node collector/run.js   # 完整跑一遍
node serve.js                       # 起本地服务，浏览器开 http://127.0.0.1:8777
```

常用参数：

```bash
node collector/run.js --source=gkzhan          # 只跑某个源，便于排查
node collector/run.js --date=2026-09-08        # 指定日期（北京时间）
node collector/run.js --generation=manual      # 标记为手动跑
```

页面上也可以用 `?base=` 指向别的数据目录，例如 `index.html?base=https://example.com/data/`。

## 改成自己的资讯源

编辑 `collector/feeds.js`：

- **有 RSS/Atom 的站点** → 往 `SOURCES` 里加 `{ id, name, type: 'rss', url, encoding }`
- **只有列表页的站点** → `type: 'html-list'`，并在 `parseList()` 里为该 `id` 加一个解析分支
- **相关性过滤** → 调整 `INCLUDE_TERMS`（标题命中其一才收录）与 `EXCLUDE_TERMS`（命中即剔除，用来挡掉数码/娱乐噪音）

> 单源失败只会跳过并打日志，不影响整轮采集。新源先用 `--source=<id> --dry-run` 验证解析结果。

## 数据格式

`data/YYYY-MM-DD.json`：

```json
{
  "date": "2026-09-10",
  "generation": "evening",
  "updatedAt": "2026-09-10T12:05:00.000Z",
  "items": [
    { "id": "url-md5", "title": "…", "source": "IT之家",
      "time": "2026-09-10T11:47:00.000Z", "url": "https://…", "digest": "AI 摘要（1-2 句）" }
  ],
  "briefing": {
    "summary": "当日总览",
    "part1": { "launch": [], "line": [], "risk": [], "policy": [] },
    "part2": { "finance": [], "capital": [], "chain": [], "corp": [] }
  }
}
```

`data/index.json` 记录可用日期列表（倒序）与最新日期。

> 落盘只保留标题、来源、时间、原文链接与 AI 摘要 —— **不保存抓取到的原文正文**，点卡片跳原文站点阅读。

## 说明与注意

- 仓库是公开的，`data/` 与页面 URL 知道即可访问（自用定位，不做鉴权）。
- 本机（浏览器）会缓存最近 7 天的数据快照；勾选的关键词、自定义词也存本机，不上传。
- 页面**刷新按钮**的含义是「拉取最新已生成的数据」。真正的重新采集发生在 08:00 / 20:00 的定时任务，或在 Actions 页手动 Run workflow。
- GitHub Pages 有约 10 分钟 CDN 缓存，页面请求都带了时间戳参数，正常不会读到旧文件。
- 定时任务在 UTC 整点排队，可能有几分钟延迟，属正常现象。
- 后续要转微信小程序：`index.html` 顶部的 `LIB` 是**与 DOM 无关的纯逻辑层**（取数/缓存/词典匹配/格式化/简报拼装），可直接复用，只需替换下面的 UI 层；数据源为 https 的 Pages 域名，真机需在小程序后台配置 request 合法域名。
