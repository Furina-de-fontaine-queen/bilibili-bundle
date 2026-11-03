/**
 * 信号采集：把 B 站接口返回的原始 JSON 清洗成评分模块需要的样本。
 *
 * 每个话题在指定时间窗内做两种排序的多页采样（契约 §3）：
 *   * `order=click`   → 存量样本：窗口内播放最高的内容（规模 / 互动 / 爆款）
 *   * `order=pubdate` → 增量样本：窗口内最新发布的内容（更新速度）
 *
 * 两次采样必须复用同一组窗口端点（900s 量化后的 unix 秒），否则窗口会错位。
 * 普通搜索接口失败时自动退回 wbi 签名接口 `/x/web-interface/wbi/search/type`。
 *
 * @module dsh-bilibili-bundle/plugins/topic-heat/signals
 */

import { buildWindowParams, toSearchTimeFilter } from '../../shared/windows.js'
import { BiliApiError } from '../../shared/errors.js'

/** 普通搜索接口。 */
export const SEARCH_TYPE_PATH = '/x/web-interface/search/type'
/** wbi 签名搜索接口（普通接口失败时的回退）。 */
export const SEARCH_TYPE_PATH_WBI = '/x/web-interface/wbi/search/type'
/** 热搜榜接口。 */
export const HOT_SEARCH_PATH = '/x/web-interface/search/square'

/** 存量排序：最多播放。 */
export const ORDER_STOCK = 'click'
/** 增量排序：最新发布。 */
export const ORDER_FLOW = 'pubdate'

// --------------------------------------------------------------------------- //
// HTML 清洗
// --------------------------------------------------------------------------- //

/** 常用命名 HTML 实体表（等价 Python html.unescape 的常见子集）。 */
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
})

/**
 * 等价 Python `html.unescape` 的轻量实现：命名实体 + 十进制/十六进制数字实体。
 * 无法识别的实体原样保留。
 * @param {string} text
 * @returns {string}
 */
export function htmlUnescape(text) {
  if (typeof text !== 'string' || !text.includes('&')) return typeof text === 'string' ? text : ''
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (match, dec, hex, name) => {
    if (dec !== undefined) {
      const code = Number(dec)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    if (hex !== undefined) {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    const entity = NAMED_ENTITIES[name.toLowerCase()]
    return entity ?? match
  })
}

/**
 * 清洗搜索结果标题：去掉 `<em class="keyword">` 高亮标签，再反转义 HTML 实体。
 * （契约 §3.7；Python demo 只处理了 em 标签 + html.unescape）
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return ''
  const withoutTags = raw.replace(/<\/?em[^>]*>/gi, '')
  return htmlUnescape(withoutTags)
}

// --------------------------------------------------------------------------- //
// 原始 JSON → 数据对象
// --------------------------------------------------------------------------- //

/** 安全转整数：无法转换返回 0（NaN/Infinity 一律归零）。 */
function asInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
  }
  return 0
}

/** 安全转字符串。 */
function asString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/**
 * 把 `'6:43'` / `'1:02:03'` 转成秒；解析不了返回 0。
 * @param {unknown} text
 * @returns {number}
 */
export function parseDuration(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.max(0, Math.trunc(text)) : 0
  if (typeof text !== 'string' || !text.trim()) return 0
  let seconds = 0
  for (const part of text.split(':')) {
    const value = Number(part)
    if (!Number.isFinite(value) || value < 0) return 0
    seconds = seconds * 60 + Math.trunc(value)
  }
  return seconds
}

/**
 * 把搜索结果里的一条 item 清洗成 VideoStat。
 * @param {Record<string, unknown>} item
 * @returns {{
 *   bvid: string, title: string, author: string, play: number, like: number,
 *   favorite: number, reply: number, danmaku: number, pubdate: number,
 *   duration_sec: number, type_name: string, tag: string,
 * }}
 */
export function parseVideo(item) {
  const source = item && typeof item === 'object' ? item : {}
  return {
    bvid: asString(source.bvid),
    title: cleanTitle(source.title),
    author: asString(source.author),
    play: asInt(source.play),
    like: asInt(source.like),
    favorite: asInt(source.favorites),
    reply: asInt(source.review),
    danmaku: asInt(source.danmaku) || asInt(source.video_review),
    pubdate: asInt(source.pubdate),
    duration_sec: parseDuration(source.duration),
    type_name: asString(source.typename),
    tag: htmlUnescape(asString(source.tag)),
  }
}

/**
 * 解析搜索接口 payload：返回 (窗口内命中总数, 视频列表)。
 * @param {object} payload 接口完整 payload（`{code,data}`）
 * @returns {{numResults:number, videos:Array<ReturnType<typeof parseVideo>>}}
 */
export function parseSearchPayload(payload) {
  const data = payload && typeof payload === 'object' ? payload.data : null
  const safeData = data && typeof data === 'object' ? data : {}
  const numResults = Math.max(0, asInt(safeData.numResults))
  const items = Array.isArray(safeData.result) ? safeData.result : []
  const videos = items.filter((item) => item && typeof item === 'object').map(parseVideo)
  return { numResults, videos }
}

/** 视频去重 key：优先 bvid，缺失时用 标题|发布时间。 */
function videoKey(video) {
  return video.bvid || `${video.title}|${video.pubdate}`
}

/**
 * 按 bvid 去重合并多页结果。
 * @param {Array<Array<ReturnType<typeof parseVideo>>>} pages
 * @returns {Array<ReturnType<typeof parseVideo>>}
 */
export function mergeVideos(pages) {
  const merged = []
  const seen = new Set()
  for (const page of pages) {
    for (const video of page) {
      const key = videoKey(video)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(video)
    }
  }
  return merged
}

// --------------------------------------------------------------------------- //
// 抓取
// --------------------------------------------------------------------------- //

/**
 * 单页搜索：普通接口失败时自动退回 wbi 签名接口。
 * @returns {Promise<{numResults:number, videos:Array<object>}>}
 */
async function searchPage(client, keyword, order, cfg, timeFilter, page, signal) {
  const params = buildSearchParams(keyword, order, cfg, page, timeFilter)
  try {
    const payload = await client.getJson(SEARCH_TYPE_PATH, params, { signal })
    return parseSearchPayload(payload)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    // 普通接口失败（含非风控的业务错误）→ 回退 wbi 签名接口
    const payload = await client.getJson(SEARCH_TYPE_PATH_WBI, params, { signed: true, signal })
    return parseSearchPayload(payload)
  }
}

/**
 * 抓取多页并去重，返回 (命中总数, 去重样本, 实际页数)。
 *
 * 提前终止：空页 / 不足一页 / 整页重复 / 已凑满 numResults。
 */
async function fetchPages(client, keyword, order, cfg, timeFilter, maxPages, options) {
  const { signal, warnings, label } = options
  const pageLimit = Math.max(1, Math.trunc(maxPages))
  let numResults = 0
  let pagesFetched = 0
  const merged = []
  const seen = new Set()

  for (let page = 1; page <= pageLimit; page += 1) {
    let parsed
    try {
      parsed = await searchPage(client, keyword, order, cfg, timeFilter, page, signal)
    } catch (error) {
      if (error?.name === 'AbortError' || page === 1) throw error
      warnings.push(`${label}采样第 ${page} 页失败（${shortReason(error)}），样本可能偏少`)
      break
    }
    const videos = parsed.videos
    if (page === 1) numResults = parsed.numResults
    if (videos.length === 0) break

    pagesFetched += 1
    let added = 0
    for (const video of videos) {
      const key = videoKey(video)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(video)
      added += 1
    }
    if (videos.length < cfg.sampling.pageSize) break // 已到最后一页
    if (added === 0) break // 整页都是重复，再翻也没有新内容
    if (numResults > 0 && merged.length >= numResults) break // 已凑满窗口内全部结果
  }

  return { numResults, videos: merged, pagesFetched }
}

/** 把错误压成一句短原因，便于写进 warning。 */
function shortReason(error) {
  const text = error instanceof Error ? error.message : String(error ?? '未知错误')
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** 读取配置里的默认窗口天数（配置已由 resolveConfig 兜底）。 */
function defaultWindowDays(cfg) {
  const key = cfg?.defaults?.window
  if (key && cfg.windows && Object.hasOwn(cfg.windows, key)) return Number(cfg.windows[key])
  return 7
}

/**
 * 抓取一个话题在指定时间窗内的双向多页采样。
 *
 * @param {import('./client.js').BiliClient} client
 * @param {string} keyword 话题关键词
 * @param {object} cfg resolveConfig 后的配置
 * @param {{
 *   windowDays?: number,
 *   windowPreset?: string,
 *   stockPages?: number,
 *   flowPages?: number,
 *   signal?: AbortSignal,
 *   warnings?: string[],
 * }} [options]
 * @returns {Promise<object>} TopicSample
 */
export async function fetchTopicSample(client, keyword, cfg, options = {}) {
  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : defaultWindowDays(cfg)
  const stockPages = Number.isFinite(options.stockPages) ? options.stockPages : cfg.sampling.stockPages
  const flowPages = Number.isFinite(options.flowPages) ? options.flowPages : cfg.sampling.flowPages
  const signal = options.signal
  const warnings = Array.isArray(options.warnings) ? options.warnings : []

  // 窗口参数只算一次：两种排序必须用同一个端点，避免跨刻钟导致窗口错位
  const windowParams = buildWindowParams(windowDays, Date.now())
  const timeFilter = toSearchTimeFilter(windowParams)

  const stock = await fetchPages(client, keyword, ORDER_STOCK, cfg, timeFilter, stockPages, {
    signal,
    warnings,
    label: '存量样本',
  })

  const recent = []
  let flowUsed = 0
  if (stock.numResults > 0) {
    try {
      const flow = await fetchPages(client, keyword, ORDER_FLOW, cfg, timeFilter, flowPages, {
        signal,
        warnings,
        label: '最新样本',
      })
      recent.push(...flow.videos)
      flowUsed = flow.pagesFetched
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      warnings.push(`最新内容采样失败（${shortReason(error)}），更新速度记 0`)
    }
  }

  return {
    keyword,
    numResults: stock.numResults,
    videos: stock.videos,
    recent,
    windowDays,
    windowPreset: options.windowPreset ?? null,
    // 毫秒时间戳：与 fetchedAt 保持同一单位，评分模块内部换算
    windowStart: windowParams.begin > 0 ? windowParams.begin * 1000 : 0,
    windowEnd: windowParams.end > 0 ? windowParams.end * 1000 : 0,
    stockPages: stock.pagesFetched,
    flowPages: flowUsed,
    fetchedAt: client.lastFetchedAt || Date.now(),
    source: 'live',
    warnings,
  }
}

/**
 * 抓取 B 站热搜榜（一次请求，默认缓存一小时）。
 * @param {import('./client.js').BiliClient} client
 * @param {number} [limit]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{keyword:string, heatScore:number, rank:number}>>}
 */
export async function fetchHotSearch(client, limit = 50, options = {}) {
  const payload = await client.getJson(HOT_SEARCH_PATH, { limit }, { signal: options.signal })
  const data = payload && typeof payload === 'object' ? payload.data : null
  const safeData = data && typeof data === 'object' ? data : {}
  const trending = safeData.trending && typeof safeData.trending === 'object' ? safeData.trending : {}
  const list = Array.isArray(trending.list)
    ? trending.list
    : Array.isArray(safeData.list)
      ? safeData.list
      : []
  const items = []
  let rank = 0
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const keyword = asString(entry.keyword || entry.show_name).trim()
    if (!keyword) continue
    rank += 1
    items.push({ keyword, heatScore: Math.max(0, asInt(entry.heat_score)), rank })
  }
  return items
}

/**
 * 构造搜索请求参数（导出便于测试对齐契约 §3）：显式 order + 窗口端点参数。
 * @param {string} keyword
 * @param {'click'|'pubdate'} order
 * @param {object} cfg
 * @param {number} page
 * @param {{begin:number,end:number}|Record<string, number>} windowParams 窗口端点或已转换的 timeFilter
 */
export function buildSearchParams(keyword, order, cfg, page, windowParams) {
  const timeFilter =
    windowParams && ('pubtime_begin_s' in windowParams || 'pubtime_end_s' in windowParams)
      ? windowParams
      : toSearchTimeFilter(windowParams)
  return {
    search_type: 'video',
    keyword,
    page,
    page_size: cfg.sampling.pageSize,
    order,
    ...timeFilter,
  }
}

// 保持 BiliApiError 的具名导出，方便上层按类型判断（signals 的调用方无需再 import client）
export { BiliApiError }
