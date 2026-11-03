/**
 * topic-heat 插件私有配置：默认值、深合并、非法值兜底，以及展示标签工具。
 *
 * 只放本插件独有的配置（窗口预设、归一化锚点、模型权重、评级阈值、输出裁剪）；
 * 请求控制 / 采样规模在共享层 {@link module:dsh-bilibili-bundle/shared/http}，
 * 通用窗口解析在共享层 {@link module:dsh-bilibili-bundle/shared/windows}。
 *
 * `resolveConfig` 面向从 cordis.patch.yml / 插件 settings 传进来的普通对象，
 * 所有校验都是「手写的、必须不抛错」：非法值一律回退默认值。
 *
 * @module dsh-bilibili-bundle/plugins/topic-heat/config
 */

import { resolveHttpConfig } from '../../shared/http.js'
import { formatWindow } from '../../shared/windows.js'
import {
  deepClone,
  deepFreeze,
  deepMerge,
  isPlainObject,
  pickNumber,
  sanitizeNumberGroup,
} from '../../shared/validate.js'

/**
 * 插件默认配置（深冻结，防止被误改）。
 * request / sampling 两个分组来自共享层，见 shared/http.js。
 */
export const DEFAULT_CONFIG = deepFreeze({
  // 工具参数默认值：默认时间窗口键
  defaults: {
    window: '7d',
  },
  // 可用的时间窗口：键是工具参数的 enum 值，值是天数
  windows: {
    '1d': 1,
    '7d': 7,
    '1m': 30,
    '90': 90,
  },
  // 归一化锚点
  anchors: {
    playLogFloor: 4.4,
    playLogCeil: 7.6,
    engLogFloor: 2.8,
    engLogCeil: 6.5,
    peakLogFloor: 5.0,
    peakLogCeil: 7.85,
    rate: 0.13,
    supply: 1000,
    velocity: 4000,
    supplySaturatedValue: 1.0,
  },
  // 互动权重（成本越高权重越大）
  engagementWeights: {
    like: 1,
    favorite: 2,
    reply: 2,
    danmaku: 3,
  },
  // 四个模型的权重（键对应契约 §4.1 的 7 个分量）
  modelWeights: {
    composite: { play: 0.18, engagement: 0.22, rate: 0.15, peak: 0.1, velocity: 0.2, supply: 0.05, relevance: 0.1 },
    discussion: { engagement: 0.4, rate: 0.35, peak: 0.1, relevance: 0.15 },
    momentum: { velocity: 0.55, supply: 0.25, relevance: 0.2 },
    scale: { play: 0.45, peak: 0.3, supply: 0.25 },
  },
  // 相关性软惩罚
  relevance: {
    floor: 0.3,
    penalty: 0.6,
  },
  hotBonusMax: 8, // 热搜榜加成上限（加法）
  // 评级阈值：从高到低
  tiers: [
    { label: '爆', min: 75 },
    { label: '热', min: 60 },
    { label: '温', min: 45 },
    { label: '冷', min: 30 },
  ],
  // 输出规模限制
  output: {
    topVideos: 5,
    maxWarnings: 6,
  },
})

// --------------------------------------------------------------------------- //
// 窗口展示标签（插件私有：preset → 标签的契约映射）
// --------------------------------------------------------------------------- //

/**
 * 窗口 preset → 展示标签的固定映射（契约 §6/§7，Lead 定稿）。
 * 注意 90 天必须显示「近90天」，而不是通用天数格式会得到的「近3个月」。
 */
export const WINDOW_PRESET_LABELS = Object.freeze({
  '1d': '近1天',
  '7d': '近7天',
  '1m': '近1个月',
  '90': '近90天',
})

/** 窗口键的契约顺序（数字型键在对象里会被提前，enum 顺序需要单独保证）。 */
export const WINDOW_ORDER = Object.freeze(['1d', '7d', '1m', '90'])

/**
 * 返回配置里可用的窗口键，顺序稳定：先契约顺序，再追加用户自定义键。
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {string[]}
 */
export function windowKeysFor(cfg) {
  const windows = cfg && typeof cfg === 'object' && cfg.windows ? cfg.windows : DEFAULT_CONFIG.windows
  const ordered = WINDOW_ORDER.filter((key) => Object.hasOwn(windows, key))
  for (const key of Object.keys(windows)) {
    if (!ordered.includes(key)) ordered.push(key)
  }
  return ordered
}

/**
 * 取窗口展示标签：优先按 preset 固定映射；自定义窗口回退通用天数格式。
 * @param {string|null|undefined} preset
 * @param {number} days
 * @returns {string}
 */
export function windowLabel(preset, days) {
  if (typeof preset === 'string' && Object.hasOwn(WINDOW_PRESET_LABELS, preset)) {
    return WINDOW_PRESET_LABELS[preset]
  }
  return formatWindow(days)
}

// --------------------------------------------------------------------------- //
// 元数据
// --------------------------------------------------------------------------- //

/** 四个模型的固定顺序与中文名（契约 §4.2）。 */
export const MODEL_META = Object.freeze([
  { id: 'composite', name: '综合热度' },
  { id: 'discussion', name: '讨论热度' },
  { id: 'momentum', name: '近期动量' },
  { id: 'scale', name: '消费规模' },
])

/** 7 个分量的固定顺序与中文名（契约 §4.1）。 */
export const COMPONENT_META = Object.freeze([
  { id: 'play', name: '播放规模' },
  { id: 'engagement', name: '互动总量' },
  { id: 'rate', name: '互动密度' },
  { id: 'peak', name: '爆款强度' },
  { id: 'velocity', name: '更新速度' },
  { id: 'supply', name: '搜索供给' },
  { id: 'relevance', name: '相关性' },
])

// --------------------------------------------------------------------------- //
// 清洗函数
// --------------------------------------------------------------------------- //

/** anchors 分组的字段规格（对数类锚点范围放宽，只要求有限数且 ceil > floor）。 */
const ANCHOR_SPECS = {
  playLogFloor: [-20, 20],
  playLogCeil: [-20, 20],
  engLogFloor: [-20, 20],
  engLogCeil: [-20, 20],
  peakLogFloor: [-20, 20],
  peakLogCeil: [-20, 20],
  rate: [1e-6, 1000],
  supply: [1, 1e9, true],
  velocity: [1e-6, 1e9],
  supplySaturatedValue: [0, 1],
}

/**
 * 清洗 `windows`：以默认窗口为底，允许用户新增/覆盖窗口键。
 * 非法键值（非正整数天数）静默跳过，保留默认值。
 */
function sanitizeWindows(userWindows) {
  const out = { ...DEFAULT_CONFIG.windows }
  if (!isPlainObject(userWindows)) return out
  for (const [rawKey, rawDays] of Object.entries(userWindows)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key || key.length > 16) continue
    const days = pickNumber(rawDays, NaN, 1, 3650, { integer: true })
    if (!Number.isFinite(days)) continue
    out[key] = days
  }
  // 理论上至少有默认键；若默认键被覆盖为非法值，out 仍保留默认天数
  return out
}

/** 清洗 `modelWeights`：每个模型已知分量逐项兜底；权重和 <= 0 时回退该模型默认值。 */
function sanitizeModelWeights(userWeights) {
  const out = {}
  const source = isPlainObject(userWeights) ? userWeights : {}
  for (const { id } of MODEL_META) {
    const defaults = DEFAULT_CONFIG.modelWeights[id]
    const merged = isPlainObject(source[id]) ? deepMerge(defaults, source[id]) : deepClone(defaults)
    const weights = {}
    let total = 0
    for (const [key, fallback] of Object.entries(defaults)) {
      weights[key] = pickNumber(merged[key], fallback, 0, 100)
      total += weights[key]
    }
    out[id] = total > 0 ? weights : deepClone(defaults)
  }
  return out
}

/** 清洗互动权重：like/favorite/reply/danmaku 逐项兜底。 */
function sanitizeEngagementWeights(userWeights) {
  const defaults = DEFAULT_CONFIG.engagementWeights
  const merged = isPlainObject(userWeights) ? deepMerge(defaults, userWeights) : deepClone(defaults)
  const out = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    out[key] = pickNumber(merged[key], fallback, 0, 100)
  }
  return out
}

/** 清洗评级阈值数组：从高到低排序；整体非法时回退默认值。 */
function sanitizeTiers(userTiers) {
  const source = Array.isArray(userTiers) ? userTiers : []
  const tiers = []
  for (const entry of source) {
    if (!isPlainObject(entry)) continue
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const min = pickNumber(entry.min, NaN, 0, 100)
    if (!label || label.length > 4 || !Number.isFinite(min)) continue
    tiers.push({ label, min })
  }
  if (tiers.length === 0) return deepClone(DEFAULT_CONFIG.tiers)
  tiers.sort((a, b) => b.min - a.min)
  return tiers
}

// --------------------------------------------------------------------------- //
// resolveConfig
// --------------------------------------------------------------------------- //

/**
 * 深合并默认配置并做类型/范围兜底；**任何非法输入都回退默认值，绝不抛错**。
 *
 * @param {unknown} [userConfig] cordis config 或任意普通对象
 * @returns {typeof DEFAULT_CONFIG} 新的、可安全使用的配置对象
 *   （含共享层解析出的 request / sampling 分组）
 */
export function resolveConfig(userConfig) {
  const user = isPlainObject(userConfig) ? userConfig : {}
  const merged = deepMerge(DEFAULT_CONFIG, user)
  const http = resolveHttpConfig(user)

  const cfg = {
    defaults: { window: DEFAULT_CONFIG.defaults.window },
    windows: sanitizeWindows(user.windows),
    sampling: http.sampling,
    request: http.request,
    anchors: sanitizeNumberGroup(DEFAULT_CONFIG.anchors, merged.anchors, ANCHOR_SPECS),
    engagementWeights: sanitizeEngagementWeights(user.engagementWeights),
    modelWeights: sanitizeModelWeights(user.modelWeights),
    relevance: {
      floor: pickNumber(merged.relevance?.floor, DEFAULT_CONFIG.relevance.floor, 0, 1),
      penalty: pickNumber(merged.relevance?.penalty, DEFAULT_CONFIG.relevance.penalty, 0, 1),
    },
    hotBonusMax: pickNumber(merged.hotBonusMax, DEFAULT_CONFIG.hotBonusMax, 0, 50),
    tiers: sanitizeTiers(user.tiers),
    output: {
      topVideos: pickNumber(merged.output?.topVideos, DEFAULT_CONFIG.output.topVideos, 1, 10, { integer: true }),
      maxWarnings: pickNumber(merged.output?.maxWarnings, DEFAULT_CONFIG.output.maxWarnings, 0, 20, { integer: true }),
    },
  }

  // 对数锚点必须 ceil > floor，否则 band 归一化无意义
  if (!(cfg.anchors.playLogCeil > cfg.anchors.playLogFloor)) {
    cfg.anchors.playLogFloor = DEFAULT_CONFIG.anchors.playLogFloor
    cfg.anchors.playLogCeil = DEFAULT_CONFIG.anchors.playLogCeil
  }
  if (!(cfg.anchors.engLogCeil > cfg.anchors.engLogFloor)) {
    cfg.anchors.engLogFloor = DEFAULT_CONFIG.anchors.engLogFloor
    cfg.anchors.engLogCeil = DEFAULT_CONFIG.anchors.engLogCeil
  }
  if (!(cfg.anchors.peakLogCeil > cfg.anchors.peakLogFloor)) {
    cfg.anchors.peakLogFloor = DEFAULT_CONFIG.anchors.peakLogFloor
    cfg.anchors.peakLogCeil = DEFAULT_CONFIG.anchors.peakLogCeil
  }

  // defaults.window 必须是 windows 里存在的键；否则回退到 7d / 第一个键
  const requested = typeof merged.defaults?.window === 'string' ? merged.defaults.window.trim() : ''
  if (requested && Object.hasOwn(cfg.windows, requested)) {
    cfg.defaults.window = requested
  } else if (Object.hasOwn(cfg.windows, DEFAULT_CONFIG.defaults.window)) {
    cfg.defaults.window = DEFAULT_CONFIG.defaults.window
  } else {
    cfg.defaults.window = Object.keys(cfg.windows)[0]
  }

  return cfg
}
