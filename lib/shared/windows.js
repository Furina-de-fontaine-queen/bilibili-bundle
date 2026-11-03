/**
 * 共享的时间窗口工具：解析、格式化、900s 端点量化、搜索接口时间过滤参数。
 *
 * 与具体插件无关：任何需要「近 N 天」类窗口语义的插件都可以复用。
 * preset → 展示标签的映射（WINDOW_PRESET_LABELS / windowLabel）属于
 * topic-heat 的展示契约，留在插件自己的 config.js 里。
 *
 * @module dsh-bilibili-bundle/shared/windows
 */

/** 窗口端点量化粒度（秒）：端点对齐到 15 分钟，方便同一刻钟内复用缓存。 */
export const WINDOW_BUCKET_SECONDS = 900

/** 一天秒数。 */
const SECONDS_PER_DAY = 86400

/** 解析窗口预设文本时可直接识别的预设（Python demo 的超集）。 */
const WINDOW_PRESET_DAYS = Object.freeze({
  '1d': 1,
  '7d': 7,
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '12m': 365,
  '1y': 365,
  all: 0,
})

/**
 * 把窗口参数解析成天数：`'1d' / '7d' / '1m' / '90' / 30` → 天数；`'all'` → 0。
 * 与 Python `parse_window` 行为一致：无法解析时抛错（调用方决定是否捕获）。
 * @param {string|number} text
 * @returns {number}
 */
export function parseWindow(text) {
  let days
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) throw new Error('时间窗口必须是数字或字符串，例如 7d / 30')
    days = Math.trunc(text)
  } else if (typeof text === 'string') {
    const raw = text.trim().toLowerCase()
    if (!raw) throw new Error('时间窗口不能为空，可用示例：1d / 7d / 1m / 90')
    if (Object.hasOwn(WINDOW_PRESET_DAYS, raw)) {
      days = WINDOW_PRESET_DAYS[raw]
    } else if (/^\d+$/.test(raw)) {
      days = Number(raw)
    } else {
      const match = /^(\d+)d$/.exec(raw)
      if (!match) {
        throw new Error(
          `无法解析时间窗口 ${JSON.stringify(text)}，可用示例：${Object.keys(WINDOW_PRESET_DAYS).join(' / ')} 或天数（如 30）`,
        )
      }
      days = Number(match[1])
    }
  } else {
    throw new Error('时间窗口必须是字符串，例如 1d / 7d / 1m / 90')
  }
  if (!Number.isFinite(days) || days < 0) throw new Error('时间窗口天数不能为负')
  return days
}

/**
 * 把天数格式化成人类可读标签（与 Python `format_window` 一致）。
 * 例：1 → 近1天；7 → 近7天；30 → 近1个月；90 → 近3个月；0 → 全时段。
 * @param {number} days
 * @returns {string}
 */
export function formatWindow(days) {
  const value = Number(days)
  if (!Number.isFinite(value) || value <= 0) return '全时段'
  const whole = Math.trunc(value)
  if (whole % 365 === 0) return `近${whole / 365}年`
  if (whole % 30 === 0) return `近${whole / 30}个月`
  return `近${whole}天`
}

/**
 * 构造服务端时间过滤参数：端点按 900s 量化，
 * 同一刻钟内重复调用可以命中同一份磁盘缓存。
 *
 * @param {number} windowDays 天数；<=0 表示不限时间（返回 {begin:0,end:0}）
 * @param {number} [nowMs] 当前时间（毫秒时间戳），便于测试注入
 * @returns {{begin:number, end:number}} unix 秒；0 表示无该端点
 */
export function buildWindowParams(windowDays, nowMs = Date.now()) {
  const days = Number(windowDays)
  if (!Number.isFinite(days) || days <= 0) return { begin: 0, end: 0 }
  const rawNow = Number.isFinite(nowMs) ? nowMs : Date.now()
  const endSeconds = Math.floor(rawNow / 1000)
  const end = Math.floor(endSeconds / WINDOW_BUCKET_SECONDS) * WINDOW_BUCKET_SECONDS
  return {
    begin: end - Math.trunc(days) * SECONDS_PER_DAY,
    end,
  }
}

/**
 * 把 {@link buildWindowParams} 的结果转成 B 站搜索接口的别名参数。
 * 全时段（begin/end 都为 0）时返回空对象，即不带时间过滤。
 * @param {{begin:number, end:number}} windowParams
 * @returns {Record<string, number>}
 */
export function toSearchTimeFilter(windowParams) {
  if (!windowParams || !(windowParams.begin > 0) || !(windowParams.end > 0)) return {}
  return {
    pubtime_begin_s: windowParams.begin,
    pubtime_end_s: windowParams.end,
  }
}
