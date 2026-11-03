/**
 * 输出格式化：
 *   * {@link toToolValue} 生成契约 §6 的固定结构（工具 value，也是 output.schema）；
 *   * {@link renderReport} 生成契约 §7 的中文文本（模型直接读）。
 *
 * 这里负责把所有浮点数收敛成「有限、有界、按位数取整」的 JSON，并隐藏内部字段
 * （如 bvid 之外的采样细节），保证 value 可以直接 JSON 序列化、没有
 * NaN / Infinity / undefined。
 *
 * @module dsh-bilibili-bundle/plugins/topic-heat/format
 */

import { COMPONENT_META, DEFAULT_CONFIG, MODEL_META, windowLabel } from './config.js'

/** 组件 id → 文本里的短名（契约 §7）。 */
const COMPONENT_SHORT = Object.freeze({
  play: '播放',
  engagement: '互动',
  rate: '密度',
  peak: '爆款',
  velocity: '速度',
  supply: '供给',
  relevance: '相关',
})

/** 模型 id → 文本里的短名（契约 §7）。 */
const MODEL_SHORT = Object.freeze({
  composite: '综合',
  discussion: '讨论',
  momentum: '动量',
  scale: '规模',
})

/** 渲染文本长度上限（契约 §7 要求 ~1200 字内，留一点余量）。 */
const MAX_RENDER_CHARS = 1500

// --------------------------------------------------------------------------- //
// 基础小工具
// --------------------------------------------------------------------------- //

/** 保留 digits 位小数；NaN/Infinity 回退 0，并避免 -0。 */
function roundTo(value, digits = 2) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  const rounded = Math.round(number * factor) / factor
  return rounded === 0 ? 0 : rounded
}

/** 有限整数（NaN/Infinity/负数归零）。 */
function integer(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.trunc(number)
}

/** 毫秒时间戳 → ISO 字符串（非法值用当前时间兜底）。 */
function isoTime(ms) {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : Date.now()
  return new Date(value).toISOString()
}

/** 按字符（而非 UTF-16 码元）截断，避免切坏 emoji/生僻字。 */
function clipText(text, maxLength) {
  const value = typeof text === 'string' ? text : ''
  const chars = [...value]
  if (chars.length <= maxLength) return value
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join('')}…`
}

/** ISO → 本地 `MM-DD`（用于标题行）。 */
function shortDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

/** ISO → 本地 `YYYY-MM-DD HH:mm`（用于数据来源行）。 */
function dateTimeText(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 数字压成人话：1.2万 / 3.45亿。 */
export function formatCompactNumber(value) {
  const number = Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0)
  if (number >= 1e8) return `${(number / 1e8).toFixed(2)}亿`
  if (number >= 1e4) return `${(number / 1e4).toFixed(1)}万`
  return String(Math.round(number))
}

/** 通过天数反查窗口 preset（当报告未携带 preset 时）。 */
function presetFor(days, cfg) {
  const windows = cfg?.windows ?? DEFAULT_CONFIG.windows
  for (const [key, value] of Object.entries(windows)) {
    if (Number(value) === days) return key
  }
  return `${days}d`
}

/** 报告里的窗口 preset（优先使用抓取时用户选择的键）。 */
function resolvePreset(report, days, cfg) {
  if (typeof report?.windowPreset === 'string' && report.windowPreset) return report.windowPreset
  return presetFor(days, cfg)
}

// --------------------------------------------------------------------------- //
// 工具 value（契约 §6）
// --------------------------------------------------------------------------- //

/**
 * 生成契约 §6 的固定结构。字段、顺序、类型固定；数组有界；
 * 所有数字有限且按契约保留位数（index 等 2 位、relevance 3 位、velocity 1 位）。
 *
 * @param {object} report scoreTopic 的返回值
 * @param {object} [cfg] resolveConfig 后的配置
 * @returns {object} 可直接 JSON 序列化的工具 value
 */
export function toToolValue(report, cfg = DEFAULT_CONFIG) {
  const source = report && typeof report === 'object' ? report : {}
  const config = cfg && typeof cfg === 'object' ? cfg : DEFAULT_CONFIG
  const days = integer(source.windowDays)
  const preset = resolvePreset(source, days, config)
  const asOf = isoTime(Number(source.asOf))

  // 窗口起止：优先使用抓取时量化过的端点，保证与请求参数一致
  let windowStart = Number(source.windowStart)
  let windowEnd = Number(source.windowEnd)
  if (!(windowEnd > 0)) windowEnd = Number(source.asOf) > 0 ? Number(source.asOf) : Date.now()
  if (!(windowStart > 0)) windowStart = days > 0 ? windowEnd - days * 86400 * 1000 : windowEnd

  const models = Array.isArray(source.models) ? source.models : []
  const components = Array.isArray(source.components) ? source.components : []
  const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {}
  const consensus = source.consensus && typeof source.consensus === 'object' ? source.consensus : {}
  const heat = source.heat && typeof source.heat === 'object' ? source.heat : source
  const sourceMeta = source.source && typeof source.source === 'object' ? source.source : {}

  const topVideosLimit = Math.max(
    1,
    integer(config.output?.topVideos) || DEFAULT_CONFIG.output.topVideos,
  )
  const warningsLimit =
    integer(config.output?.maxWarnings) >= 0 ? integer(config.output?.maxWarnings) : DEFAULT_CONFIG.output.maxWarnings

  const topVideos = (Array.isArray(source.topVideos) ? source.topVideos : [])
    .slice(0, topVideosLimit)
    .map((video) => {
      const item = video && typeof video === 'object' ? video : {}
      const bvid = typeof item.bvid === 'string' ? item.bvid : ''
      return {
        title: typeof item.title === 'string' ? item.title : '',
        author: typeof item.author === 'string' ? item.author : '',
        play: integer(item.play),
        like: integer(item.like),
        pubdate: integer(item.pubdate),
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
      }
    })

  const warnings = (Array.isArray(source.warnings) ? source.warnings : [])
    .filter((item) => typeof item === 'string' && item)
    .slice(0, warningsLimit)

  const hotRankRaw = evidence.hotRank
  const hotRank = Number.isInteger(hotRankRaw) && hotRankRaw > 0 ? hotRankRaw : null

  // 形状稳定：无论上游报告是否在存在性门控下省略了分量/模型，
  // value 里始终输出固定顺序的 7 个分量与 4 个模型（缺失补 0）。
  const modelById = new Map(
    models.filter((model) => model && typeof model === 'object').map((model) => [model.id, model]),
  )
  const paddedModels = MODEL_META.map((meta) => {
    const model = modelById.get(meta.id)
    return {
      id: meta.id,
      name: typeof model?.name === 'string' && model.name ? model.name : meta.name,
      index: roundTo(model?.index, 2),
      tier: typeof model?.tier === 'string' ? model.tier : '凉',
      summary: typeof model?.summary === 'string' ? model.summary : '无相关数据',
    }
  })

  const compositeWeights = config.modelWeights?.composite ?? DEFAULT_CONFIG.modelWeights.composite
  const componentById = new Map(
    components
      .filter((component) => component && typeof component === 'object')
      .map((component) => [component.id, component]),
  )
  const paddedComponents = COMPONENT_META.map((meta) => {
    const component = componentById.get(meta.id)
    return {
      id: meta.id,
      name: meta.name,
      raw: roundTo(component?.raw, 2),
      normalized: roundTo(component?.normalized, 2),
      weight: roundTo(component?.weight ?? compositeWeights[meta.id], 2),
      points: roundTo(component?.points, 2),
    }
  })

  return {
    topic: typeof source.topic === 'string' ? source.topic : '',
    window: {
      preset,
      days,
      label: windowLabel(preset, days),
      start: isoTime(Math.trunc(windowStart)),
      end: isoTime(Math.trunc(windowEnd)),
    },
    asOf,
    heat: {
      index: roundTo(source.index, 2),
      tier: typeof source.tier === 'string' ? source.tier : '凉',
      baseIndex: roundTo(source.baseIndex, 2),
      hotBonus: roundTo(source.hotBonus, 2),
    },
    models: paddedModels,
    consensus: {
      mean: roundTo(consensus.mean, 2),
      min: roundTo(consensus.min, 2),
      max: roundTo(consensus.max, 2),
      spread: roundTo(consensus.spread, 2),
      agreement: typeof consensus.agreement === 'string' ? consensus.agreement : '一致',
    },
    components: paddedComponents,
    evidence: {
      sampleSize: integer(evidence.sampleSize),
      recentSize: integer(evidence.recentSize),
      headSize: integer(evidence.headSize),
      numResults: integer(evidence.numResults),
      velocityPerDay: roundTo(evidence.velocityPerDay, 1),
      relevance: roundTo(evidence.relevance, 3),
      hotRank,
      hotBonus: roundTo(evidence.hotBonus, 2),
      medianPlay: integer(evidence.medianPlay),
      p90Play: integer(evidence.p90Play),
      authors: integer(evidence.authors),
    },
    topVideos,
    warnings,
    source: {
      engine: 'bilibili-search',
      fetchedAt: asOf,
      cached: Boolean(sourceMeta.cached),
      requests: integer(sourceMeta.requests),
    },
  }
}

// --------------------------------------------------------------------------- //
// 渲染文本（契约 §7）
// --------------------------------------------------------------------------- //

/**
 * 渲染中文文本报告。既接受 scoreTopic 的报告，也接受 toToolValue 的 value
 * （通过是否存在 `heat` 字段区分），便于 render 回调与单测复用。
 *
 * @param {object} reportOrValue
 * @param {object} [cfg]
 * @returns {string}
 */
export function renderReport(reportOrValue, cfg = DEFAULT_CONFIG) {
  const config = cfg && typeof cfg === 'object' ? cfg : DEFAULT_CONFIG
  const value =
    reportOrValue && typeof reportOrValue === 'object' && reportOrValue.heat
      ? reportOrValue
      : toToolValue(reportOrValue, config)

  const lines = []
  const window = value.window ?? {}
  const heat = value.heat ?? {}
  const evidence = value.evidence ?? {}
  const consensus = value.consensus ?? {}
  const models = Array.isArray(value.models) ? value.models : []
  const components = Array.isArray(value.components) ? value.components : []
  const topVideos = Array.isArray(value.topVideos) ? value.topVideos : []
  const warnings = Array.isArray(value.warnings) ? value.warnings : []
  const source = value.source ?? {}

  // 标题行：■ 原神 · 近7天（10-27 → 11-03）｜综合热度 72.4/100（热）
  const windowText =
    window.days > 0
      ? `${window.label ?? windowLabel(window.preset, window.days)}（${shortDate(window.start)} → ${shortDate(window.end)}）`
      : `${window.label ?? '全时段'}`
  lines.push(
    `■ ${value.topic || '(空话题)'} · ${windowText}｜综合热度 ${roundTo(heat.index, 1)}/100（${heat.tier ?? '凉'}）` +
      `｜heat.baseIndex=${roundTo(heat.baseIndex, 1)} heat.hotBonus=${roundTo(heat.hotBonus, 1)}`,
  )
  lines.push(
    `窗口：window.preset=${window.preset ?? '-'} window.days=${window.days ?? 0}` +
      ` window.start=${window.start ?? '-'} window.end=${window.end ?? '-'}`,
  )

  // 多模型行
  if (models.length > 0) {
    const modelCells = models
      .map((model) => `${MODEL_SHORT[model.id] ?? model.name} ${roundTo(model.index, 1)}`)
      .join(' | ')
    lines.push(
      `多模型：${modelCells}（均值 ${roundTo(consensus.mean, 1)}，分歧度 ${roundTo(consensus.spread, 1)}，${consensus.agreement ?? '一致'}）`,
    )
  }

  // 分量行
  if (components.length > 0) {
    const cells = components
      .map((component) => `${COMPONENT_SHORT[component.id] ?? component.name} ${roundTo(component.normalized, 2).toFixed(2)}`)
      .join(' · ')
    lines.push(`分量（归一化）：${cells}`)
  }

  // 证据行
  const hotRankText =
    evidence.hotRank === null || evidence.hotRank === undefined
      ? 'null（热搜 未上榜）'
      : `${evidence.hotRank}（热搜 第${evidence.hotRank}位）`
  lines.push(
    `证据：evidence.sampleSize=${evidence.sampleSize ?? 0} evidence.recentSize=${evidence.recentSize ?? 0} ` +
      `evidence.headSize=${evidence.headSize ?? 0} evidence.numResults=${evidence.numResults ?? 0}（窗口内命中） ` +
      `evidence.velocityPerDay=${roundTo(evidence.velocityPerDay, 1)}（条/天） ` +
      `evidence.relevance=${roundTo(Number(evidence.relevance) * 100, 0)}% ` +
      `evidence.hotRank=${hotRankText} evidence.hotBonus=${roundTo(evidence.hotBonus, 1)} ` +
      `evidence.medianPlay=${evidence.medianPlay ?? 0} evidence.p90Play=${evidence.p90Play ?? 0} evidence.authors=${evidence.authors ?? 0}`,
  )

  // 代表视频
  lines.push('代表视频：')
  if (topVideos.length === 0) {
    lines.push('  （无可用样本）')
  } else {
    topVideos.forEach((video, index) => {
      lines.push(
        `  ${index + 1}. ${clipText(video.title || '(无标题)', 40)}（${clipText(video.author || '未知UP', 16)}，` +
          `播放 ${formatCompactNumber(video.play)}，点赞 ${formatCompactNumber(video.like)}）` +
          `${video.url ? ` ${video.url}` : ''}`,
      )
    })
  }

  // 存在性门控说明（契约 §7：无数据/0 分也要解释）
  if (value.heat?.index === 0 && (evidence.sampleSize ?? 0) === 0) {
    lines.push('判定：该时间窗口内没有相关数据，指数记 0。')
  }

  // 警告（必须存在）
  if (warnings.length > 0) {
    lines.push(`⚠ 警告（${warnings.length} 条）：`)
    for (const warning of warnings) lines.push(`  - ${warning}`)
  } else {
    lines.push('⚠ 警告：无')
  }

  // 数据来源行（必须存在）
  lines.push(
    `数据：B站搜索采样，engine=${source.engine ?? 'bilibili-search'}，fetchedAt=${dateTimeText(source.fetchedAt ?? value.asOf)}，` +
      `source.cached=${source.cached ? 'true' : 'false'}，source.requests=${source.requests ?? 0}`,
  )

  let text = lines.join('\n')
  if (text.length > MAX_RENDER_CHARS) text = `${text.slice(0, MAX_RENDER_CHARS - 1)}…`
  return text
}
