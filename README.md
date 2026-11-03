# dsh-bilibili-bundle 0.2.0 —— B 站工具插件 bundle

一个 DeepSeek Harness（DSH）**Host 工具插件 bundle**，按「一个包、多个插件」编排：
每个插件是 [`cordis.patch.yml`](cordis.patch.yml) 里的一行，通过包名子路径
（`dsh-bilibili-bundle/plugins/<name>`）挂载，插件之间互不耦合。

当前包含的插件：

| 插件行 id | 子路径 | 工具 | 说明 |
| --- | --- | --- | --- |
| `bilibili-topic-heat` | `plugins/topic-heat` | `bili_topic_heat` | 单个 B 站话题在 1d/7d/1m/90 跨度内的多模型热度指数（0~100）与可解释拆解。 |
| `bilibili-progress-nudge` | `plugins/progress-nudge` | — | 每 N 个模型步注入一条进度提醒快照（`agent/pre-step`，不经 systemPrompt）。 |
| `bilibili-topic-heat-guidance` | `plugins/topic-heat-guidance` | — | 当且仅当 `bili_topic_heat` 出现在工具 schema 中时，系统提示词追加英文使用策略。 |

除插件行外无其他 patch 条目：bundle **故意不覆盖部署 persona**（原因见 §3.1）。

所有插件共享同一套 B 站请求基础设施（[`lib/shared/`](lib/shared/client.js)：
`BiliClient`、全局限速、磁盘缓存、风控退避），纯 ESM、零第三方运行时依赖。
数据来自 B 站搜索接口的低频只读采样。

> 工具只在被模型调用时才访问网络；插件激活本身不发请求、不写用户文件
> （缓存写入系统临时目录）。

## 1. 能力简介

- **一个问题**：「过去 N 天，B 站上这个话题有多热？」
- **两个输入**：话题词（单个）+ 时间跨度（`1d` / `7d` / `1m` / `90`）。
- **一组输出**：主指数与评级、4 个模型分（综合 / 讨论 / 动量 / 规模）、
  7 个归一化分量、共识度、采样证据、代表视频、警告与数据来源。
- **怎么算**：搜索接口按 `order=click`（存量，看播放头部）与 `order=pubdate`
  （增量，看最新发布）双采样，按 `bvid` 去重；7 个分量归一化后加权成主指数，
  再用 4 套权重得到 4 个模型分；上榜热搜按名次给主指数少量加成。
- **可解释**：返回里同时给出原始值、归一化值、权重、证据规模与警告，
  模型和人都能判断这个分数可不可信。

## 2. 工具与参数

工具名：`bili_topic_heat`

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `topic` | string | 是 | — | 单个 B 站话题关键词，例如 `原神`。**不支持多个话题/逗号分隔**。 |
| `window` | string | 否 | `7d` | 时间跨度，取值见下表。 |

`window` 的取值由插件 config 的 `windows` 键生成（默认即下表）：

| 取值 | 含义 |
| --- | --- |
| `1d` | 近 1 天 |
| `7d` | 近 7 天（默认） |
| `1m` | 近 30 天 |
| `90` | 近 90 天 |

采样页数、锚点、模型权重、限速、缓存、超时等**都不由模型填写**，全部来自
插件 config，见第 5 节。

## 3. 提示词与节奏插件

bundle 除工具插件外还带两类「面向模型」的装配（persona 除外，见 §3.1），
由 [`cordis.patch.yml`](cordis.patch.yml) 的 insert 行声明：

### 3.1 为什么不带部署 persona（踩坑记录）

早期版本曾按 id 覆盖 `system-prompt` 行的 `personaPrefix`，**实测不生效**：
Web 会话默认使用 standard agent preset，preset 挂载的
`@deepseek-ai/dsh-persona` 会在 **agent 作用域**注册与部署级**同名**
（`deployment:persona-prefix`）的提示词段；按作用域遮蔽规则，scoped 段
替换全局段 —— 部署层的 persona 在 preset 会话里永远不渲染（这是 DSH 的
设计：preset 取代部署 persona，同名正是替换机制）。`--dump-config` 能看
到配置组合成功，但它没机会出现在请求里。

要改 Web 会话的 persona，正确做法：

- 用 Web 界面的 **preset 编辑器**（推荐，编辑结果按 id 存进 profile patch）；
- 或在 profile 的 `cordis.patch.yml` 覆盖 `preset-standard` 行内 persona
  插件的 `prefix` 配置（注意 config 是整体替换，需重写该行 `plugins` 列表）。

无 preset 的部署（如 sdk-minimal，agent-loop `agents: []`）里部署 persona
才会直接渲染 —— 那种场景用 `DSH_SYSTEM_PROMPT` 环境变量或按 id 覆盖
`system-prompt` 行即可。

### 3.2 进度提醒（`bilibili-progress-nudge`）

每 `everySteps` 个模型步（默认 5）在消息流末尾追加一条 user 角色、
`form: 'snapshot'` 的英文提醒，让模型先向用户简要反馈当前进度再继续。
机制是 `agent/pre-step` waterfall（与 `dsh-time-context` 同路），**不经过
`ctx.systemPrompt`**：不受极简模式的 runtime-context 抑制影响，两种模式
行为一致；计数按会话隔离（WeakMap），随会话回收。

config：`everySteps`（提醒间隔，正整数）、`text`（提醒文案，模型可见）。

### 3.3 工具使用策略（`bilibili-topic-heat-guidance`）

当且仅当 `bili_topic_heat` 出现在本次组装的工具 schema 中时，系统提示词里
追加一段英文策略：B 站话题热度只允许经 `bili_topic_heat` 获取。机制是
`system-prompt/assemble` waterfall —— 段的 text 函数看不到最终工具列表，
而 waterfall 拿到的 `assembly.tools` 是收集 + 按 agent 限制之后的权威结果，
所以判断只能在 waterfall 里做（严格满足 if-and-only-if；工具被 preset 过滤
掉时段不出现）。段排序 2500，位于全库共享的 `SECTION_ORDERS` 工具引导号段
`TOOL_GOAL(2400)` 与 `TOOL_WORKFLOW(2600)` 之间的空档。

**踩坑记录**：Cordis waterfall 的 `next()` **不传递参数** —— `next(x)` 的
`x` 被忽略，链条最内层 fallback 永远返回原始 assembly。正确写法是
`const result = await next(); return modify(result)`（自己 return 修改值，
逐级向上传播；`dsh-working-directory` 同款）。用「会透传参数的假 next」
自测会通过，但真实运行时修改会静默丢失。

## 4. 返回结构

工具返回一个可直接 JSON 序列化的对象（也是 `output.schema`），结构固定：

| 字段 | 说明 |
| --- | --- |
| `topic` | 查询的话题词。 |
| `window` | `{ preset, days, label, start, end }`：窗口预设、天数、中文标签与起止时间（ISO）。 |
| `asOf` | 本次评估的参考时刻（ISO）。 |
| `heat` | `{ index, tier, baseIndex, hotBonus }`：主热度指数 0~100、评级、加权基础分、热搜加成。 |
| `models` | 4 个模型分，见下。 |
| `consensus` | `{ mean, min, max, spread, agreement }`：4 个模型基础分的均值/最小/最大/极差与一致度（`一致` / `基本一致` / `分歧`）。 |
| `components` | 7 个分量：`{ id, name, raw, normalized, weight, points }`。 |
| `evidence` | 采样证据，见下。 |
| `topVideos` | 代表视频：`{ title, author, play, like, pubdate, url }`，条数 ≤ `output.topVideos`。 |
| `warnings` | 警告文案数组，条数 ≤ `output.maxWarnings`；无警告时为空数组。 |
| `source` | `{ engine, fetchedAt, cached, requests }`：数据引擎、抓取时刻、是否缓存命中、请求次数。 |

**4 个模型**（`models[i].id` 固定，顺序固定）：

| id | 名称 | 回答的问题 |
| --- | --- | --- |
| `composite` | 综合热度 | 与主指数口径一致的综合分。 |
| `discussion` | 讨论热度 | 多少人愿意互动/讨论。 |
| `momentum` | 近期动量 | 是不是「现在正在发生」。 |
| `scale` | 消费规模 | 盘子有多大、有没有爆款。 |

每个模型对象为 `{ id, name, index, tier, summary }`，`summary` 是一句人话，
例如「互动率 12.4%，讨论最活跃」。

> 注意：4 个模型分**不含热搜加成**；`heat.index = clamp(composite + hotBonus)`，
> 因此 `heat.index` 可能比 `models[0].index` 多出 `hotBonus`。

**7 个分量**（`components[i].id` 固定，顺序固定）：
`play` 播放规模、`engagement` 互动总量、`rate` 互动密度、`peak` 爆款强度、
`velocity` 更新速度、`supply` 搜索供给、`relevance` 相关性。
`raw` 是原始量，`normalized` 是 0~1 归一化值，`weight` 是该分量在综合模型中的
权重，`points` 是它贡献的分数。

**`evidence` 字段**：`sampleSize`（存量样本数）、`recentSize`（增量样本数）、
`headSize`（进入规模类分量的头部条数）、`numResults`（窗口内搜索命中数）、
`velocityPerDay`（条/天）、`relevance`（相关性比例）、`hotRank`（热搜名次，
未上榜为 `null`）、`hotBonus`、`medianPlay`、`p90Play`、`authors`。

**数值约定**：指数/均值等保留 2 位小数，`relevance` 3 位，`velocityPerDay` 1 位；
不会出现 `NaN` / `Infinity` / `undefined`。网络或风控失败时工具抛中文 `Error`，
不返回半成品。

**评级阈值**：`≥75` 爆、`≥60` 热、`≥45` 温、`≥30` 冷、`<30` 凉。

## 5. config 全字段

以下默认值与 [`cordis.patch.yml`](cordis.patch.yml) 一一对应，全部可被 profile
的 patch 层覆盖。插件会对非法类型/越界值回退默认值，不抛错；权重不要求和为 1，
内部按 Σweight 归一化。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `defaults.window` | `"7d"` | 默认时间跨度，必须是 `windows` 的键之一。 |
| `windows` | `{"1d":1,"7d":7,"1m":30,"90":90}` | 跨度预设 → 天数；键集合决定工具 `window` 的 enum。 |
| `sampling.pageSize` | `50` | 搜索单页条数。 |
| `sampling.stockPages` | `3` | 按播放排序（存量）翻页数。 |
| `sampling.flowPages` | `3` | 按发布时间排序（增量）翻页数。 |
| `sampling.headSize` | `50` | 进入规模类分量的头部条数（按播放降序）。 |
| `sampling.minSample` | `5` | 样本量下限，低于它给 warning。 |
| `request.intervalMs` | `2000` | 相邻请求最小间隔（毫秒），用于限速。 |
| `request.timeoutMs` | `15000` | 单次请求超时（毫秒）。 |
| `request.maxRetries` | `3` | 失败重试次数（指数退避 + 刷新 Cookie）。 |
| `request.maxRequests` | `60` | 单次工具调用的请求预算。 |
| `request.cacheTtlSeconds` | `3600` | 磁盘缓存有效期（秒）。 |
| `request.cacheDir` | `""` | 缓存目录；空字符串表示 `os.tmpdir()/dsh-bilibili-cache`（整个 bundle 共用）。 |
| `request.userAgent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36` | 请求 UA，需伪装成普通浏览器以避免 412。 |
| `anchors.playLogFloor` | `4.4` | 播放规模 log 归一化下界。 |
| `anchors.playLogCeil` | `7.6` | 播放规模 log 归一化上界。 |
| `anchors.engLogFloor` | `2.8` | 互动总量 log 归一化下界。 |
| `anchors.engLogCeil` | `6.5` | 互动总量 log 归一化上界。 |
| `anchors.peakLogFloor` | `5.0` | 爆款强度 log 归一化下界。 |
| `anchors.peakLogCeil` | `7.85` | 爆款强度 log 归一化上界。 |
| `anchors.rate` | `0.13` | 互动密度的 log 归一化锚点。 |
| `anchors.supply` | `1000` | 搜索供给 `numResults` 的 log 归一化锚点。 |
| `anchors.velocity` | `4000` | 更新速度（条/天）的 log 归一化锚点。 |
| `anchors.supplySaturatedValue` | `1.0` | `numResults` 触顶（≥1000）时直接记的归一化值。 |
| `engagementWeights` | `{"like":1,"favorite":2,"reply":2,"danmaku":3}` | 加权互动的系数，越难刷的互动权重越高。 |
| `modelWeights.composite` | `{"play":0.18,"engagement":0.22,"rate":0.15,"peak":0.10,"velocity":0.20,"supply":0.05,"relevance":0.10}` | 综合热度权重。 |
| `modelWeights.discussion` | `{"engagement":0.40,"rate":0.35,"peak":0.10,"relevance":0.15}` | 讨论热度权重。 |
| `modelWeights.momentum` | `{"velocity":0.55,"supply":0.25,"relevance":0.20}` | 近期动量权重。 |
| `modelWeights.scale` | `{"play":0.45,"peak":0.30,"supply":0.25}` | 消费规模权重。 |
| `relevance.floor` | `0.30` | 相关性低于该比例时触发惩罚。 |
| `relevance.penalty` | `0.6` | 触发时主指数与各模型分乘的系数，并给 warning。 |
| `hotBonusMax` | `8` | 热搜加成上限（分）；名次越高加成越小。 |
| `tiers` | `[{"label":"爆","min":75},{"label":"热","min":60},{"label":"温","min":45},{"label":"冷","min":30}]` | 评级阈值，从高到低；低于 30 为「凉」。 |
| `output.topVideos` | `5` | 返回的代表视频条数。 |
| `output.maxWarnings` | `6` | 最多保留的警告条数。 |

## 6. bundle 结构与新增插件

```
bilibili-bundle/
├── cordis.patch.yml        # 每个插件一行 insert：id + name(子路径) + 自包含 config
├── package.json            # exports 暴露 ./plugins/* 子路径（每插件一个入口）
├── lib/
│   ├── shared/             # 跨插件共享基础设施（不是插件，没有 apply）
│   │   ├── client.js       #   BiliClient：Cookie/wbi/全局限速(per-process)/缓存/退避
│   │   ├── http.js         #   request/sampling 共享配置与解析、resolveCacheDir
│   │   ├── errors.js       #   BiliApiError / isRiskError / RISK_CODES
│   │   ├── windows.js      #   通用时间窗口解析/量化/搜索过滤参数
│   │   └── validate.js     #   config 清洗小工具（深合并/数值兜底）
│   └── plugins/
│       ├── topic-heat/          # 插件私有：index.js(apply) + config/signals/scoring/format
│       ├── progress-nudge/      # 单文件插件：agent/pre-step 进度提醒
│       └── topic-heat-guidance/ # 单文件插件：system-prompt/assemble 条件引导段
├── locale/topic-heat/      # 插件级 locale（exports 映射为 ./plugins/<name>/locale/）
└── test/                   # smoke.mjs（离线）/ live.mjs（联网）/ fixtures/
```

新增一个插件的固定动作：

1. 建 `lib/plugins/<name>/index.js`，导出 `name`（与 patch 行 id 一致）、
   `inject` 和 `apply(ctx, config)`；需要访问 B 站接口时从 `../../shared/` import，
   **不要** import 其他插件目录里的东西。
2. `package.json` 的 `exports` 已用通配 `./plugins/*` 覆盖，无需修改。
3. 在 `cordis.patch.yml` 末尾追加一行 `- insert`：`id`、
   `name: dsh-bilibili-bundle/plugins/<name>`、自包含默认 `config`。
4. 需要 B 站请求能力之外的共享代码时，先把它下沉到 `lib/shared/` 再复用。

## 7. 安装与在 mypro profile 启用

```bash
# 安装到 mypro profile：写入 profile 的依赖，并把包名追加到 dsh.profile.bundles
dsh plugin --profile mypro add /mnt/d/dsh-main/bilibili-bundle
```

安装后 bundle 的 [`cordis.patch.yml`](cordis.patch.yml) 会自动应用，向 profile
插入一行 `id: bilibili-topic-heat`、`name: dsh-bilibili-bundle/plugins/topic-heat`
的插件行。确认装配结果：

```bash
dsh --profile mypro --dump-config
```

应当能看到 `bilibili-topic-heat` 行及其 config，且 `dsh-bilibili-bundle` 出现在
`dsh.profile.bundles` 中。

**覆盖默认配置**：在 profile 的 patch 层
（`~/.dsh/profiles/mypro/cordis.patch.yml`）按 id 定向覆盖即可。插件会深合并
默认值，只需写想改的字段（未写的字段回落到插件内建默认值）：

```yaml
- id: bilibili-topic-heat
  config:
    defaults:
      window: "1m"
    request:
      intervalMs: 3000
```

**临时关闭**：

```yaml
- id: bilibili-topic-heat
  disabled: true
```

关闭后 `bili_topic_heat` 从工具列表消失；重新启用把 `disabled` 改回 `false`
并重启对应的 dsh 进程。

## 8. 设计取舍与局限

1. **只是采样估计，不是全站真值**：每次调用对每个窗口取约 300 条去重样本
   （存量 + 增量双排序各翻几页），是采样而非全量，不能当「全站总量」。
2. **窗口越长，指数通常越高**：指数语义是「窗口内绝对热度」，不是跨窗口可比的
   标准化分数。同一话题 `1d` 与 `90` 的分数不能直接比大小；有意义的是
   **近期占比 = 短窗口指数 / 长窗口指数**，越接近 1 说明热度越集中在近期。
3. **锚点按 2026-11 标定**：`anchors` 是当时实测的区间，B 站内容体量变化后
   需要重新标定；`1d` 这类极窄窗口的区分度也会下降。配置里全部可覆盖。
4. **风控与限速**：接口会 412/429，因此默认 2 秒请求间隔、指数退避重试、
   先引导 Cookie，并做磁盘缓存（默认 1 小时）。被风控时工具**抛错**而不是给
   一个不可信分数；短时间内重复调用同一话题/窗口会命中缓存。
5. **单话题**：一次只查一个话题，不支持批量或逗号分隔；跨话题对比需要多次调用，
   每次都会消耗请求预算与缓存条目。
6. **存在性与相关性门控**：窗口内无结果时直接给 0 分与警告；搜索命中但标题/标签
   与话题相关性低于阈值时软惩罚并 warning，避免被模糊搜索结果污染。
7. **索引延迟**：新发布的视频要数小时后才能被搜到，事件刚爆发时指数会被低估；
   返回的 `evidence` 与 `warnings` 用于让调用方判断可信度。
8. **接口不是官方承诺**：依赖 B 站搜索接口的字段与行为（排序、时间过滤、
   `numResults` 语义），接口变化可能导致工具失败或口径变化。

## 9. 合规声明

- 本项目仅为**个人学习/技术研究**用途，使用非 B 站官方的公开搜索接口，
  与 B 站无任何关联；
- 请求全部为**低 QPS 只读**（默认间隔 2 秒、单次调用有请求预算），
  并带本地缓存，不做批量爬取；
- 请勿用于商业用途、批量采集或对抗风控；使用时自行遵守 B 站用户协议与
  `robots.txt`；
- 热度指数是**基于采样的技术估算**，不代表 B 站官方数据或任何官方立场。
