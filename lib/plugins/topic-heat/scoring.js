/**
 * 纯函数式评分：输入双向采样（存量 + 最新），输出 0~100 话题热度报告。
 *
 * 严格实现契约 §4：
 *   * 7 个分量（播放规模 / 互动总量 / 互动密度 / 爆款强度 / 更新速度 / 搜索供给 / 相关性）；
 *   * 4 个模型（综合热度 / 讨论热度 / 近期动量 / 消费规模），同一组归一化分量、不同权重；
 *   * 相关性软惩罚、热搜榜加法加成、consensus 分歧度、评级与 warnings、分布统计。
 *
 * 本模块没有任何 I/O：同样的输入 + 配置一定得到同样的输出（便于对拍）。
 * 所有数值都保证有限（clamp / 过滤 NaN），不允许把 NaN/Infinity 泄露给上层。
 *
 * @module dsh-bilibili-bundle/plugins/topic-heat/scoring
 */

import { COMPONENT_META, DEFAULT_CONFIG, MODEL_META, windowLabel } from './config.js'

/** 一天秒数。 */
export const SECONDS_PER_DAY = 86400

// --------------------------------------------------------------------------- //
// 基础工具（导出便于单测）
// --------------------------------------------------------------------------- //

/** 把值转为有限数字；非法值回退 fallback。 */
function finite(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** 非负整数（NaN/Infinity/负数一律归零）。 */
function nonNegInt(value) {
  const number = finite(value)
  return number > 0 ? Math.trunc(number) : 0
}

/**
 * 夹到 [low, high]；NaN 回退 low。
 * @param {number} value
 */
export function clamp(value, low = 0, high = 1) {
  const number = finite(value, low)
  return Math.max(low, Math.min(high, number))
}

/**
 * 对数归一化到 0~1：value=0 → 0，value>=anchor → 1。
 * 公式与 Python demo `log_norm` 一致：log10(1+v) / log10(1+anchor)。
 * @param {number} value
 * @param {number} anchor
 */
export function logNorm(value, anchor) {
  const limit = finite(anchor)
  if (!(limit > 0)) return 0
  const v = Math.max(0, finite(value))
  return clamp(Math.log10(1 + v) / Math.log10(1 + limit))
}

/**
 * 线性带归一化：floor 以下记 0，ceil 以上记 1。
 * 用于已经是 log 尺度的量（平均 log10 播放等），避免大话题都挤在 0.9~1.0。
 * @param {number} value
 * @param {number} floor
 * @param {number} ceil
 */
export function bandNorm(value, floor, ceil) {
  const low = finite(floor)
  const high = finite(ceil)
  if (!(high > low)) return 0
  return clamp((finite(value) - low) / (high - low))
}

/**
 * 加权互动：like*1 + favorite*2 + reply*2 + danmaku*3（权重可配置）。
 * @param {object} video
 * @param {object} [cfg]
 */
export function weightedEngagement(video, cfg = DEFAULT_CONFIG) {
  const weights = cfg?.engagementWeights ?? DEFAULT_CONFIG.engagementWeights
  const source = video && typeof video === 'object' ? video : {}
  return (
    nonNegInt(source.like) * finite(weights.like, 1) +
    nonNegInt(source.favorite) * finite(weights.favorite, 2) +
    nonNegInt(source.reply) * finite(weights.reply, 2) +
    nonNegInt(source.danmaku) * finite(weights.danmaku, 3)
  )
}

/**
 * 相关性匹配（契约 §4.1）：标题+标签 lowercase；
 * 整词包含 → true；关键词长度 >=3 时前缀 2 字或后缀 2 字包含 → true。
 * @param {string} keyword
 * @param {object} video
 */
export function isRelevant(keyword, video) {
  const kw = typeof keyword === 'string' ? keyword.trim().toLowerCase() : ''
  if (!kw) return false
  const source = video && typeof video === 'object' ? video : {}
  const text = `${typeof source.title === 'string' ? source.title : ''} ${
    typeof source.tag === 'string' ? source.tag : ''
  }`.toLowerCase()
  if (text.includes(kw)) return true
  if (kw.length >= 3) return text.includes(kw.slice(0, 2)) || text.includes(kw.slice(-2))
  return false
}

/** 计算一组数值的 log10(1+v) 均值；空数组返回 0。 */
function meanLog(values) {
  if (!values.length) return 0
  let sum = 0
  for (const value of values) sum += Math.log10(1 + Math.max(0, finite(value)))
  return sum / values.length
}

/**
 * 更新速度（条/天）：分子 = recent 条数（含 pubdate=0 的条目），
 * 分母 = max(最近样本里 pubdate>0 的最大年龄天数, 0.001)；全部 pubdate=0 → 0。
 * 负年龄（端点对齐/时钟误差）按 0 处理；参考时刻优先用 windowEnd，否则抓取时刻。
 * @param {Array<object>} recent
 * @param {number} referenceMs 参考时刻（毫秒时间戳）
 * @returns {number}
 */
export function computeVelocity(recent, referenceMs) {
  if (!Array.isArray(recent) || recent.length === 0) return 0
  const reference = finite(referenceMs)
  if (!(reference > 0)) return 0
  let maxAgeDays = -1
  for (const video of recent) {
    const pubdate = nonNegInt(video?.pubdate)
    if (pubdate <= 0) continue
    const age = Math.max(0, (reference - pubdate * 1000) / (SECONDS_PER_DAY * 1000))
    if (age > maxAgeDays) maxAgeDays = age
  }
  if (maxAgeDays < 0) return 0 // 所有样本都没有有效 pubdate
  const spanDays = Math.max(maxAgeDays, 0.001)
  return recent.length / spanDays
}

/** 取第一个已定义的字段（兼容 Python fixture 的 snake_case 与内部 camelCase）。 */
function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * 时间戳统一成毫秒：Python fixture 用 unix 秒（<1e12），内部采样用毫秒。
 * 非正数/非法值返回 0。
 */
function toMilliseconds(value) {
  const number = finite(value)
  if (!(number > 0)) return 0
  return number < 1e12 ? Math.round(number * 1000) : number
}

/** 按配置的阈值给指数评级；低于最小阈值返回「凉」。 */
export function tierFor(index, cfg = DEFAULT_CONFIG) {
  const value = clamp(finite(index), 0, 100)
  const tiers = Array.isArray(cfg?.tiers) ? cfg.tiers : DEFAULT_CONFIG.tiers
  for (const tier of tiers) {
    if (value >= finite(tier.min)) return tier.label
  }
  return '凉'
}

/** 在热搜榜里找该话题（关键词包含关系，取排名最靠前的一条）。 */
function matchHot(keyword, hotItems) {
  const kw = typeof keyword === 'string' ? keyword.trim().toLowerCase() : ''
  if (!kw || !Array.isArray(hotItems)) return null
  let best = null
  for (const item of hotItems) {
    if (!item || typeof item !== 'object') continue
    const name = typeof item.keyword === 'string' ? item.keyword.trim().toLowerCase() : ''
    const rank = nonNegInt(item.rank)
    if (!name || rank <= 0) continue
    if (kw.includes(name) || name.includes(kw)) {
      // fixture 里是 heat_score，内部抓取是 heatScore；这里只用于展示，不做计算
      const heatScore = nonNegInt(pickValue(item.heatScore, item.heat_score))
      if (!best || rank < best.rank) best = { keyword: item.keyword, heatScore, rank }
    }
  }
  return best
}

/** 把数字压成人话（1.2万 / 3.45亿），用于模型 summary。 */
function compactCount(value) {
  const number = Math.max(0, finite(value))
  if (number >= 1e8) return `${(number / 1e8).toFixed(2)}亿`
  if (number >= 1e4) return `${(number / 1e4).toFixed(1)}万`
  return String(Math.round(number))
}

/** 清洗一个视频对象，保证所有字段类型正确且数值有限。 */
function normalizeVideo(video) {
  const source = video && typeof video === 'object' ? video : {}
  return {
    bvid: typeof source.bvid === 'string' ? source.bvid : '',
    title: typeof source.title === 'string' ? source.title : '',
    author: typeof source.author === 'string' ? source.author : '',
    play: nonNegInt(source.play),
    like: nonNegInt(source.like),
    favorite: nonNegInt(source.favorite ?? source.favorites),
    reply: nonNegInt(source.reply ?? source.review),
    danmaku: nonNegInt(source.danmaku ?? source.video_review),
    pubdate: nonNegInt(source.pubdate),
    duration_sec: nonNegInt(source.duration_sec),
    type_name: typeof source.type_name === 'string' ? source.type_name : '',
    tag: typeof source.tag === 'string' ? source.tag : '',
  }
}

/** 清洗视频数组，丢掉非对象项。 */
function normalizeVideos(list) {
  if (!Array.isArray(list)) return []
  return list.filter((item) => item && typeof item === 'object').map(normalizeVideo)
}

// --------------------------------------------------------------------------- //
// 分量与模型计算
// --------------------------------------------------------------------------- //

/**
 * 按「模型权重 × 分量归一化」计算一个模型的 0~100 基础分（含相关性惩罚）。
 * @param {Record<string, number>} weights
 * @param {Record<string, number>} componentNorms
 * @param {{ relevance:number, floor:number, penalty:number }} relevanceGate
 */
function modelIndex(weights, componentNorms, relevanceGate) {
  let weightedSum = 0
  let weightSum = 0
  for (const [id, weight] of Object.entries(weights ?? {})) {
    const w = Math.max(0, finite(weight))
    if (w === 0) continue
    const norm = clamp(finite(componentNorms[id]))
    weightedSum += norm * w
    weightSum += w
  }
  let index = weightSum > 0 ? (100 * weightedSum) / weightSum : 0
  if (relevanceGate.relevance < relevanceGate.floor) index *= relevanceGate.penalty
  return clamp(index, 0, 100)
}

/** 保留 digits 位小数；NaN/Infinity 回退 0，并避免 -0（与 Python round 的展示口径对齐）。 */
function roundTo(value, digits) {
  const number = finite(value)
  const factor = 10 ** digits
  const rounded = Math.round(number * factor) / factor
  return rounded === 0 ? 0 : rounded
}

/** 两个百分比文本，用于 warning/summary。 */
function percentText(value, digits = 0) {
  return `${(clamp(finite(value), 0, 1) * 100).toFixed(digits)}%`
}

/**
 * 计算一个话题的热度报告（纯函数）。
 *
 * @param {object} sample TopicSample：`{keyword, numResults, videos, recent, windowDays, windowStart, windowEnd, fetchedAt, windowPreset, stockPages, flowPages, warnings}`
 * @param {Array<{keyword:string, heatScore:number, rank:number}>} [hotItems] 热搜榜
 * @param {object} [cfg] resolveConfig 后的配置
 * @returns {object} 报告对象（字段见 format.toToolValue 的输入约定）
 */
export function scoreTopic(sample, hotItems = [], cfg = DEFAULT_CONFIG) {
  const config = cfg && typeof cfg === 'object' && cfg.sampling ? cfg : DEFAULT_CONFIG
  const source = sample && typeof sample === 'object' ? sample : {}
  const anchors = config.anchors
  const relevanceCfg = config.relevance
  const outputCfg = config.output
  // ---- 字段读取：兼容内部 camelCase 与 Python fixture 的 snake_case ----
  const topicRaw = pickValue(source.keyword, source.topic)
  const topic = typeof topicRaw === 'string' ? topicRaw : ''
  const presetRaw = pickValue(source.windowPreset, source.window_preset)
  const windowPreset = typeof presetRaw === 'string' && presetRaw ? presetRaw : null
  const windowDays = Math.max(0, nonNegInt(pickValue(source.windowDays, source.window_days)))
  // 时间戳统一按毫秒处理（fixture 是 unix 秒，内部采样是毫秒）
  const windowStart = toMilliseconds(pickValue(source.windowStart, source.window_start))
  const windowEnd = toMilliseconds(pickValue(source.windowEnd, source.window_end))
  const fetchedAt = toMilliseconds(pickValue(source.fetchedAt, source.fetched_at))
  const asOf = fetchedAt > 0 ? fetchedAt : Date.now()
  const numResults = Math.max(0, nonNegInt(pickValue(source.numResults, source.num_results)))
  const stockPages = nonNegInt(pickValue(source.stockPages, source.stock_pages))
  const flowPages = nonNegInt(pickValue(source.flowPages, source.flow_pages))
  const inputWarnings = Array.isArray(source.warnings)
    ? source.warnings.filter((item) => typeof item === 'string' && item)
    : []

  // 注意：这里刻意不按 bvid 去重、不清洗 HTML、不过滤任何视频——
  // 去重/清洗属于 signals 层职责；评分层必须对传入样本保持忠实（对拍需要）。
  const videos = normalizeVideos(source.videos)
  const recent = normalizeVideos(source.recent)
  const hotList = Array.isArray(hotItems) ? hotItems : []

  const compositeWeights = config.modelWeights.composite
  const label = windowLabel(windowPreset, windowDays)

  const emptyReport = (warnings) => {
    // 与 demo 一致：存在性门控时 components=[]、distribution={}；
    // 稳定的 7 分量/4 模型形状由 format.toToolValue 负责补齐。
    const models = MODEL_META.map((meta) => ({
      id: meta.id,
      name: meta.name,
      index: 0,
      tier: '凉',
      summary: meta.id === 'composite' ? '窗口内没有相关内容，指数记 0' : `缺少样本，${meta.name}记 0`,
    }))
    const consensus = { mean: 0, min: 0, max: 0, spread: 0, agreement: '一致' }
    return {
      topic,
      windowDays,
      windowPreset,
      windowLabel: label,
      windowStart,
      windowEnd,
      asOf,
      index: 0,
      tier: '凉',
      baseIndex: 0,
      hotBonus: 0,
      components: [],
      models,
      consensus,
      evidence: {
        sampleSize: 0,
        recentSize: recent.length,
        headSize: 0,
        numResults,
        velocityPerDay: 0,
        relevance: 0,
        hotRank: null,
        hotBonus: 0,
        medianPlay: 0,
        p90Play: 0,
        authors: 0,
      },
      distribution: {},
      stockPages,
      flowPages,
      topVideos: [],
      warnings,
      hot: null,
      emptyGated: true,
    }
  }

  // ---- 存在性门控：搜索命中 0 且没有任何样本 → 话题不存在/过于生僻 ----
  if (numResults <= 0 && videos.length === 0) {
    const warnings = [
      ...inputWarnings,
      `B 站搜索在「${label}」内无相关内容（话题不存在、过于生僻，或该时段内没有内容）`,
    ]
    return emptyReport(warnings)
  }

  const warnings = []
  // 输入层（抓取降级）的 warning 先放进来，再追加评分自身的观察
  for (const item of inputWarnings) warnings.push(item)

  let stockVideos = videos
  let sampleSize = stockVideos.length
  if (sampleSize === 0) {
    warnings.push('存量样本为空，仅凭最新内容估算')
    stockVideos = recent
    sampleSize = stockVideos.length
  }

  // ---- 头部固定取按播放降序的前 headSize 条（保证跨话题可比）----
  const headSizeCfg = Math.max(1, nonNegInt(config.sampling.headSize) || DEFAULT_CONFIG.sampling.headSize)
  const head = [...stockVideos].sort((a, b) => b.play - a.play).slice(0, headSizeCfg)
  const headN = head.length
  const plays = head.map((video) => video.play)
  const engagements = head.map((video) => weightedEngagement(video, config))

  // ---- 全量样本只用于分布统计（描述性信息，不进指数）----
  const allPlays = stockVideos.map((video) => video.play).sort((a, b) => a - b)
  const medianPlay = allPlays.length ? allPlays[Math.floor(allPlays.length / 2)] : 0
  const p90Play = allPlays.length ? allPlays[Math.floor(allPlays.length * 0.9)] : 0
  const authors = new Set(stockVideos.map((video) => video.author).filter(Boolean)).size
  const distribution = { stockSample: sampleSize, medianPlay, p90Play, authors }

  // ---- 采样质量 warnings ----
  const minSample = nonNegInt(config.sampling.minSample)
  if (headN < minSample) {
    warnings.push(`头部样本仅 ${headN} 条，置信度低`)
  } else if (headN < headSizeCfg) {
    warnings.push(`头部样本 ${headN} 条（少于 ${headSizeCfg}），均值类分量仍有噪声`)
  }
  if (numResults >= anchors.supply) {
    if (windowDays > 0) {
      warnings.push('窗口内命中数触顶（1000），供给分量按上限估计（真实值可能更高）')
    } else {
      warnings.push('全时段模式下命中数恒触顶，供给分量对所有话题一致')
    }
  }
  if (recent.length === 0) {
    warnings.push('缺少最新内容样本，更新速度记 0')
  } else if (recent.length < minSample) {
    warnings.push(`最新内容样本仅 ${recent.length} 条，更新速度可能失真`)
  } else if (recent.length < 50) {
    warnings.push(`最新内容样本 ${recent.length} 条（少于 50），更新速度仍有噪声`)
  }

  // ---- 7 个分量（归一化到 0~1）----
  const meanLogPlay = meanLog(plays)
  const meanLogEngagement = meanLog(engagements)
  const totalPlay = plays.reduce((sum, value) => sum + value, 0)
  const totalEngagement = engagements.reduce((sum, value) => sum + value, 0)
  const rate = totalPlay > 0 ? totalEngagement / totalPlay : 0
  const peakPlay = plays.length ? Math.max(...plays) : 0
  const velocityReference = windowEnd > 0 ? windowEnd : asOf
  const velocity = computeVelocity(recent, velocityReference)
  const supplyNorm =
    numResults >= anchors.supply
      ? clamp(anchors.supplySaturatedValue)
      : logNorm(numResults, anchors.supply)
  const relevance = headN > 0 ? head.filter((video) => isRelevant(topic, video)).length / headN : 0

  const componentNorms = {
    play: bandNorm(meanLogPlay, anchors.playLogFloor, anchors.playLogCeil),
    engagement: bandNorm(meanLogEngagement, anchors.engLogFloor, anchors.engLogCeil),
    rate: logNorm(rate, anchors.rate),
    peak: bandNorm(Math.log10(1 + peakPlay), anchors.peakLogFloor, anchors.peakLogCeil),
    velocity: logNorm(velocity, anchors.velocity),
    supply: supplyNorm,
    relevance: clamp(relevance),
  }
  const componentRaws = {
    play: meanLogPlay,
    engagement: meanLogEngagement,
    rate,
    peak: peakPlay,
    velocity,
    supply: numResults,
    relevance,
  }

  // 分量顺序固定按契约 §4.1（play/engagement/rate/peak/velocity/supply/relevance）
  // 报告里的分量按 Python HeatReport.to_dict 的精度取整（raw/normalized 4 位、points 2 位），
  // 便于与 demo 对拍；baseIndex 仍用未取整的中间值计算。
  const components = COMPONENT_META.map((meta) => {
    const id = meta.id
    const weight = Math.max(0, finite(compositeWeights[id]))
    const normalized = clamp(componentNorms[id])
    return {
      id,
      name: meta.name,
      raw: roundTo(finite(componentRaws[id]), 4),
      normalized: roundTo(normalized, 4),
      weight: roundTo(weight, 4),
      points: roundTo(normalized * weight * 100, 2),
      // 内部未取整值：只用于计算，不进入报告
      _normalized: normalized,
    }
  })

  const weightSum = components.reduce((sum, component) => sum + component.weight, 0)
  if (Math.abs(weightSum - 1) > 1e-6) {
    warnings.push(`权重和为 ${weightSum.toFixed(2)}，已自动归一化`)
  }

  // ---- 相关性软惩罚：匹配率太低说明多半是搜索的模糊兜底结果 ----
  const relevanceGate = {
    relevance,
    floor: finite(relevanceCfg.floor, DEFAULT_CONFIG.relevance.floor),
    penalty: finite(relevanceCfg.penalty, DEFAULT_CONFIG.relevance.penalty),
  }
  if (relevance < relevanceGate.floor) {
    warnings.push(
      `相关性 ${percentText(relevance)} < ${percentText(relevanceGate.floor)}，结果多为模糊匹配，指数已乘 ${relevanceGate.penalty}`,
    )
  }

  // baseIndex = 100 * Σ(norm*weight) / Σweight（相关性惩罚在此处生效）
  // Python: base_index = sum(points) / total_weight，points = normalized * weight * 100
  const rawBaseIndex =
    weightSum > 0 ? components.reduce((sum, component) => sum + component._normalized * component.weight * 100, 0) / weightSum : 0
  const baseIndex = clamp(
    relevance < relevanceGate.floor ? rawBaseIndex * relevanceGate.penalty : rawBaseIndex,
    0,
    100,
  )

  // ---- 四个模型（不含热搜加成；各自归一化到 0~100）----
  const models = MODEL_META.map((meta) => {
    const weights = config.modelWeights[meta.id] ?? {}
    const index = meta.id === 'composite' ? baseIndex : modelIndex(weights, componentNorms, relevanceGate)
    return {
      id: meta.id,
      name: meta.name,
      index,
      tier: tierFor(index, config),
      summary: modelSummary(meta.id, {
        index,
        tier: tierFor(index, config),
        rate,
        velocity,
        meanPlay: plays.length ? totalPlay / plays.length : 0,
        peakPlay,
      }),
    }
  })

  // ---- 热搜加成 ----
  const hot = matchHot(topic, hotList)
  const hotRank = hot ? hot.rank : null
  const hotBonusMax = Math.max(0, finite(config.hotBonusMax))
  const hotBonus = hot ? hotBonusMax * clamp(1 - (hot.rank - 1) / 50) : 0
  const index = clamp(baseIndex + hotBonus, 0, 100)

  // ---- consensus：4 个模型基础分的均值/极值/分歧度 ----
  const modelIndexes = models.map((model) => clamp(model.index, 0, 100))
  const consensusMean = modelIndexes.reduce((sum, value) => sum + value, 0) / modelIndexes.length
  const consensusMin = Math.min(...modelIndexes)
  const consensusMax = Math.max(...modelIndexes)
  const spread = consensusMax - consensusMin
  const agreement = spread <= 10 ? '一致' : spread <= 20 ? '基本一致' : '分歧'
  const consensus = { mean: consensusMean, min: consensusMin, max: consensusMax, spread, agreement }

  // ---- 代表视频：全量样本按播放降序取前 N ----
  const topVideos = [...stockVideos]
    .sort((a, b) => b.play - a.play)
    .slice(0, Math.max(1, nonNegInt(outputCfg.topVideos) || DEFAULT_CONFIG.output.topVideos))
    .map((video) => ({
      bvid: video.bvid,
      title: video.title,
      author: video.author,
      play: video.play,
      like: video.like,
      pubdate: video.pubdate,
      url: video.bvid ? `https://www.bilibili.com/video/${video.bvid}` : '',
    }))

  // 剥离只用于计算的内部字段
  const publicComponents = components.map(({ _normalized, ...component }) => component)

  return {
    topic,
    windowDays,
    windowPreset,
    windowLabel: label,
    windowStart,
    windowEnd,
    asOf,
    index,
    tier: tierFor(index, config),
    baseIndex,
    hotBonus,
    components: publicComponents,
    models,
    consensus,
    evidence: {
      sampleSize,
      recentSize: recent.length,
      headSize: headN,
      numResults,
      velocityPerDay: velocity,
      relevance,
      hotRank,
      hotBonus,
      medianPlay,
      p90Play,
      authors,
    },
    distribution,
    stockPages,
    flowPages,
    topVideos,
    warnings,
    hot,
    emptyGated: false,
  }
}

/** 生成一句人话 summary（契约 §4.2）。 */
function modelSummary(id, stats) {
  const score = `${clamp(stats.index, 0, 100).toFixed(1)} 分（${stats.tier}）`
  switch (id) {
    case 'composite':
      return `综合 ${score}，头部平均播放 ${compactCount(stats.meanPlay)}`
    case 'discussion':
      return `互动率 ${percentText(stats.rate, 1)}，讨论热度 ${score}`
    case 'momentum':
      return `更新速度 ${compactCount(stats.velocity)} 条/天，近期动量 ${score}`
    case 'scale':
      return `头部均值播放 ${compactCount(stats.meanPlay)}、峰值 ${compactCount(stats.peakPlay)}，消费规模 ${score}`
    default:
      return score
  }
}
