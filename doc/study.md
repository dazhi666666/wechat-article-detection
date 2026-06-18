# 微信公众号文章爬虫技术研究

> 本文档系统性梳理微信公众号（mp.weixin.qq.com）的内容获取机制，以及本扩展（`wechat-article-detection`）所采用的爬虫实现方案。

---

## 一、为什么公众号是「最难爬的网站」之一

微信公众号是国内少数把"内容生态完全封闭"做到极致的产品。它的封闭性体现在四个层面：

| 层面 | 表现 |
|------|------|
| **协议层** | 文章正文、列表、搜索都没有公开 API。所有数据接口都隐藏在 mp.weixin.qq.com 的后台页内 |
| **授权层** | 任意接口都依赖从 mp.weixin.qq.com 域名下签出的 Cookie（含 `wxtokenkey`、bizuin 等），一旦缺失立即返回 200001 |
| **数据层** | 文章 ID、公众号 fakeid 都是内部 ID（13-14 位十进制数），与公众号微信号不同名 |
| **反爬层** | 没有显式验证码，但有"静默限流"：连续请求过密时 `ret: 200013` 直接吃请求，不返回数据也不报错 |

正因为这四道墙，业界公众号爬虫几乎都走"浏览器自动化 + 内部接口嗅探"路线。

---

## 二、爬虫的整体范式

### 2.1 三种主流方案对比

| 方案 | 代表 | 优点 | 缺点 |
|------|------|------|------|
| **搜狗微信搜索** | sogou.com/weixin | 无需登录，公开搜索 | 关键词召回差，无时间过滤，文章不能完全覆盖 |
| **公众号平台接口** | mp.weixin.qq.com | 数据全、含时间戳、含阅读数 | 必须先登录；接口非官方；严限流 |
| **第三方服务** | weixin-crawler / 聚合数据 | 简单，调用 HTTP API | 收费、数据有滞后、违反用户隐私 |

**本扩展选第二条**——直接打 mp.weixin.qq.com 的内部接口。

### 2.2 完整链路

```
用户打开扩展 popup
  └─ 输入若干公众号名称
       └─ 浏览器打开 mp.weixin.qq.com（带 user 登录态的 cookie）
            └─ Content Script 注入
                 └─ 在页面上下文中调用两个内部接口
                      ├─ searchbiz          : 公众号名 → fakeid
                      └─ appmsgpublish      : fakeid + page → 文章列表 JSON
                           └─ 拼装渲染
```

关键点：**接口必须从 mp.weixin.qq.com 域名发出**，否则服务端直接 403。popup.js 在后台发起 fetch 不行，所以必须让 content script 在前台页面里发。

---

## 三、认证机制

### 3.1 必要 Cookie

打开浏览器登录 https://mp.weixin.qq.com 后，DevTools 抓包可以看到请求头会带这些 Cookie：

| Cookie | 作用 |
|--------|------|
| `wxtokenkey` | 长期 token（7 天），每次请求都参与签名 |
| `wxuin` | 公众号原始 uin（即 "bizuin"） |
| `ticket` | 短期 ticket，5-10 分钟失效 |
| `slave_sid` / `slave_user` | 微信分配的会话级身份 |

**没有这些 Cookie，所有接口都会返回 `{"ret":200001,...}` 错误。**

### 3.2 Content Script 注入的妙用

本扩展没有让用户"自己 cookie 自己抓"，而是：

1. 让扩展自己开一个 `mp.weixin.qq.com` 的 tab（popup.html 的"打开公众号"按钮）；
2. 那个 tab 一旦加载完，content script 自动注入；
3. content script **从 `document.cookie` 拿 cookie，然后调内部接口**——天然带上用户已登录态。

这种"借用户会话"的模式，比用 Puppeteer 模拟登录要稳定得多（免去滑块验证、短信验证等流程）。

### 3.3 为什么 fetch 是从 popup.js 发的？

代码层面我们把请求 `fetch('/cgi-bin/searchbiz?...')` 写在 content script 里。当 content script 在 `https://mp.weixin.qq.com/cgi-bin/...` 页面运行时：

- `fetch` 走相对路径，自动拿到当前 origin 的 cookie；
- 浏览器自动加 `Origin: https://mp.weixin.qq.com` 和 `Referer: https://mp.weixin.qq.com/...` 头；
- 服务端校验通过。

如果在 popup（`chrome-extension://...` origin）里发 fetch，绝对会被服务端拒绝。

---

## 四、核心接口详解

### 4.1 搜索接口 `searchbiz`

**目的**：把公众号"中文名"翻译成内部 `fakeid`。

**请求**：
```
GET https://mp.weixin.qq.com/cgi-bin/searchbiz
  ?action=search_biz
  &query=量子位
  &begin=0
  &count=5
  &lang=zh_CN
  &f=json
  &ajax=1
```

**响应**（关键字段）：
```json
{
  "ret": 200,
  "errmsg": "ok",
  "list": [
    {
      "fakeid": "2394495802",
      "nickname": "量子位",
      "alias": "QbitAI",
      "signature": "追踪人工智能新趋势…",
      "headimg": "...",
      "service_type": 1,
      "verify_status": 0
    }
  ],
  "total": 1
}
```

**注意**：
- `ret: 200013` = 频率限制；
- `ret: 200` 但 `list: []` = 搜不到（公众号不存在或被封）；
- `ret: 200001` = Cookie 失效，需重新登录。

### 4.2 文章列表接口 `appmsgpublish`

**目的**：拿到公众号的文章元数据（标题、链接、时间、摘要）。

**请求**：
```
GET https://mp.weixin.qq.com/cgi-bin/appmsgpublish
  ?action=list_ex
  &begin=0            ← 起始文章下标（不是页码）
  &count=10
  &fakeid=2394495802
  &type=10            ← 10 表示图文消息
  &lang=zh_CN
  &f=json
  &ajax=1
```

**响应**（关键字段）：
```json
{
  "ret": 200,
  "errmsg": "ok",
  "publish_page": "{ \"publish_list\": [ ... ] }"
}
```

注意 `publish_page` 是个 **转义后的 JSON 字符串**，需要二次 `JSON.parse`。

`publish_list` 每项里：
```json
{
  "publish_info": "{ \"appmsgex\": [ { \"title\": \"...\", \"link\": \"...\", \"create_time\": 1715000000, ... } ] }"
}
```

`publish_info` 同样是字符串，需要再 `JSON.parse` 一次。

**关键字段**：
- `title`：文章标题；
- `link`：`https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...&sn=...`；
- `create_time`：Unix 秒级时间戳，用于和 `cutoffTs` 比较，过滤老文章。

### 4.3 文章正文（不实现）

本扩展**只拉列表**，不抓正文。原因：
- 正文页有更多反爬（内容懒加载、字体反爬、js 渲染）；
- 对"监控最近 N 天的新文章"这个核心需求，列表已经够用；
- 正文可以用列表里的 `link` 直接打开浏览器看。

如果未来要抓正文，可以走 `https://mp.weixin.qq.com/s/{sn}` 这条公开地址，用 Puppeteer 渲染，提取 `.rich_media_content` 的 innerText。

---

## 五、限流机制与本扩展的应对

### 5.1 限流错误码对照

| ret | 含义 | 触发场景 |
|-----|------|----------|
| `200` | 成功 | — |
| `200001` | 系统错误 / Token 失效 | Cookie 失效，需重登 |
| `200003` | 鉴权失败 | IP 异常或 token 过期 |
| `200013` | 频率限制 | 30 秒内请求过密（≥40 次） |
| `err_msg=内容不存在` | 公众号被封 | 持续数年不更新 |

### 5.2 实测限流曲线

经过多轮 200+ 账号测试：

| 参数 | 安全值 | 临界值 | 触发率 |
|------|--------|--------|--------|
| 搜索间隔 | **600 ms** | 500 ms | 0.5s 几乎必触发；0.6s 偶发 1-2 次 |
| 文章页间隔 | 200 ms | 100 ms | 100ms 稳触发，200ms 零触发 |
| 并发数 | **3 worker** | 5+ worker | 5+ worker + 600ms 仍频繁 200013 |

### 5.3 重试策略

#### 搜索侧（`searchWithRetry`）

```
对每个 fakeid 查询：
  尝试 1: 直接 search
  失败 + ret=200013:
    → 记录"搜索冷却 60s"日志
    → sleep 60s
    → 尝试 2
  失败 + ret=200013:
    → 记录"重试 2/2"日志
    → sleep 60s
    → 尝试 3
  仍失败:
    → 抛出错误，该账号标记为 FAILED
```

#### 文章侧（`fetchArticlesPageWithRetry`）

```
对每页文章列表：
  尝试 1: 直接 fetch
  失败 + "文章频率限制":
    → 记录 ART-RL 日志
    → sleep 30s
    → 尝试 2
  失败 + "文章频率限制":
    → 记录 ART-RL 日志
    → sleep 30s
    → 尝试 3
  仍失败:
    → 抛错，账号被 catch 住，写 ART-FAIL
```

**为什么搜索冷却 60s 而文章冷却 30s？** 经验观察：搜索接口限流比文章接口"重"得多。文章接口只要停 30s 就能恢复，搜索接口可能需要 60s+。

### 5.4 全局串行搜索队列

并发 worker 内部，看似"并行 3 个 fakeid 查询"，但**所有搜索请求都串行排队**：

```js
const _searchQueueTail = Promise.resolve();
async function enqueueSearch() {
  const myPromise = _searchQueueTail.then(async () => {
    await sleep(600);  // 全局节流
    return trySearchOnce();
  });
  _searchQueueTail = myPromise.catch(() => {});  // 不让一个失败污染整条链
  return myPromise;
}
```

这样即使开 3 个 worker，请求层也是 600ms 一次的"流水线"，避免多个 worker 同时撞搜索接口。

---

## 六、代码架构图

```
popup.html
  └─ 左侧输入面板
       └─ 右侧日志面板（zoom 1.4，160px 高）

popup.js (controller)
  │
  ├─ searchFakeid(name)
  │    └─ enqueueSearch()        ← 全局串行 600ms 队列
  │         └─ trySearchOnce()   ← 一次搜索
  │         └─ searchWithRetry() ← 200013 重试包装
  │
  ├─ fetchArticlesPage(fakeid, page)
  │    └─ fetchArticlesPageWithRetry()  ← 文章重试包装
  │
  ├─ monitorAccount(name, cutoffTs)
  │    ├─ searchFakeid(name)
  │    ├─ while page <= 5:
  │    │    ├─ fetchArticlesPageWithRetry()
  │    │    └─ sleep 200
  │    └─ log ART 汇总
  │
  ├─ runMonitor()
  │    └─ Promise 池 (3 worker)
  │         └─ monitorAccount
  │
  └─ 日志系统
       ├─ logRunStart / logDone
       ├─ logStart / logOk / logFail
       ├─ logCoolStart / logCoolEnd
       ├─ logRetry
       ├─ copyLog / downloadLog / clearLog

content.js
  └─ 监听 popup 消息，调用 searchbiz / appmsgpublish
     （运行在 mp.weixin.qq.com 域，带 cookie）

background.js
  └─ chrome.action.onClicked → 打开 popup.html 全屏 tab
```

---

## 七、未来可优化方向

### 7.1 fakeid 缓存（最大收益）

公众号名称→fakeid 是一次性翻译操作。第二次跑同一批账号时，**搜索阶段完全可以跳过**：

- 首次运行：262 个账号搜索 ~157s；
- 二次运行：搜索阶段归零；
- 估算节省：100+ 秒。

实现：在 `chrome.storage.local` 持久化 `{ name: fakeid }` 字典，扩展启动时加载。

### 7.2 限流探测反压

目前是"固定 600ms"被动防御。可以做主动探测：

```
连续 N 次成功 → 试探把间隔降到 550ms
连续 1 次 200013 → 退回 700ms
```

这类似 TCP 慢启动 / 拥塞控制，理论上能跑出 7-8 req/s 的上限。

### 7.3 错误账号重跑

`runMonitor` 结束后，若 `failed.length > 0`，提示用户"是否重试失败项"？失败的 fakeid 大概率还是有效的，重试一次成功率很高。

### 7.4 按公众号维护频率动态调页数

热门公众号（量子位、虎嗅）日更 3-5 篇，5 页 = 50 篇 ≈ 2-3 周；
冷门公众号（周更 / 月更），第 2 页就空了，浪费 80% 请求。

可以先拉第 1 页，根据 `total` 和 `create_time` 决定是否继续。

### 7.5 content script 走 Service Worker

MV3 不再支持 background page，但 content script 仍然能用。如果 popup 不在 mp.weixin.qq.com 域内没法直接调 fetch，可以：
- 让 popup 把账号列表发到 background；
- background 维持一个"跳板 tab"（已经登录的 mp.weixin.qq.com）；
- 通过 `chrome.tabs.sendMessage` 触达 content script。

这其实就是当前 content.js 的角色。架构已经够用，扩展性也 OK。

---

## 八、法律与道德提示

- 公众号内容受《著作权法》保护。仅做个人"已关注公众号"的内容监控，**不要用于商业转售、聚合分发、内容农场**。
- 大量并发请求会对 mp.weixin.qq.com 服务器造成负载。建议**单日单 IP 不超过 5000 次**。
- 微信有权随时调整接口和限流策略，本扩展的实现可能在数月内失效。

---

## 九、调试小抄

### DevTools 抓包

1. 打开 mp.weixin.qq.com，登录；
2. F12 → Network → 过滤 `searchbiz` 和 `appmsgpublish`；
3. 复制 cURL 命令，可以独立测试：
   ```bash
   curl 'https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&query=量子位&begin=0&count=5&lang=zh_CN&f=json&ajax=1' \
        -H 'Cookie: wxtokenkey=...; wxuin=...' \
        -H 'X-Requested-With: XMLHttpRequest'
   ```

### 扩展调试

- 扩展页面 → Service Worker → "检查视图"：看 background.js 日志；
- 在 mp.weixin.qq.com 页面 F12 → Console：可以手动 `chrome.runtime.sendMessage(...)` 测 content script 通信。

### 常见错误

| 现象 | 原因 | 解决 |
|------|------|------|
| 所有搜索返回 200001 | cookie 失效 | 重新打开 mp.weixin.qq.com 让它续期 |
| 搜索假名能搜到但列表 200013 | 列表接口限流更严 | 改 30s 间隔（已自动重试） |
| popup 打不开 | `default_popup` 还在 manifest | 必须移除，否则 onClicked 不触发 |
| 日志面板没显示 | 缺 `#log-panel` DOM | 检查 popup.html 末尾 |
| 偶发"未找到" | 公众号改过名 | 在搜索词上加 alias |
