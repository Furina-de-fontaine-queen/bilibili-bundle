#!/usr/bin/env node
/**
 * bilibili-bundle 的离线冒烟测试（只依赖 Node 内置模块 + 本包 lib/）。
 *
 * 覆盖（对应 task-4 的验收点）：
 *   1. window 解析 / 格式化 / 900s 量化；
 *   2. resolveConfig 深合并与非法值兜底；
 *   3. scoreTopic 与 Python demo 期望值对拍（golden-sample.json + scoring-fixtures.json）；
 *   4. 4 模型 / consensus / 评级阈值 / 相关性惩罚 / numResults 触顶 / 存在性门控；
 *   5. toToolValue 结构与 output.schema 一致性（字段齐全、无 NaN/undefined、数组有界、
 *      JSON 可序列化）；
 *   6. renderReport 关键行与文本长度；
 *   7. package.json / cordis.patch.yml / locale / README 与 lib 的 config、工具参数一致性；
 *      persona 覆盖与 progress-nudge / topic-heat-guidance 两个提示词插件行的契约；
 *      shouldNudge 边界、withGuidanceSection 的 if-and-only-if 语义；
 *   8. signals.js 的离线解析、去重、双采样窗口端点复用（fake client，不联网）；
 *   9. client.js 的缓存 key / 查询串 / 风控判定等纯函数。
 *
 * 运行：node test/smoke.mjs   （退出码 0 = 全部通过，1 = 有失败）
 * 本文件不访问网络、不写磁盘。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPONENT_META,
  DEFAULT_CONFIG,
  MODEL_META,
  resolveConfig,
  windowKeysFor,
  windowLabel,
} from '../lib/plugins/topic-heat/config.js'
import {
  WINDOW_BUCKET_SECONDS,
  buildWindowParams,
  formatWindow,
  parseWindow,
  toSearchTimeFilter,
} from '../lib/shared/windows.js'
import { DEFAULT_REQUEST_CONFIG, DEFAULT_SAMPLING_CONFIG, resolveCacheDir } from '../lib/shared/http.js'
import {
  bandNorm,
  clamp,
  computeVelocity,
  isRelevant,
  logNorm,
  scoreTopic,
  tierFor,
  weightedEngagement,
} from '../lib/plugins/topic-heat/scoring.js'
import { renderReport, toToolValue } from '../lib/plugins/topic-heat/format.js'
import { apply, buildToolDefinition, inject, name } from '../lib/plugins/topic-heat/index.js'
import {
  DEFAULT_CONFIG as NUDGE_DEFAULTS,
  inject as nudgeInject,
  name as nudgeName,
  resolveConfig as resolveNudgeConfig,
  shouldNudge,
} from '../lib/plugins/progress-nudge/index.js'
import {
  GUIDANCE_TEXT,
  SECTION_NAME,
  SECTION_ORDER,
  TOOL_NAME,
  inject as guidanceInject,
  name as guidanceName,
  withGuidanceSection,
} from '../lib/plugins/topic-heat-guidance/index.js'
import {
  HOT_SEARCH_PATH,
  SEARCH_TYPE_PATH,
  SEARCH_TYPE_PATH_WBI,
  buildSearchParams,
  cleanTitle,
  fetchHotSearch,
  fetchTopicSample,
  htmlUnescape,
  mergeVideos,
  parseDuration,
  parseSearchPayload,
  parseVideo,
} from '../lib/plugins/topic-heat/signals.js'
import { BiliApiError, MIXIN_KEY_ENC_TAB, cacheKeyFor, encodeQuery, isRiskError } from '../lib/shared/client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(__dirname, '..')
const FIXTURES = path.resolve(__dirname, 'fixtures')

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const golden = readJson('golden-sample.json')
const fixtures = readJson('scoring-fixtures.json')
const cfg = resolveConfig()

// --------------------------------------------------------------------------- //
// 极简断言框架：记录 PASS/FAIL、追踪与 Python 对拍的最大误差
// --------------------------------------------------------------------------- //

let passed = 0
let failed = 0
const failures = []
const maxErr = Object.create(null)

function recordError(key, diff) {
  if (!Number.isFinite(diff)) return
  if (!(key in maxErr) || diff > maxErr[key]) maxErr[key] = diff
}

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    failures.push({ label, message })
    console.log(`FAIL ${label}`)
    for (const line of message.split('\n').slice(0, 8)) console.log(`     ${line}`)
  }
}

function near(actual, expected, tolerance, label) {
  assert.equal(typeof actual, 'number', `${label}: 期望数字，实际类型 ${typeof actual}`)
  assert.ok(Number.isFinite(actual), `${label}: 不是有限数（${actual}）`)
  const diff = Math.abs(actual - expected)
  assert.ok(diff <= tolerance, `${label}: 期望 ${expected} ± ${tolerance}，实际 ${actual}（差 ${diff}）`)
}

/** 递归扫描 JSON 值：不允许 NaN / Infinity / undefined / 函数。 */
function assertJsonSafe(value, label = '$') {
  if (value === undefined) throw new Error(`${label}: 出现 undefined`)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label}: 出现非有限数字 ${value}`)
    return
  }
  if (typeof value === 'function') throw new Error(`${label}: 出现函数`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${label}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) assertJsonSafe(value[key], `${label}.${key}`)
  }
}

const MODEL_IDS = ['composite', 'discussion', 'momentum', 'scale']
const COMPONENT_IDS = ['play', 'engagement', 'rate', 'peak', 'velocity', 'supply', 'relevance']
const COMPONENT_NAME_TO_ID = {
  播放规模: 'play',
  互动总量: 'engagement',
  互动密度: 'rate',
  爆款强度: 'peak',
  更新速度: 'velocity',
  搜索供给: 'supply',
  相关性: 'relevance',
}

// --------------------------------------------------------------------------- //
// 1. window 解析 / 格式化 / 量化
// --------------------------------------------------------------------------- //

await check('window: parseWindow 支持 1d/7d/1m/90/数字/all，非法值抛错', () => {
  assert.equal(parseWindow('1d'), 1)
  assert.equal(parseWindow('7d'), 7)
  assert.equal(parseWindow('1m'), 30)
  assert.equal(parseWindow('90'), 90)
  assert.equal(parseWindow(' 7D '), 7)
  assert.equal(parseWindow(90), 90)
  assert.equal(parseWindow('30'), 30)
  assert.equal(parseWindow('all'), 0)
  for (const bad of ['abc', '', '  ', '1w', -1, NaN, Infinity, null, undefined, {}]) {
    assert.throws(() => parseWindow(bad), undefined, `parseWindow(${JSON.stringify(bad)}) 应抛错`)
  }
})

await check('window: formatWindow 与 windowLabel（90 天必须显示「近90天」）', () => {
  assert.equal(formatWindow(1), '近1天')
  assert.equal(formatWindow(7), '近7天')
  assert.equal(formatWindow(30), '近1个月')
  assert.equal(formatWindow(90), '近3个月') // 通用天数格式（与 Python demo 一致）
  assert.equal(formatWindow(0), '全时段')
  assert.equal(formatWindow(-7), '全时段')
  assert.equal(formatWindow(365), '近1年')

  // 工具展示层用 preset 固定映射：90 显示「近90天」（契约 §6/§7）
  assert.equal(windowLabel('1d', 1), '近1天')
  assert.equal(windowLabel('7d', 7), '近7天')
  assert.equal(windowLabel('1m', 30), '近1个月')
  assert.equal(windowLabel('90', 90), '近90天')
  assert.equal(windowLabel(null, 7), '近7天') // 无 preset → 回退通用格式
  assert.equal(windowLabel('2d', 2), '近2天') // 自定义窗口
})

await check('window: buildWindowParams 只对 end 按 900s 向下取整，begin=end-days*86400', () => {
  const now = 1_800_000_123_456
  const window = buildWindowParams(7, now)
  assert.equal(window.end, Math.floor(now / 1000 / WINDOW_BUCKET_SECONDS) * WINDOW_BUCKET_SECONDS)
  assert.equal(window.end % WINDOW_BUCKET_SECONDS, 0)
  assert.equal(window.begin, window.end - 7 * 86400)
  assert.equal(window.begin % WINDOW_BUCKET_SECONDS, 0) // days*86400 是 900 的倍数

  // 同一刻钟内端点必须稳定（双采样复用同一组端点的前提）
  const base = 1_800_000_000_000
  assert.deepEqual(buildWindowParams(30, base), buildWindowParams(30, base + 899_999))
  const later = buildWindowParams(30, base + 900_000)
  assert.equal(later.end - buildWindowParams(30, base).end, 900)

  // 全时段 / 非法天数 → 0，表示不带时间过滤
  assert.deepEqual(buildWindowParams(0), { begin: 0, end: 0 })
  assert.deepEqual(buildWindowParams(-1), { begin: 0, end: 0 })
  assert.deepEqual(buildWindowParams(NaN), { begin: 0, end: 0 })
  assert.deepEqual(toSearchTimeFilter(buildWindowParams(0)), {})
  assert.deepEqual(toSearchTimeFilter(window), {
    pubtime_begin_s: window.begin,
    pubtime_end_s: window.end,
  })
})

// --------------------------------------------------------------------------- //
// 2. resolveConfig：深合并 + 非法值兜底
// --------------------------------------------------------------------------- //

await check('config: 默认值严格等于契约 §5', () => {
  const c = resolveConfig()
  assert.equal(c.defaults.window, '7d')
  assert.deepEqual(c.windows, { '1d': 1, '7d': 7, '1m': 30, '90': 90 })
  assert.equal(c.sampling.pageSize, 50)
  assert.equal(c.sampling.stockPages, 3)
  assert.equal(c.sampling.flowPages, 3)
  assert.equal(c.sampling.headSize, 50)
  assert.equal(c.sampling.minSample, 5)
  assert.equal(c.request.intervalMs, 2000)
  assert.equal(c.request.timeoutMs, 15000)
  assert.equal(c.request.maxRetries, 3)
  assert.equal(c.request.maxRequests, 60)
  assert.equal(c.request.cacheTtlSeconds, 3600)
  assert.equal(c.request.cacheDir, '')
  assert.match(c.request.userAgent, /Chrome\/124\.0\.0\.0/)
  assert.equal(c.anchors.playLogFloor, 4.4)
  assert.equal(c.anchors.playLogCeil, 7.6)
  assert.equal(c.anchors.engLogFloor, 2.8)
  assert.equal(c.anchors.engLogCeil, 6.5)
  assert.equal(c.anchors.peakLogFloor, 5.0)
  assert.equal(c.anchors.peakLogCeil, 7.85)
  assert.equal(c.anchors.rate, 0.13)
  assert.equal(c.anchors.supply, 1000)
  assert.equal(c.anchors.velocity, 4000)
  assert.equal(c.anchors.supplySaturatedValue, 1.0)
  assert.deepEqual(c.engagementWeights, { like: 1, favorite: 2, reply: 2, danmaku: 3 })
  assert.deepEqual(Object.keys(c.modelWeights), MODEL_IDS)
  assert.deepEqual(c.modelWeights.composite, {
    play: 0.18,
    engagement: 0.22,
    rate: 0.15,
    peak: 0.1,
    velocity: 0.2,
    supply: 0.05,
    relevance: 0.1,
  })
  assert.deepEqual(c.modelWeights.discussion, { engagement: 0.4, rate: 0.35, peak: 0.1, relevance: 0.15 })
  assert.deepEqual(c.modelWeights.momentum, { velocity: 0.55, supply: 0.25, relevance: 0.2 })
  assert.deepEqual(c.modelWeights.scale, { play: 0.45, peak: 0.3, supply: 0.25 })
  assert.deepEqual(c.relevance, { floor: 0.3, penalty: 0.6 })
  assert.equal(c.hotBonusMax, 8)
  assert.deepEqual(c.tiers, [
    { label: '爆', min: 75 },
    { label: '热', min: 60 },
    { label: '温', min: 45 },
    { label: '冷', min: 30 },
  ])
  assert.deepEqual(c.output, { topVideos: 5, maxWarnings: 6 })
})

await check('config: 深合并保留未覆盖的默认值', () => {
  const c = resolveConfig({ sampling: { headSize: 20 }, request: { intervalMs: 500 } })
  assert.equal(c.sampling.headSize, 20)
  assert.equal(c.request.intervalMs, 500)
  assert.equal(c.sampling.pageSize, 50)
  assert.equal(c.request.timeoutMs, 15000)
  assert.equal(c.modelWeights.composite.play, 0.18)
})

await check('config: windows 可覆盖/新增，enum 顺序稳定', () => {
  const c = resolveConfig({ windows: { '1d': 2, '30d': 30 } })
  assert.equal(c.windows['1d'], 2)
  assert.equal(c.windows['30d'], 30)
  assert.equal(c.windows['7d'], 7)
  assert.deepEqual(windowKeysFor(c), ['1d', '7d', '1m', '90', '30d'])
  const customDefault = resolveConfig({ windows: { '30d': 30 }, defaults: { window: '30d' } })
  assert.equal(customDefault.defaults.window, '30d')
})

await check('config: 非法值一律回退默认值，绝不抛错', () => {
  const c = resolveConfig({
    defaults: { window: 'nope' },
    windows: { '1d': 0, bad: -3 },
    sampling: { pageSize: 0, stockPages: 'x', flowPages: 3.7, headSize: -1, minSample: 999 },
    request: {
      intervalMs: -5,
      timeoutMs: 'abc',
      maxRetries: 99,
      maxRequests: 0,
      cacheTtlSeconds: -1,
      cacheDir: '   ',
      userAgent: '   ',
    },
    anchors: { playLogFloor: 9, playLogCeil: 8, engLogFloor: 99, engLogCeil: -99, peakLogFloor: 3, peakLogCeil: 2, rate: -1, supply: 0, velocity: 0 },
    engagementWeights: { like: -1, favorite: 'x' },
    modelWeights: { composite: { play: -3 }, discussion: { engagement: 0, rate: 0, peak: 0, relevance: 0 } },
    relevance: { floor: 2, penalty: -1 },
    hotBonusMax: -1,
    tiers: [{ label: '', min: 'x' }],
    output: { topVideos: 0, maxWarnings: -2 },
  })
  assert.equal(c.defaults.window, '7d')
  assert.equal(c.windows['1d'], 1) // 非法窗口值被跳过，保留默认
  assert.deepEqual(windowKeysFor(c), ['1d', '7d', '1m', '90'])
  assert.equal(c.sampling.pageSize, 50)
  assert.equal(c.sampling.stockPages, 3)
  assert.equal(c.sampling.flowPages, 3)
  assert.equal(c.sampling.headSize, 50)
  assert.equal(c.sampling.minSample, 5)
  assert.equal(c.request.intervalMs, 2000)
  assert.equal(c.request.timeoutMs, 15000)
  assert.equal(c.request.maxRetries, 3)
  assert.equal(c.request.maxRequests, 60)
  assert.equal(c.request.cacheTtlSeconds, 3600)
  assert.equal(c.request.cacheDir, '')
  assert.match(c.request.userAgent, /Chrome/)
  // ceil<=floor 的锚点对整体回退
  assert.equal(c.anchors.playLogFloor, 4.4)
  assert.equal(c.anchors.playLogCeil, 7.6)
  assert.equal(c.anchors.engLogFloor, 2.8)
  assert.equal(c.anchors.engLogCeil, 6.5)
  assert.equal(c.anchors.peakLogFloor, 5.0)
  assert.equal(c.anchors.peakLogCeil, 7.85)
  assert.equal(c.anchors.rate, 0.13)
  assert.equal(c.anchors.supply, 1000)
  assert.equal(c.anchors.velocity, 4000)
  assert.deepEqual(c.engagementWeights, { like: 1, favorite: 2, reply: 2, danmaku: 3 })
  assert.deepEqual(c.modelWeights.composite, DEFAULT_CONFIG.modelWeights.composite)
  // 权重全为 0 → 该模型回退默认权重
  assert.deepEqual(c.modelWeights.discussion, DEFAULT_CONFIG.modelWeights.discussion)
  assert.deepEqual(c.relevance, { floor: 0.3, penalty: 0.6 })
  assert.equal(c.hotBonusMax, 8)
  assert.deepEqual(c.tiers, DEFAULT_CONFIG.tiers)
  assert.deepEqual(c.output, { topVideos: 5, maxWarnings: 6 })

  // 非对象 / 奇怪类型输入也不能抛错
  for (const bad of [null, undefined, 42, 'x', [], () => {}]) {
    assert.doesNotThrow(() => resolveConfig(bad), `resolveConfig(${String(bad)}) 不应抛错`)
  }
})

await check('config: 默认配置不可被 resolveConfig 结果反向污染', () => {
  const c = resolveConfig({ sampling: { headSize: 1 } })
  c.sampling.headSize = 99
  c.modelWeights.composite.play = 0.99
  // sampling/request 来自共享层，其余是插件私有默认配置
  assert.equal(DEFAULT_SAMPLING_CONFIG.headSize, 50)
  assert.equal(DEFAULT_CONFIG.modelWeights.composite.play, 0.18)
  assert.equal(resolveConfig().sampling.headSize, 50)
})

await check('config: resolveCacheDir 空字符串回退到 os.tmpdir()/dsh-bilibili-cache', () => {
  const fallback = path.join(os.tmpdir(), 'dsh-bilibili-cache')
  assert.equal(resolveCacheDir(''), fallback)
  assert.equal(resolveCacheDir('  /tmp/custom-cache  '), '/tmp/custom-cache')
  assert.equal(resolveCacheDir(null), fallback)
})

// --------------------------------------------------------------------------- //
// 3. 纯函数评分：归一化 / 评级 / 相关性 / 速度 / 加权互动
// --------------------------------------------------------------------------- //

await check('scoring: logNorm/bandNorm/clamp 边界', () => {
  assert.equal(logNorm(0, 4000), 0)
  near(logNorm(4000, 4000), 1, 1e-12, 'logNorm(anchor)')
  assert.equal(logNorm(-10, 4000), 0)
  assert.equal(logNorm(5000, 4000), 1) // clamp 到 1
  assert.equal(bandNorm(4.0, 4.4, 7.6), 0)
  assert.equal(bandNorm(8.0, 4.4, 7.6), 1)
  near(bandNorm(6.0, 4.4, 7.6), 0.5, 1e-12, 'bandNorm 中点')
  assert.equal(bandNorm(6.0, 7.6, 4.4), 0) // ceil<=floor 保护
  assert.equal(clamp(2, 0, 1), 1)
  assert.equal(clamp(-2, 0, 1), 0)
  assert.equal(clamp(NaN, 0, 1), 0)
})

await check('scoring: tierFor 评级阈值（≥75 爆 / ≥60 热 / ≥45 温 / ≥30 冷 / 其余凉）', () => {
  assert.equal(tierFor(100), '爆')
  assert.equal(tierFor(75), '爆')
  assert.equal(tierFor(74.99), '热')
  assert.equal(tierFor(60), '热')
  assert.equal(tierFor(59.99), '温')
  assert.equal(tierFor(45), '温')
  assert.equal(tierFor(44.99), '冷')
  assert.equal(tierFor(30), '冷')
  assert.equal(tierFor(29.99), '凉')
  assert.equal(tierFor(0), '凉')
  assert.equal(tierFor(NaN), '凉')
})

await check('scoring: weightedEngagement（like*1 + favorite*2 + reply*2 + danmaku*3）', () => {
  assert.equal(
    weightedEngagement({ like: 1, favorite: 2, reply: 3, danmaku: 4 }),
    1 + 2 * 2 + 3 * 2 + 4 * 3,
  )
  assert.equal(weightedEngagement({}), 0)
  assert.equal(weightedEngagement({ like: 'x', favorite: -5, reply: 2.9, danmaku: NaN }), 0 + 0 + 2 * 2 + 0)
})

await check('scoring: isRelevant（整词包含；len>=3 时前2/后2字兜底）', () => {
  assert.equal(isRelevant('原神', { title: '原神 5.3 前瞻', tag: '' }), true)
  assert.equal(isRelevant('原神', { title: '无关视频', tag: '原神' }), true)
  assert.equal(isRelevant('小米汽车', { title: '小米SU7 实测', tag: '' }), true) // 前 2 字命中
  assert.equal(isRelevant('小米汽车', { title: '汽车之家 小米', tag: '' }), true) // 后 2 字命中
  assert.equal(isRelevant('原神', { title: '其他游戏', tag: '' }), false) // 长度 2，不做前后缀兜底
  assert.equal(isRelevant('', { title: '原神' }), false)
  assert.equal(isRelevant(null, null), false)
})

await check('scoring: computeVelocity（负年龄 clamp 0、分子含 pubdate=0、参考时刻）', () => {
  const ref = 1_800_000_000_000
  const recent = [
    { pubdate: 0 },
    { pubdate: 1_800_000_000 - 86400 },
    { pubdate: 1_800_000_000 - 2 * 86400 },
  ]
  near(computeVelocity(recent, ref), 3 / 2, 1e-12, 'velocity 3 条 / 2 天')
  assert.equal(computeVelocity([{ pubdate: 0 }, { pubdate: 0 }], ref), 0)
  assert.equal(computeVelocity([], ref), 0)
  assert.equal(computeVelocity([{ pubdate: 0 }, { pubdate: 0 }], 0), 0)
  // 未来时间（负年龄）按 0 处理，分母兜底 0.001
  near(computeVelocity([{ pubdate: 1_800_000_100 }], ref), 1000, 1e-9, '负年龄 clamp')
})

// --------------------------------------------------------------------------- //
// 4. 与 Python demo 对拍（golden-sample + 5 组 fixtures）
// --------------------------------------------------------------------------- //

function compareWithPython(label, report, expected) {
  // 主指数与基础分：契约 §8.2 容差 0.1
  recordError('index', Math.abs(report.index - expected.index))
  recordError('base_index', Math.abs(report.baseIndex - expected.base_index))
  recordError('hot_bonus', Math.abs(report.hotBonus - expected.hot_bonus))
  recordError('velocity_per_day', Math.abs(report.evidence.velocityPerDay - expected.velocity_per_day))
  recordError('relevance', Math.abs(report.evidence.relevance - expected.relevance))
  near(report.index, expected.index, 0.1, `${label}.index`)
  near(report.baseIndex, expected.base_index, 0.1, `${label}.base_index`)
  near(report.hotBonus, expected.hot_bonus, 0.01, `${label}.hot_bonus`)
  near(report.evidence.velocityPerDay, expected.velocity_per_day, 1e-3, `${label}.velocity_per_day`)
  near(report.evidence.relevance, expected.relevance, 1e-3, `${label}.relevance`)
  assert.equal(report.tier, expected.tier, `${label}.tier`)

  // 证据规模 / 分布（整数严格相等）
  assert.equal(report.evidence.sampleSize, expected.sample_size, `${label}.sample_size`)
  assert.equal(report.evidence.recentSize, expected.recent_size, `${label}.recent_size`)
  assert.equal(report.evidence.headSize, expected.head_size, `${label}.head_size`)
  assert.equal(report.evidence.numResults, expected.num_results, `${label}.num_results`)
  assert.equal(report.windowDays, expected.window_days, `${label}.window_days`)
  assert.equal(report.stockPages, expected.stock_pages, `${label}.stock_pages`)
  assert.equal(report.flowPages, expected.flow_pages, `${label}.flow_pages`)
  near(report.asOf / 1000, expected.as_of, 1e-6, `${label}.as_of`)
  const dist = report.distribution ?? {}
  if (expected.distribution && Object.keys(expected.distribution).length > 0) {
    assert.equal(dist.medianPlay, expected.distribution.median_play, `${label}.median_play`)
    assert.equal(dist.p90Play, expected.distribution.p90_play, `${label}.p90_play`)
    assert.equal(dist.authors, expected.distribution.authors, `${label}.authors`)
  } else {
    assert.deepEqual(dist, {}, `${label}.distribution 应为空对象`)
  }

  // 分量：按中文 name → 英文 id 映射后逐项比较
  assert.equal(report.components.length, expected.components.length, `${label}.components.length`)
  const byId = new Map(report.components.map((component) => [component.id, component]))
  for (const exp of expected.components) {
    const id = COMPONENT_NAME_TO_ID[exp.name]
    assert.ok(id, `${label}: 未知分量名 ${exp.name}`)
    const got = byId.get(id)
    assert.ok(got, `${label}: 缺少分量 ${id}`)
    recordError(`${id}.raw`, Math.abs(got.raw - exp.raw))
    recordError(`${id}.normalized`, Math.abs(got.normalized - exp.normalized))
    recordError(`${id}.points`, Math.abs(got.points - exp.points))
    near(got.raw, exp.raw, 0.01, `${label}.${id}.raw`)
    near(got.normalized, exp.normalized, 1e-6, `${label}.${id}.normalized`)
    near(got.points, exp.points, 0.01, `${label}.${id}.points`)
    near(got.weight, exp.weight, 1e-6, `${label}.${id}.weight`)
  }

  // 热搜：期望对象 / null
  if (expected.hot === null) {
    assert.equal(report.hot, null, `${label}.hot 应为 null`)
    assert.equal(report.evidence.hotRank, null, `${label}.hotRank 应为 null`)
  } else {
    assert.ok(report.hot, `${label}.hot 不应为 null`)
    assert.equal(report.hot.rank, expected.hot.rank, `${label}.hot.rank`)
    assert.equal(report.hot.keyword, expected.hot.keyword, `${label}.hot.keyword`)
    assert.equal(report.evidence.hotRank, expected.hot.rank, `${label}.hotRank`)
  }

  // 警告：demo 的 warning 顺序/文案是固定的，正常路径必须为空
  assert.deepEqual(report.warnings, expected.warnings, `${label}.warnings`)
  assertJsonSafe(report, label)
}

await check('python 对拍: golden-sample.json（index/base/hot/components/velocity/relevance）', () => {
  const report = scoreTopic(golden.sample, golden.hotItems, cfg)
  compareWithPython('golden', report, golden.expected)
})

for (const fixture of fixtures.fixtures) {
  await check(`python 对拍: fixture ${fixture.name}`, () => {
    const report = scoreTopic(fixture.sample, fixture.hotItems, cfg)
    compareWithPython(fixture.name, report, fixture.expected)
  })
}

await check('scoring: 4 模型 / consensus / heat 与主指数关系（所有 fixture）', () => {
  const samples = [
    ['golden', golden.sample, golden.hotItems],
    ...fixtures.fixtures.map((fixture) => [fixture.name, fixture.sample, fixture.hotItems]),
  ]
  for (const [label, sample, hotItems] of samples) {
    const report = scoreTopic(sample, hotItems, cfg)
    assert.equal(report.models.length, 4, `${label}.models.length`)
    assert.deepEqual(report.models.map((model) => model.id), MODEL_IDS, `${label}.models.ids`)
    for (const model of report.models) {
      assert.ok(Number.isFinite(model.index), `${label}.${model.id}.index 非有限`)
      assert.ok(model.index >= 0 && model.index <= 100, `${label}.${model.id}.index 越界`)
      assert.equal(model.tier, tierFor(model.index), `${label}.${model.id}.tier 与指数不一致`)
      assert.equal(typeof model.summary, 'string', `${label}.${model.id}.summary`)
      assert.ok(model.summary.length > 0, `${label}.${model.id}.summary 为空`)
    }
    // composite 模型分 === baseIndex（不含热搜加成）
    near(report.models[0].index, report.baseIndex, 1e-9, `${label}.composite===baseIndex`)
    const indexes = report.models.map((model) => model.index)
    const consensus = report.consensus
    near(consensus.mean, indexes.reduce((sum, value) => sum + value, 0) / 4, 1e-9, `${label}.consensus.mean`)
    near(consensus.min, Math.min(...indexes), 1e-9, `${label}.consensus.min`)
    near(consensus.max, Math.max(...indexes), 1e-9, `${label}.consensus.max`)
    near(consensus.spread, consensus.max - consensus.min, 1e-9, `${label}.consensus.spread`)
    const expectedAgreement = consensus.spread <= 10 ? '一致' : consensus.spread <= 20 ? '基本一致' : '分歧'
    assert.equal(consensus.agreement, expectedAgreement, `${label}.consensus.agreement`)
    // heat.index = clamp(baseIndex + hotBonus)
    near(report.index, clamp(report.baseIndex + report.hotBonus, 0, 100), 1e-9, `${label}.heat.index`)
    assert.equal(report.tier, tierFor(report.index), `${label}.heat.tier`)
  }
})

await check('scoring: 存在性门控（空样本 → index 0 / 凉 / demo 形状 components=[]，toToolValue 补齐 7+4）', () => {
  const fixture = fixtures.fixtures.find((item) => item.name === 'empty-sample')
  const report = scoreTopic(fixture.sample, fixture.hotItems, cfg)
  assert.equal(report.index, 0)
  assert.equal(report.baseIndex, 0)
  assert.equal(report.hotBonus, 0)
  assert.equal(report.tier, '凉')
  assert.equal(report.emptyGated, true)
  assert.deepEqual(report.components, [])
  assert.equal(report.warnings.length, 1)
  assert.match(report.warnings[0], /无相关内容/)

  const value = toToolValue(report, cfg)
  assert.equal(value.components.length, 7)
  assert.equal(value.models.length, 4)
  assert.deepEqual(value.components.map((item) => item.id), COMPONENT_IDS)
  assert.deepEqual(value.models.map((item) => item.id), MODEL_IDS)
  assert.equal(value.heat.index, 0)
  assert.equal(value.heat.tier, '凉')
  assert.deepEqual(value.topVideos, [])
  assert.equal(value.evidence.sampleSize, 0)
  assert.equal(value.evidence.hotRank, null)
  for (const component of value.components) {
    assert.equal(component.normalized, 0)
    assert.equal(component.points, 0)
  }
  for (const model of value.models) {
    assert.equal(model.index, 0)
    assert.equal(model.tier, '凉')
  }
  const text = renderReport(value, cfg)
  assert.match(text, /判定：该时间窗口内没有相关数据/)
  assert.match(text, /⚠ 警告/)
  assert.match(text, /数据：B站搜索采样/)
})

await check('scoring: 相关性 < 30% 时主指数与 4 个模型都 ×0.6；恰好 30% 不惩罚', () => {
  const fixture = fixtures.fixtures.find((item) => item.name === 'low-relevance')
  const penalized = scoreTopic(fixture.sample, fixture.hotItems, cfg)
  const unpenalized = scoreTopic(fixture.sample, fixture.hotItems, resolveConfig({ relevance: { penalty: 1 } }))
  assert.ok(penalized.evidence.relevance < 0.3)
  near(penalized.baseIndex, unpenalized.baseIndex * 0.6, 1e-6, 'low-relevance.baseIndex ×0.6')
  assert.match(penalized.warnings.join('\n'), /指数已乘 0\.6/)
  for (let index = 0; index < 4; index += 1) {
    near(
      penalized.models[index].index,
      unpenalized.models[index].index * 0.6,
      1e-6,
      `low-relevance.models[${MODEL_IDS[index]}] ×0.6`,
    )
  }

  // 构造 relevance 恰好 = 0.30 的样本：严格小于才惩罚
  const videos = Array.from({ length: 50 }, (_, index) => ({
    bvid: `BVREL${String(index).padStart(3, '0')}`,
    title: index < 15 ? `原神 视频 ${index}` : `无关内容 ${index}`,
    author: `UP${index}`,
    play: 10_000 - index,
    like: 100,
    favorite: 10,
    reply: 5,
    danmaku: 5,
    pubdate: 1_799_999_000 + index,
    duration_sec: 60,
    type_name: '手机游戏',
    tag: '',
  }))
  const sample = {
    keyword: '原神',
    num_results: 500,
    videos,
    recent: videos.slice(0, 10),
    window_days: 7,
    window_end: 1_800_000_000,
    stock_pages: 1,
    flow_pages: 1,
    fetched_at: 1_800_000_000,
  }
  const exactlyFloor = scoreTopic(sample, [], cfg)
  const exactlyFloorNoPenalty = scoreTopic(sample, [], resolveConfig({ relevance: { penalty: 1 } }))
  assert.equal(exactlyFloor.evidence.relevance, 0.3)
  near(exactlyFloor.baseIndex, exactlyFloorNoPenalty.baseIndex, 1e-9, 'relevance=0.30 不惩罚')
  assert.doesNotMatch(exactlyFloor.warnings.join('\n'), /相关性 30% < 30%/)
})

await check('scoring: numResults 触顶 1000 → 供给分量 1.0 + 触顶 warning', () => {
  const fixture = fixtures.fixtures.find((item) => item.name === 'numresults-capped')
  const report = scoreTopic(fixture.sample, fixture.hotItems, cfg)
  assert.equal(report.evidence.numResults, 1000)
  const supply = report.components.find((component) => component.id === 'supply')
  assert.equal(supply.normalized, 1)
  assert.match(report.warnings.join('\n'), /触顶/)
  const value = toToolValue(report, cfg)
  assert.equal(value.evidence.numResults, 1000)
  assert.equal(value.components.find((component) => component.id === 'supply').normalized, 1)

  // 全时段（window_days=0）文案不同，但同样触顶
  const allTime = fixtures.fixtures.find((item) => item.name === 'all-time-window')
  const allTimeReport = scoreTopic(allTime.sample, allTime.hotItems, cfg)
  assert.equal(allTimeReport.evidence.numResults, 1000)
  assert.match(allTimeReport.warnings.join('\n'), /全时段模式下命中数恒触顶/)
})

// --------------------------------------------------------------------------- //
// 5. toToolValue 结构 / JSON 安全 / 数组有界
// --------------------------------------------------------------------------- //

const goldenReport = scoreTopic(golden.sample, golden.hotItems, cfg)
const goldenValue = toToolValue(goldenReport, cfg)

await check('toToolValue: 顶层字段齐全（契约 §6），无 undefined/NaN/Infinity', () => {
  assert.deepEqual(Object.keys(goldenValue), [
    'topic',
    'window',
    'asOf',
    'heat',
    'models',
    'consensus',
    'components',
    'evidence',
    'topVideos',
    'warnings',
    'source',
  ])
  assertJsonSafe(goldenValue, 'toolValue')
  // JSON 序列化往返后完全一致（证明没有 undefined 丢字段 / NaN → null）
  const roundTrip = JSON.parse(JSON.stringify(goldenValue))
  assert.deepEqual(roundTrip, goldenValue)
  assert.equal(goldenValue.topic, '原神')
  assert.equal(goldenValue.window.preset, '7d')
  assert.equal(goldenValue.window.label, '近7天')
  assert.equal(goldenValue.window.days, 7)
  assert.ok(Number.isFinite(Date.parse(goldenValue.window.start)), 'window.start 应是合法 ISO')
  assert.ok(Number.isFinite(Date.parse(goldenValue.window.end)), 'window.end 应是合法 ISO')
  assert.equal(Date.parse(goldenValue.window.end) - Date.parse(goldenValue.window.start), 7 * 86400 * 1000)
  assert.ok(Number.isFinite(Date.parse(goldenValue.asOf)), 'asOf 应是合法 ISO')
  assert.equal(goldenValue.source.engine, 'bilibili-search')
  assert.equal(goldenValue.source.cached, false)
  assert.equal(goldenValue.source.requests, 0)
  assert.equal(goldenValue.source.fetchedAt, goldenValue.asOf)
})

await check('toToolValue: heat/models/consensus/components/evidence/topVideos/source 形状与取值', () => {
  const value = goldenValue
  assert.deepEqual(Object.keys(value.heat), ['index', 'tier', 'baseIndex', 'hotBonus'])
  assert.ok(value.heat.index >= 0 && value.heat.index <= 100)
  assert.equal(value.heat.tier, '爆')
  near(value.heat.index, 77.56, 0.1, 'golden heat.index')
  near(value.heat.baseIndex, 69.88, 0.1, 'golden heat.baseIndex')
  near(value.heat.hotBonus, 7.68, 0.01, 'golden heat.hotBonus')

  assert.equal(value.models.length, 4)
  assert.deepEqual(value.models.map((model) => model.id), MODEL_IDS)
  for (const model of value.models) {
    assert.deepEqual(Object.keys(model), ['id', 'name', 'index', 'tier', 'summary'])
    assert.ok(model.index >= 0 && model.index <= 100)
    assert.equal(typeof model.summary, 'string')
  }

  assert.deepEqual(Object.keys(value.consensus), ['mean', 'min', 'max', 'spread', 'agreement'])
  assert.ok(['一致', '基本一致', '分歧'].includes(value.consensus.agreement))
  near(value.consensus.spread, value.consensus.max - value.consensus.min, 0.011, 'consensus.spread')

  assert.equal(value.components.length, 7)
  assert.deepEqual(value.components.map((component) => component.id), COMPONENT_IDS)
  for (const component of value.components) {
    assert.deepEqual(Object.keys(component), ['id', 'name', 'raw', 'normalized', 'weight', 'points'])
    assert.ok(component.normalized >= 0 && component.normalized <= 1)
    near(component.points, component.normalized * component.weight * 100, 0.3, `${component.id}.points 与 normalized*weight*100`)
  }

  assert.deepEqual(Object.keys(value.evidence), [
    'sampleSize',
    'recentSize',
    'headSize',
    'numResults',
    'velocityPerDay',
    'relevance',
    'hotRank',
    'hotBonus',
    'medianPlay',
    'p90Play',
    'authors',
  ])
  for (const key of ['sampleSize', 'recentSize', 'headSize', 'numResults', 'medianPlay', 'p90Play', 'authors']) {
    assert.ok(Number.isInteger(value.evidence[key]), `evidence.${key} 应为整数`)
    assert.ok(value.evidence[key] >= 0)
  }
  assert.equal(value.evidence.hotRank, 3)
  assert.ok(value.evidence.relevance >= 0 && value.evidence.relevance <= 1)

  assert.ok(value.topVideos.length >= 1 && value.topVideos.length <= 5)
  for (const video of value.topVideos) {
    assert.deepEqual(Object.keys(video), ['title', 'author', 'play', 'like', 'pubdate', 'url'])
    assert.equal(typeof video.title, 'string')
    assert.equal(typeof video.author, 'string')
    assert.ok(Number.isInteger(video.play) && video.play >= 0)
    assert.ok(Number.isInteger(video.like) && video.like >= 0)
    assert.ok(Number.isInteger(video.pubdate) && video.pubdate >= 0)
    assert.match(video.url, /^https:\/\/www\.bilibili\.com\/video\/BV/)
  }

  assert.deepEqual(Object.keys(value.source), ['engine', 'fetchedAt', 'cached', 'requests'])
  assert.equal(typeof value.source.cached, 'boolean')
  assert.ok(Number.isInteger(value.source.requests) && value.source.requests >= 0)
})

await check('toToolValue: output.topVideos / output.maxWarnings 截断生效', () => {
  const report = structuredClone(goldenReport)
  report.topVideos = goldenReport.topVideos.concat(goldenReport.topVideos) // 10 条
  report.warnings = Array.from({ length: 10 }, (_, index) => `warning-${index}`)
  const limitedCfg = resolveConfig({ output: { topVideos: 2, maxWarnings: 3 } })
  const value = toToolValue(report, limitedCfg)
  assert.equal(value.topVideos.length, 2)
  assert.equal(value.warnings.length, 3)
  assert.deepEqual(value.warnings, ['warning-0', 'warning-1', 'warning-2'])
})

await check('toToolValue: 90 天窗口 label 为「近90天」、days=90、时间跨度=90 天', () => {
  const report = structuredClone(goldenReport)
  report.windowDays = 90
  report.windowPreset = '90'
  const value = toToolValue(report, cfg)
  assert.equal(value.window.preset, '90')
  assert.equal(value.window.days, 90)
  assert.equal(value.window.label, '近90天')
  assert.equal(Date.parse(value.window.end) - Date.parse(value.window.start), 90 * 86400 * 1000)
})

// --------------------------------------------------------------------------- //
// 6. output.schema 与 toToolValue 实际结构一致
// --------------------------------------------------------------------------- //

function validateAgainstSchema(schema, value, at = '$') {
  if (!schema || typeof schema !== 'object') return
  if (Array.isArray(schema.oneOf)) {
    const errors = []
    for (const candidate of schema.oneOf) {
      try {
        validateAgainstSchema(candidate, value, at)
        return
      } catch (error) {
        errors.push(error.message)
      }
    }
    throw new Error(`${at}: 不满足 oneOf（${errors.join(' | ')}），实际 ${JSON.stringify(value)}`)
  }
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${at}: 期望 object`)
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${at}: 缺少必填字段 ${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${at}: 多出 schema 未声明的字段 ${key}`)
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateAgainstSchema(subSchema, value[key], `${at}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${at}: 期望 array`)
    if (schema.items) value.forEach((item, index) => validateAgainstSchema(schema.items, item, `${at}[${index}]`))
    return
  }
  if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${at}: 期望 string，实际 ${JSON.stringify(value)}`)
    return
  }
  if (schema.type === 'number') {
    assert.equal(typeof value, 'number', `${at}: 期望 number`)
    assert.ok(Number.isFinite(value), `${at}: 期望有限 number`)
    return
  }
  if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), `${at}: 期望 integer，实际 ${JSON.stringify(value)}`)
    return
  }
  if (schema.type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${at}: 期望 boolean`)
  }
}

await check('output.schema: 每个 object 都 additionalProperties=false、required 完整，value 通过校验', () => {
  const definition = buildToolDefinition(cfg)
  const schema = definition.output.schema
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
  validateAgainstSchema(schema, goldenValue, 'toolValue')
  // 全部 fixture（含空样本、相关性惩罚、触顶、全时段）的 value 都必须通过 schema
  for (const fixture of fixtures.fixtures) {
    const report = scoreTopic(fixture.sample, fixture.hotItems, cfg)
    validateAgainstSchema(schema, toToolValue(report, cfg), `toolValue:${fixture.name}`)
  }
  // schema 里声明的 components/models 数组项结构必须覆盖 4 个模型 / 7 个分量的 required 字段
  assert.deepEqual(schema.properties.models.items.required.sort(), ['id', 'index', 'name', 'summary', 'tier'].sort())
  assert.deepEqual(
    schema.properties.components.items.required.sort(),
    ['id', 'name', 'normalized', 'points', 'raw', 'weight'].sort(),
  )
})

// --------------------------------------------------------------------------- //
// 7. renderReport：关键行、长度、无 undefined
// --------------------------------------------------------------------------- //

await check('renderReport: 含多模型/分量/证据/代表视频/警告/数据来源行，长度 < 2000 字', () => {
  const text = renderReport(goldenValue, cfg)
  for (const required of ['多模型：', '分量（归一化）：', '证据：', '代表视频：', '⚠ 警告：', '数据：B站搜索采样']) {
    assert.ok(text.includes(required), `renderReport 缺少关键行「${required}」`)
  }
  assert.match(text, /综合热度 77\.6\/100（爆）/)
  assert.match(text, /热搜 第3位/)
  assert.ok(text.length < 2000, `renderReport 过长：${text.length} 字`)
  assert.ok(!text.includes('undefined'), 'renderReport 出现 undefined')
  assert.doesNotMatch(text, /NaN|Infinity/, 'renderReport 出现 NaN/Infinity')
  // 同时接受 scoreTopic 原始报告（内部会先 toToolValue）
  assert.equal(renderReport(goldenReport, cfg), text)
})

await check('renderReport: 90 天窗口文本显示「近90天」', () => {
  const report = structuredClone(goldenReport)
  report.windowDays = 90
  report.windowPreset = '90'
  const text = renderReport(toToolValue(report, cfg), cfg)
  assert.match(text, /近90天/)
})

await check('renderReport: 存在性门控时也给出判定/警告/数据来源说明', () => {
  const emptyFixture = fixtures.fixtures.find((item) => item.name === 'empty-sample')
  const text = renderReport(toToolValue(scoreTopic(emptyFixture.sample, emptyFixture.hotItems, cfg), cfg), cfg)
  assert.match(text, /判定：该时间窗口内没有相关数据/)
  assert.match(text, /⚠ 警告（\d+ 条）：/)
  assert.match(text, /数据：B站搜索采样/)
  assert.match(text, /（无可用样本）/)
  assert.ok(!text.includes('undefined'))
})

// --------------------------------------------------------------------------- //
// 8. 工具定义 / 参数 / apply 注册 / execute 参数校验（离线）
// --------------------------------------------------------------------------- //

await check('index: 导出 name/inject/apply/buildToolDefinition，apply 注册并返回 disposer', () => {
  assert.equal(name, 'bilibili-topic-heat')
  assert.deepEqual(inject, ['tools'])
  let captured = null
  const disposer = apply(
    {
      tools: {
        register(definition) {
          captured = definition
          return () => {
            captured = null
          }
        },
      },
    },
    {},
  )
  assert.equal(typeof disposer, 'function')
  assert.ok(captured, 'apply 必须调用 ctx.tools.register')
  assert.equal(captured.name, 'bili_topic_heat')
  assert.equal(captured.timeoutMs, 90000)
  disposer()
  assert.equal(captured, null)
})

await check('index: 工具参数只有 topic/window，window.enum 来自 config.windows', () => {
  const definition = buildToolDefinition(cfg)
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(definition.parameters.properties), ['topic', 'window'])
  assert.deepEqual(definition.parameters.required, ['topic'])
  assert.equal(definition.parameters.properties.topic.type, 'string')
  assert.equal(definition.parameters.properties.window.type, 'string')
  assert.deepEqual(definition.parameters.properties.window.enum, ['1d', '7d', '1m', '90'])
  assert.equal(definition.parameters.properties.window.default, '7d')
  for (const key of ['1d', '7d', '1m', '90']) {
    assert.ok(definition.parameters.properties.window.description.includes(key))
  }
  // 自定义 windows 应同步到参数 enum（键顺序先契约顺序）
  const custom = buildToolDefinition(resolveConfig({ windows: { '3d': 3 }, defaults: { window: '3d' } }))
  assert.deepEqual(custom.parameters.properties.window.enum, ['1d', '7d', '1m', '90', '3d'])
  assert.equal(custom.parameters.properties.window.default, '3d')
})

await check('index.execute: 非法 topic/window 在联网前抛中文 Error', async () => {
  const definition = buildToolDefinition(cfg)
  await assert.rejects(() => definition.execute({}, {}), /topic 不能为空/)
  await assert.rejects(() => definition.execute({ topic: '   ' }, {}), /topic 不能为空/)
  await assert.rejects(() => definition.execute({ topic: 'x'.repeat(81) }, {}), /topic 过长/)
  await assert.rejects(() => definition.execute({ topic: '原神', window: '9d' }, {}), /window 不合法/)
  await assert.rejects(() => definition.execute({ topic: '原神', window: 7 }, {}), /window 不合法/)
  await assert.rejects(() => definition.execute({ topic: '原神', window: 'all' }, {}), /window 不合法/)
})

// --------------------------------------------------------------------------- //
// 9. 打包层一致性：package.json / cordis.patch.yml / locale / README
// --------------------------------------------------------------------------- //

/**
 * 极简 YAML 子集解析器：只支持本仓库 cordis.patch.yml 用到的语法
 * （缩进 mapping / `- ` 序列 / 引号字符串 / 数字 / true/false / 整行注释）。
 */
function parsePatchYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  const indentOf = (line) => line.match(/^ */)[0].length
  const skip = () => {
    while (index < lines.length) {
      const trimmed = lines[index].trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        index += 1
        continue
      }
      break
    }
  }
  const splitKeyValue = (raw) => {
    const match = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(raw)
    if (!match) return null
    return { key: unquote(match[1].trim()), value: (match[2] ?? '').trim() }
  }
  const unquote = (raw) => {
    if (raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw)
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
    return raw
  }
  const parseScalar = (raw) => {
    const value = stripComment(raw).trim()
    if (value === '') return null
    if (value === 'true') return true
    if (value === 'false') return false
    if (value === 'null' || value === '~') return null
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
    return unquote(value)
  }
  const stripComment = (raw) => {
    let quote = null
    for (let position = 0; position < raw.length; position += 1) {
      const char = raw[position]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '#' && (position === 0 || raw[position - 1] === ' ')) {
        return raw.slice(0, position)
      }
    }
    return raw
  }

  function parsePair(target, raw, keyIndent) {
    const pair = splitKeyValue(raw)
    if (!pair) throw new Error(`YAML 无法解析键值：${raw}`)
    if (pair.value !== '') {
      target[pair.key] = parseScalar(pair.value)
      return
    }
    skip()
    if (index < lines.length) {
      const nextIndent = indentOf(lines[index])
      const nextText = lines[index].trim()
      if (nextIndent > keyIndent || (nextIndent === keyIndent && nextText.startsWith('- '))) {
        target[pair.key] = parseBlock(nextIndent)
        return
      }
    }
    target[pair.key] = null
  }

  function parseMap(indent, seed) {
    const object = {}
    if (seed) parsePair(object, seed, indent)
    for (;;) {
      skip()
      if (index >= lines.length) break
      const current = indentOf(lines[index])
      if (current < indent) break
      if (current > indent) throw new Error(`YAML 缩进异常 @${index + 1}`)
      const raw = lines[index].trim()
      if (raw.startsWith('- ')) break
      index += 1
      parsePair(object, raw, indent)
    }
    return object
  }

  function parseSequence(indent) {
    const array = []
    for (;;) {
      skip()
      if (index >= lines.length) break
      const current = indentOf(lines[index])
      if (current < indent) break
      const raw = lines[index].trim()
      if (current !== indent || !raw.startsWith('- ')) break
      const rest = raw.slice(1).trim()
      index += 1
      if (rest === '') {
        array.push(parseBlock(indent + 1))
      } else if (splitKeyValue(rest)) {
        array.push(parseMap(indent + 2, rest))
      } else {
        array.push(parseScalar(rest))
      }
    }
    return array
  }

  function parseBlock(minIndent) {
    skip()
    if (index >= lines.length) return null
    const indent = indentOf(lines[index])
    if (indent < minIndent) return null
    const raw = lines[index].trim()
    if (raw.startsWith('- ')) return parseSequence(indent)
    return parseMap(indent, null)
  }

  const result = parseBlock(0)
  skip()
  assert.equal(index, lines.length, 'cordis.patch.yml 存在未解析的尾部内容')
  return result
}

const patchRoot = parsePatchYaml(fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8'))
const patchEntries = Array.isArray(patchRoot) ? patchRoot : [patchRoot]
const patch = patchEntries.find((entry) => entry?.insert)
// 顶层只允许 insert 条目：bundle 故意不覆盖 system-prompt 的 persona
// （Web preset 的 dsh-persona 会在 agent 作用域遮蔽部署级 persona）。
assert.equal(
  patchEntries.filter((entry) => !entry?.insert).length,
  0,
  'bundle 不应包含按 id 覆盖条目（persona 归 preset 管）',
)
const patchRows = Object.fromEntries(patch.insert.map((row) => [row.id, row]))
const patchConfig = patchRows['bilibili-topic-heat'].config
const packageJson = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'package.json'), 'utf8'))

function flattenLeaves(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(value)) out[full] = JSON.stringify(value)
    else if (value && typeof value === 'object') flattenLeaves(value, full, out)
    else out[full] = value
  }
  return out
}

await check('cordis.patch.yml: insert 行 id/name 正确，config 与 DEFAULT_CONFIG 逐字段一致', () => {
  assert.ok(Array.isArray(patch.insert), 'patch 顶层应为 insert 列表')
  assert.deepEqual(
    Object.keys(patchRows).sort(),
    ['bilibili-progress-nudge', 'bilibili-topic-heat', 'bilibili-topic-heat-guidance'].sort(),
  )
  assert.equal(patchRows['bilibili-topic-heat'].name, 'dsh-bilibili-bundle/plugins/topic-heat')
  assert.equal(patchRows['bilibili-progress-nudge'].name, 'dsh-bilibili-bundle/plugins/progress-nudge')
  assert.equal(
    patchRows['bilibili-topic-heat-guidance'].name,
    'dsh-bilibili-bundle/plugins/topic-heat-guidance',
  )
  const patchLeaves = flattenLeaves(patchConfig)
  // 默认值全集 = 插件私有 DEFAULT_CONFIG + 共享层 request/sampling
  const defaultLeaves = flattenLeaves(DEFAULT_CONFIG)
  Object.assign(defaultLeaves, flattenLeaves({ request: DEFAULT_REQUEST_CONFIG, sampling: DEFAULT_SAMPLING_CONFIG }))
  assert.deepEqual(Object.keys(patchLeaves).sort(), Object.keys(defaultLeaves).sort(), 'patch config 键集合应与 DEFAULT_CONFIG 一致')
  for (const key of Object.keys(defaultLeaves)) {
    assert.deepEqual(patchLeaves[key], defaultLeaves[key], `patch config ${key} 与 lib 默认值不一致`)
  }
  // 注：JS 对象会把整数型键（"90"）提前，键顺序以 windowKeysFor 的契约顺序为准
  assert.deepEqual(Object.keys(patchConfig.windows).sort(), ['1d', '7d', '1m', '90'].sort())
  assert.deepEqual(Object.keys(patchConfig.modelWeights), MODEL_IDS)
})

await check('cordis.patch.yml: 两个提示词插件行与 lib 一致，且不含 persona 覆盖', () => {
  // persona 已由 bundle 层撤回：Web preset 的 dsh-persona 在 agent 作用域
  // 注册同名 deployment:persona-prefix 段并遮蔽部署级 persona，部署层配置
  // 在 preset 会话里不渲染（DSH 设计行为）。要改 persona 请走 preset 编辑器
  // 或 profile 层覆盖 preset-standard 行内 persona 插件配置。

  // progress-nudge 行：config 与插件 resolveConfig 兜底结果一致
  assert.equal(nudgeName, 'bilibili-progress-nudge')
  assert.ok(Array.isArray(nudgeInject))
  const nudgeConfig = patchRows['bilibili-progress-nudge'].config
  assert.deepEqual(resolveNudgeConfig(nudgeConfig), {
    everySteps: nudgeConfig.everySteps,
    text: nudgeConfig.text,
  })
  assert.equal(resolveNudgeConfig(undefined).everySteps, NUDGE_DEFAULTS.everySteps)
  assert.equal(resolveNudgeConfig({ everySteps: 0 }).everySteps, NUDGE_DEFAULTS.everySteps)
  assert.equal(resolveNudgeConfig({ everySteps: 'x' }).everySteps, NUDGE_DEFAULTS.everySteps)
  assert.equal(resolveNudgeConfig({ everySteps: 3 }).everySteps, 3)
  assert.equal(resolveNudgeConfig({ text: '' }).text, NUDGE_DEFAULTS.text)

  // guidance 行：无 config；常量与 lib 导出一致
  assert.equal(guidanceName, 'bilibili-topic-heat-guidance')
  assert.ok(Array.isArray(guidanceInject) && guidanceInject.includes('systemPrompt'))
  assert.equal(patchRows['bilibili-topic-heat-guidance'].config, undefined)
  assert.equal(TOOL_NAME, 'bili_topic_heat')
  assert.equal(SECTION_ORDER > 2400 && SECTION_ORDER < 2600, true)
})

await check('progress-nudge: shouldNudge 边界与快照消息形状', () => {
  assert.equal(shouldNudge(5, 5), true)
  assert.equal(shouldNudge(10, 5), true)
  assert.equal(shouldNudge(4, 5), false)
  assert.equal(shouldNudge(6, 5), false)
  assert.equal(shouldNudge(0, 5), false)
  assert.equal(shouldNudge(-5, 5), false)
  assert.equal(shouldNudge(2.5, 5), false)
})

await check('topic-heat-guidance: apply 的 waterfall 写法符合 Cordis 语义', async () => {
  // 回归测试：Cordis waterfall 的 next() 不传递参数（next(x) 的 x 被忽略，
  // 最内层 fallback 返回原始 assembly）。正确模式是 await next() 后自己
  // return 修改值。这里用「忽略参数的 fake next」模拟真实语义。
  const { apply: applyGuidance } = await import('../lib/plugins/topic-heat-guidance/index.js')
  let listener
  const fakeCtx = { on: (name, fn) => { listener = fn; return () => {} } }
  applyGuidance(fakeCtx)
  const original = {
    sections: [{ name: 'deployment:persona-prefix', order: 0, text: 'x' }],
    tools: [{ name: 'bili_topic_heat' }],
  }
  // 真实 Cordis 语义：next 忽略入参，返回内层结果（此处即原始 assembly）
  const result = await listener(original, {}, async () => original)
  assert.equal(result.sections.length, 2, '引导段应被追加到 waterfall 结果上')
  assert.equal(result.sections[1].name, SECTION_NAME)
  // 工具缺席时原样透传
  const passthrough = await listener(
    { sections: [], tools: [] },
    {},
    async () => ({ sections: [], tools: [] }),
  )
  assert.equal(passthrough.sections.length, 0)
})

await check('topic-heat-guidance: withGuidanceSection 严格满足 if-and-only-if', () => {
  const base = { sections: [{ name: 'deployment:persona-prefix', order: 0, text: 'x' }], tools: [] }
  // 工具不在 schema → 原样返回（同一引用）
  assert.equal(withGuidanceSection(base), base)
  // 工具在 schema → 追加引导段
  const hit = withGuidanceSection({
    ...base,
    tools: [{ name: 'bili_topic_heat', description: 'd', parameters: {} }],
  })
  assert.equal(hit.sections.length, 2)
  assert.deepEqual(hit.sections[1], {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: GUIDANCE_TEXT,
  })
  assert.ok(GUIDANCE_TEXT.includes('bili_topic_heat'))
  assert.ok(GUIDANCE_TEXT.includes('ONLY'))
  // 工具被过滤后名称不符 → 不追加
  const miss = withGuidanceSection({ ...base, tools: [{ name: 'other_tool' }] })
  assert.equal(miss.sections.length, 1)
})

await check('package.json: 元数据 / 入口 / files / dsh.bundle.patch 符合契约，且无依赖', () => {
  assert.equal(packageJson.name, 'dsh-bilibili-bundle')
  assert.equal(packageJson.version, '0.2.0')
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.license, 'MIT')
  assert.equal(packageJson.main, undefined)
  assert.equal(packageJson.exports['./plugins/*'], './lib/plugins/*/index.js')
  assert.equal(packageJson.exports['./plugins/*/locale/*.json'], './locale/*/*.json')
  assert.equal(packageJson.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(packageJson.exports['./package.json'], './package.json')
  assert.equal(packageJson.exports['./icon'], './icon.svg')
  assert.deepEqual(packageJson.dsh, { bundle: { patch: './cordis.patch.yml' } })
  const files = packageJson.files ?? []
  for (const required of ['lib', 'cordis.patch.yml', 'locale/*/*.json', 'icon.svg', 'README.md']) {
    assert.ok(files.includes(required), `package.json files 缺少 ${required}`)
  }
  assert.equal(packageJson.dependencies, undefined, '不应声明 dependencies（零第三方依赖）')
  assert.equal(packageJson.devDependencies, undefined)
  assert.ok(fs.existsSync(path.join(BUNDLE, 'lib/plugins/topic-heat/index.js')))
  assert.ok(fs.readFileSync(path.join(BUNDLE, 'icon.svg'), 'utf8').trimStart().startsWith('<svg'))
  assert.ok(fs.statSync(path.join(BUNDLE, 'icon.svg')).size <= 256 * 1024)
})

await check('locale: en/zh 都有 meta.title/description，且覆盖 4 个窗口键', () => {
  for (const locale of ['en', 'zh']) {
    const data = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'locale', 'topic-heat', `${locale}.json`), 'utf8'))
    assert.equal(typeof data.meta?.title, 'string', `${locale}.meta.title`)
    assert.equal(typeof data.meta?.description, 'string', `${locale}.meta.description`)
    assert.ok(data.meta.title.length > 0)
    assert.ok(data.meta.description.length > 0)
    for (const key of ['1d', '7d', '1m', '90']) {
      assert.ok(data.meta.description.includes(key), `${locale} 描述缺少窗口 ${key}`)
    }
  }
})

await check('tool enum / patch windows / lib 默认 config 三者一致', () => {
  const definition = buildToolDefinition(resolveConfig(patchConfig))
  // enum 的顺序由 windowKeysFor 保证（契约顺序），与 YAML/对象字面量的书写顺序无关
  const patchWindows = windowKeysFor({ windows: patchConfig.windows })
  const libWindows = windowKeysFor(DEFAULT_CONFIG)
  assert.deepEqual(patchWindows, ['1d', '7d', '1m', '90'])
  assert.deepEqual(definition.parameters.properties.window.enum, patchWindows)
  assert.deepEqual(libWindows, patchWindows)
  assert.deepEqual(Object.keys(patchConfig.windows).sort(), libWindows.slice().sort())
  assert.equal(definition.parameters.properties.window.default, patchConfig.defaults.window)
  assert.equal(patchConfig.defaults.window, DEFAULT_CONFIG.defaults.window)
})

await check('README: 工具名、两个参数、config 分组与关键字段都有文档', () => {
  const readme = fs.readFileSync(path.join(BUNDLE, 'README.md'), 'utf8')
  assert.ok(readme.includes('bili_topic_heat'))
  assert.ok(readme.includes('topic') && readme.includes('window'))
  for (const key of [
    'defaults.window',
    'windows',
    'sampling.pageSize',
    'sampling.stockPages',
    'sampling.flowPages',
    'sampling.headSize',
    'sampling.minSample',
    'request.intervalMs',
    'request.timeoutMs',
    'request.maxRetries',
    'request.maxRequests',
    'request.cacheTtlSeconds',
    'request.cacheDir',
    'request.userAgent',
    'anchors.playLogFloor',
    'anchors.playLogCeil',
    'modelWeights',
    'engagementWeights',
    'relevance.floor',
    'relevance.penalty',
    'hotBonusMax',
    'tiers',
    'output.topVideos',
    'output.maxWarnings',
  ]) {
    assert.ok(readme.includes(key), `README 缺少配置字段 ${key}`)
  }
})

// --------------------------------------------------------------------------- //
// 10. signals.js 离线解析 / 去重 / 双采样（fake client，不联网）
// --------------------------------------------------------------------------- //

await check('signals: HTML 实体与标题清洗（先去 em 标签、后 unescape）', () => {
  assert.equal(cleanTitle('<em class="keyword">原神</em>攻略'), '原神攻略')
  assert.equal(cleanTitle('原神 &quot;神女劈观&quot; 二创'), '原神 "神女劈观" 二创')
  assert.equal(htmlUnescape('&amp;&lt;&gt;&quot;&#39;&#x27;&nbsp;'), '&<>"\'\'\u00a0')
  assert.equal(htmlUnescape('&unknown; &amp'), '&unknown; &amp')
  assert.equal(cleanTitle(undefined), '')
  assert.equal(cleanTitle('<em class="keyword">标题</em> &amp; 更多'), '标题 & 更多')
})

await check('signals: parseDuration / parseVideo 字段映射（favorites→favorite 等）', () => {
  assert.equal(parseDuration('6:43'), 403)
  assert.equal(parseDuration('1:02:03'), 3723)
  assert.equal(parseDuration('abc'), 0)
  assert.equal(parseDuration(90), 90)
  assert.equal(parseDuration(''), 0)

  const video = parseVideo({
    bvid: 'BV1TEST',
    title: '<em class="keyword">原神</em>&quot;攻略&quot;',
    author: 'UP主',
    play: '1234',
    like: '10',
    favorites: '5',
    review: '2',
    video_review: '7',
    pubdate: '1799999000',
    duration: '1:02:03',
    typename: '动画',
    tag: '原神&amp;游戏',
  })
  assert.equal(video.bvid, 'BV1TEST')
  assert.equal(video.title, '原神"攻略"')
  assert.equal(video.play, 1234)
  assert.equal(video.like, 10)
  assert.equal(video.favorite, 5)
  assert.equal(video.reply, 2)
  assert.equal(video.danmaku, 7)
  assert.equal(video.pubdate, 1799999000)
  assert.equal(video.duration_sec, 3723)
  assert.equal(video.type_name, '动画')
  assert.equal(video.tag, '原神&游戏')
  assert.equal(parseVideo(null).play, 0)
})

await check('signals: mergeVideos 按 bvid 去重，空 bvid 回退 title|pubdate', () => {
  const merged = mergeVideos([
    [
      { bvid: 'A', title: 'a', pubdate: 1 },
      { bvid: 'B', title: 'b', pubdate: 2 },
    ],
    [
      { bvid: 'B', title: 'b', pubdate: 2 },
      { bvid: 'C', title: 'c', pubdate: 3 },
      { bvid: '', title: 'dup', pubdate: 4 },
      { bvid: '', title: 'dup', pubdate: 4 },
    ],
  ])
  assert.deepEqual(merged.map((video) => video.bvid), ['A', 'B', 'C', ''])
  assert.equal(merged.length, 4)
})

await check('signals: parseSearchPayload 缺字段兜底 + 数字字符串转整数', () => {
  const parsed = parseSearchPayload({ code: 0, data: { numResults: '42', result: [{ bvid: 'BV1' }, { bvid: 'BV2' }, null] } })
  assert.equal(parsed.numResults, 42)
  assert.equal(parsed.videos.length, 2)
  assert.deepEqual(parseSearchPayload(null), { numResults: 0, videos: [] })
  assert.deepEqual(parseSearchPayload({ code: 0, data: { result: 'x' } }), { numResults: 0, videos: [] })
})

await check('signals: buildSearchParams 显式 order / page_size / 时间过滤', () => {
  const params = buildSearchParams('原神', 'click', cfg, 1, { begin: 1_799_000_000, end: 1_799_900_000 })
  assert.equal(params.search_type, 'video')
  assert.equal(params.keyword, '原神')
  assert.equal(params.page, 1)
  assert.equal(params.page_size, 50)
  assert.equal(params.order, 'click')
  assert.equal(params.pubtime_begin_s, 1_799_000_000)
  assert.equal(params.pubtime_end_s, 1_799_900_000)
  assert.equal(params.w_rid, undefined) // 普通接口不带签名参数
  const allTime = buildSearchParams('原神', 'pubdate', cfg, 2, { begin: 0, end: 0 })
  assert.equal(allTime.order, 'pubdate')
  assert.equal('pubtime_begin_s' in allTime, false)
  assert.equal('pubtime_end_s' in allTime, false)
  const preConverted = buildSearchParams('原神', 'click', cfg, 3, { pubtime_begin_s: 11, pubtime_end_s: 22 })
  assert.equal(preConverted.pubtime_begin_s, 11)
  assert.equal(preConverted.pubtime_end_s, 22)
})

function rawVideo(index, overrides = {}) {
  return {
    bvid: `BVFAKE${String(index).padStart(4, '0')}`,
    title: `原神 测试视频 ${index}`,
    author: `UP${index}`,
    play: 1000 + index,
    like: 10 + index,
    favorites: 1,
    review: 1,
    danmaku: 1,
    pubdate: 1_799_999_000 + index,
    duration: '1:02',
    typename: '手机游戏',
    tag: '原神',
    ...overrides,
  }
}

function makeFakeClient(handler) {
  return {
    calls: [],
    lastFetchedAt: 1_800_000_000_000,
    async getJson(requestPath, params = {}, options = {}) {
      this.calls.push({ path: requestPath, params: { ...params }, options })
      return handler(requestPath, params, this.calls.length)
    },
  }
}

const searchPayload = (numResults, videos) => ({ code: 0, data: { numResults, result: videos } })

await check('signals: fetchTopicSample 双采样复用同一组 900s 量化端点 + 按页去重', async () => {
  const stockPages = [
    Array.from({ length: 50 }, (_, index) => rawVideo(index)), // 0-49
    Array.from({ length: 50 }, (_, index) => rawVideo(index + 40)), // 40-89，其中 40-49 重复
    Array.from({ length: 10 }, (_, index) => rawVideo(index + 85)), // 85-94，其中 85-89 重复
  ]
  const flowPages = [Array.from({ length: 50 }, (_, index) => rawVideo(index)), []]
  const client = makeFakeClient((requestPath, params) => {
    if (requestPath !== SEARCH_TYPE_PATH) throw new Error(`意外请求 ${requestPath}`)
    return params.order === 'click'
      ? searchPayload(120, stockPages[params.page - 1] ?? [])
      : searchPayload(999, flowPages[params.page - 1] ?? [])
  })
  const sample = await fetchTopicSample(client, '原神', cfg, { windowDays: 7, windowPreset: '7d' })

  assert.equal(sample.keyword, '原神')
  assert.equal(sample.numResults, 120) // 只采用 stock 第 1 页的 numResults
  assert.equal(sample.videos.length, 95) // 50 + 40 + 5，跨页按 bvid 去重
  assert.equal(new Set(sample.videos.map((video) => video.bvid)).size, 95)
  assert.equal(sample.recent.length, 50)
  assert.equal(sample.stockPages, 3)
  assert.equal(sample.flowPages, 1)
  assert.equal(sample.windowPreset, '7d')
  assert.equal(sample.windowDays, 7)
  assert.ok(sample.windowEnd > 0 && sample.windowStart > 0)
  assert.equal(sample.windowEnd - sample.windowStart, 7 * 86400 * 1000)
  assert.equal(sample.windowEnd % (WINDOW_BUCKET_SECONDS * 1000), 0)
  assert.equal(sample.fetchedAt, 1_800_000_000_000)

  const stockCalls = client.calls.filter((call) => call.params.order === 'click')
  const flowCalls = client.calls.filter((call) => call.params.order === 'pubdate')
  assert.equal(stockCalls.length, 3)
  assert.equal(flowCalls.length, 2) // 第 2 页空页 → 终止
  const endpoints = new Set(
    [...stockCalls, ...flowCalls].map((call) => `${call.params.pubtime_begin_s}:${call.params.pubtime_end_s}`),
  )
  assert.equal(endpoints.size, 1, '存量/增量两次采样必须复用同一组窗口端点')
  for (const call of [...stockCalls, ...flowCalls]) {
    assert.equal(call.params.page_size, 50)
    assert.equal(call.params.search_type, 'video')
    assert.equal(call.params.keyword, '原神')
    assert.equal(call.params.pubtime_end_s % WINDOW_BUCKET_SECONDS, 0)
    assert.equal(call.params.pubtime_begin_s, call.params.pubtime_end_s - 7 * 86400)
  }
  // 视频按页顺序合并
  assert.equal(sample.videos[0].bvid, 'BVFAKE0000')
  assert.equal(sample.videos.at(-1).bvid, 'BVFAKE0094')
})

await check('signals: fetchTopicSample numResults=0 时不再请求增量采样', async () => {
  const client = makeFakeClient((requestPath, params) => {
    assert.equal(requestPath, SEARCH_TYPE_PATH)
    assert.equal(params.order, 'click')
    return searchPayload(0, [])
  })
  const sample = await fetchTopicSample(client, '不存在的话题', cfg, { windowDays: 7 })
  assert.equal(sample.numResults, 0)
  assert.deepEqual(sample.videos, [])
  assert.deepEqual(sample.recent, [])
  assert.equal(client.calls.length, 1)
  assert.equal(sample.stockPages, 0)
  assert.equal(sample.flowPages, 0)
})

await check('signals: fetchTopicSample 深页失败降级为 warning，不丢已采样本', async () => {
  const client = makeFakeClient((requestPath, params) => {
    assert.equal(requestPath, SEARCH_TYPE_PATH)
    if (params.order === 'click' && params.page === 2) throw new Error('模拟第 2 页失败')
    if (params.order === 'click') return searchPayload(120, Array.from({ length: 50 }, (_, index) => rawVideo(index)))
    return searchPayload(999, Array.from({ length: 10 }, (_, index) => rawVideo(index)))
  })
  const sample = await fetchTopicSample(client, '原神', cfg, { windowDays: 7 })
  assert.equal(sample.videos.length, 50)
  assert.equal(sample.recent.length, 10)
  assert.equal(sample.stockPages, 1)
  assert.equal(sample.flowPages, 1)
  assert.match(sample.warnings.join('\n'), /存量样本采样第 2 页失败/)
})

await check('signals: fetchTopicSample 普通接口失败时回退 wbi 签名接口', async () => {
  const client = makeFakeClient((requestPath, params) => {
    if (requestPath === SEARCH_TYPE_PATH) throw new BiliApiError('普通接口 412', { httpStatus: 412 })
    assert.equal(requestPath, SEARCH_TYPE_PATH_WBI)
    assert.equal(params.order, 'click')
    return searchPayload(1, [rawVideo(1)])
  })
  const sample = await fetchTopicSample(client, '原神', cfg, { windowDays: 7 })
  assert.equal(sample.videos.length, 1)
  assert.equal(client.calls[0].path, SEARCH_TYPE_PATH)
  assert.equal(client.calls[1].path, SEARCH_TYPE_PATH_WBI)
  // flow 采样同样走 wbi 回退
  assert.ok(client.calls.some((call) => call.path === SEARCH_TYPE_PATH_WBI && call.params.order === 'pubdate'))
})

await check('signals: fetchHotSearch 解析 trending.list 并重新编号 rank', async () => {
  const client = makeFakeClient((requestPath) => {
    assert.equal(requestPath, HOT_SEARCH_PATH)
    return {
      code: 0,
      data: {
        trending: {
          list: [
            { keyword: '原神', heat_score: '6500000' },
            { keyword: '', heat_score: 1 },
            { keyword: '鸣潮', heat_score: 4900000 },
          ],
        },
      },
    }
  })
  const items = await fetchHotSearch(client, 50, {})
  assert.deepEqual(items, [
    { keyword: '原神', heatScore: 6500000, rank: 1 },
    { keyword: '鸣潮', heatScore: 4900000, rank: 2 },
  ])
})

// --------------------------------------------------------------------------- //
// 11. client.js 纯函数
// --------------------------------------------------------------------------- //

await check('client: cacheKeyFor 稳定、与参数插入顺序无关、16 位十六进制', () => {
  const a = cacheKeyFor('/x/web-interface/search/type', { keyword: '原神', order: 'click', page: 1 })
  const b = cacheKeyFor('/x/web-interface/search/type', { page: 1, order: 'click', keyword: '原神' })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, cacheKeyFor('/x/web-interface/search/type', { keyword: '原神', order: 'click', page: 2 }))
  assert.notEqual(a, cacheKeyFor('/x/other', { keyword: '原神', order: 'click', page: 1 }))
})

await check('client: encodeQuery 按键排序并做 RFC3986 编码', () => {
  assert.equal(encodeQuery({ b: 2, a: '原 神' }), 'a=%E5%8E%9F%20%E7%A5%9E&b=2')
  assert.equal(encodeQuery({ order: 'click', page: 1 }), 'order=click&page=1')
})

await check('client: MIXIN_KEY_ENC_TAB 是 0..63 的排列（与 Python demo 一致）', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64)
  assert.deepEqual([...MIXIN_KEY_ENC_TAB].sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index))
  // 前 8 项与 demo 源码一致
  assert.deepEqual(MIXIN_KEY_ENC_TAB.slice(0, 8), [46, 47, 18, 2, 53, 8, 23, 32])
})

await check('client: isRiskError 只把 412/429/-412/-352/-509 视为可退避风控', () => {
  assert.equal(isRiskError(new BiliApiError('x', { httpStatus: 412 })), true)
  assert.equal(isRiskError(new BiliApiError('x', { httpStatus: 429 })), true)
  assert.equal(isRiskError(new BiliApiError('x', { code: -412 })), true)
  assert.equal(isRiskError(new BiliApiError('x', { code: -352 })), true)
  assert.equal(isRiskError(new BiliApiError('x', { code: -509 })), true)
  assert.equal(isRiskError(new BiliApiError('x', { httpStatus: 500 })), false)
  assert.equal(isRiskError(new BiliApiError('x', { code: -404 })), false)
  assert.equal(isRiskError(null), false)
  assert.equal(isRiskError(new Error('普通错误')), false)
})

// --------------------------------------------------------------------------- //
// 汇总
// --------------------------------------------------------------------------- //

const maxErrorText = Object.entries(maxErr)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => `${key}=${value.toExponential(3)}`)
  .join(' ')

console.log('')
console.log('─'.repeat(72))
console.log(`SMOKE ${failed === 0 ? 'PASS' : 'FAIL'}：${passed} 项通过，${failed} 项失败`)
console.log(`PYTHON-MAX-ERROR: ${maxErrorText}`)
if (failed > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure.label}: ${failure.message.split('\n')[0]}`)
}
console.log('─'.repeat(72))
process.exit(failed === 0 ? 0 : 1)
