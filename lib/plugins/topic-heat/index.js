/**
 * topic-heat 插件入口：向 `ctx.tools` 注册 `bili_topic_heat`。
 *
 * 这是 bundle 的一个插件行（cordis.patch.yml 里
 * `name: dsh-bilibili-bundle/plugins/topic-heat` 所指）；B 站请求基础设施
 * （BiliClient / 限速 / 缓存）在共享层 lib/shared/。
 *
 * 工具只暴露两个参数（topic / window），其余全部来自插件 config（契约 §5）。
 * 一次调用：`BiliClient` → 热搜榜（失败不阻断）→ 双采样 → 评分 → 结构化 value + 中文文本。
 *
 * @module dsh-bilibili-bundle/plugins/topic-heat
 */

import { BiliClient } from '../../shared/client.js'
import { BiliApiError, RISK_CODES } from '../../shared/errors.js'
import { DEFAULT_CONFIG, resolveConfig, windowKeysFor, windowLabel } from './config.js'
import { renderReport, toToolValue } from './format.js'
import { scoreTopic } from './scoring.js'
import { fetchHotSearch, fetchTopicSample } from './signals.js'

/** 插件行标识（与 cordis.patch.yml 的 id 一致）。 */
export const name = 'bilibili-topic-heat'

/** 工具注册表必须先存在。 */
export const inject = ['tools']

/** 工具名（模型可见）。 */
const TOOL_NAME = 'bili_topic_heat'

/** topic 长度上限（防御超长关键词，同时也是搜索接口的合理边界）。 */
const MAX_TOPIC_LENGTH = 80

// --------------------------------------------------------------------------- //
// 错误信息（中文、≤200 字、可操作）
// --------------------------------------------------------------------------- //

/**
 * 把内部错误翻译成模型可读的中文错误（契约 §6：≤200 字、可操作）。
 * @param {unknown} error
 * @returns {Error}
 */
function describeError(error) {
  if (error?.name === 'AbortError') return new Error('B站话题热度查询已取消。')

  const reason = error instanceof Error ? error.message : String(error ?? '未知错误')
  let hint = '请稍后重试；若持续失败，可检查网络/代理，或增大 config.request.intervalMs。'
  if (error instanceof BiliApiError || error?.name === 'BiliApiError') {
    if (error.httpStatus === 412 || error.httpStatus === 429 || RISK_CODES.has(error.code)) {
      hint = 'B 站触发了风控，请等待几分钟再试；可增大 config.request.intervalMs 降低请求频率。'
    } else if (error.code === 'BUDGET') {
      hint = '请求预算已用尽，请稍后再试，或提高 config.request.maxRequests。'
    } else if (error.code === 'TIMEOUT') {
      hint = '网络请求超时，请检查网络/代理后重试。'
    } else if (error.code === 'NETWORK') {
      hint = '无法连接 B 站接口，请检查网络/代理后重试。'
    }
  }
  let message = `B站话题热度查询失败：${reason}。${hint}`
  if (message.length > 200) message = `${message.slice(0, 199)}…`
  return new Error(message)
}

// --------------------------------------------------------------------------- //
// output.schema（契约 §6 的完整描述）
// --------------------------------------------------------------------------- //

/**
 * 构造 output.schema。字段与 {@link toToolValue} 严格一致；
 * 所有 object 节点 additionalProperties=false，数组节点带 items。
 */
function buildOutputSchema() {
  const videoSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: '视频标题（已清洗 HTML 标签与实体）' },
      author: { type: 'string', description: 'UP 主昵称' },
      play: { type: 'integer', description: '播放量' },
      like: { type: 'integer', description: '点赞数' },
      pubdate: { type: 'integer', description: '发布时间（unix 秒）' },
      url: { type: 'string', description: '视频地址 https://www.bilibili.com/video/<bvid>' },
    },
    required: ['title', 'author', 'play', 'like', 'pubdate', 'url'],
  }

  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      topic: { type: 'string', description: '查询的话题关键词' },
      window: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { type: 'string', description: '窗口预设键，如 1d / 7d / 1m / 90' },
          days: { type: 'integer', description: '窗口天数' },
          label: { type: 'string', description: '人类可读的窗口标签，如 近7天' },
          start: { type: 'string', description: '窗口开始时刻（ISO 8601，已按 900s 量化）' },
          end: { type: 'string', description: '窗口结束时刻（ISO 8601，已按 900s 量化）' },
        },
        required: ['preset', 'days', 'label', 'start', 'end'],
      },
      asOf: { type: 'string', description: '数据抓取时刻（ISO 8601）' },
      heat: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', description: '最终热度指数 0~100（含热搜加成）' },
          tier: { type: 'string', description: '评级：爆 / 热 / 温 / 冷 / 凉' },
          baseIndex: { type: 'number', description: '基础指数（含相关性惩罚，不含热搜加成）' },
          hotBonus: { type: 'number', description: '热搜榜加成（0~hotBonusMax）' },
        },
        required: ['index', 'tier', 'baseIndex', 'hotBonus'],
      },
      models: {
        type: 'array',
        description: '四个模型的基础分（不含热搜加成）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'composite / discussion / momentum / scale' },
            name: { type: 'string', description: '模型中文名' },
            index: { type: 'number', description: '模型指数 0~100' },
            tier: { type: 'string', description: '该模型指数的评级' },
            summary: { type: 'string', description: '一句人话解释' },
          },
          required: ['id', 'name', 'index', 'tier', 'summary'],
        },
      },
      consensus: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mean: { type: 'number', description: '四个模型分的均值' },
          min: { type: 'number', description: '四个模型分的最小值' },
          max: { type: 'number', description: '四个模型分的最大值' },
          spread: { type: 'number', description: '分歧度 = max - min' },
          agreement: { type: 'string', description: '一致 / 基本一致 / 分歧' },
        },
        required: ['mean', 'min', 'max', 'spread', 'agreement'],
      },
      components: {
        type: 'array',
        description: '7 个分量的可解释中间结果',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'play / engagement / rate / peak / velocity / supply / relevance' },
            name: { type: 'string', description: '分量中文名' },
            raw: { type: 'number', description: '归一化前的原始值' },
            normalized: { type: 'number', description: '归一化到 0~1 的值' },
            weight: { type: 'number', description: '在综合模型里的权重' },
            points: { type: 'number', description: '贡献分 = normalized * weight * 100' },
          },
          required: ['id', 'name', 'raw', 'normalized', 'weight', 'points'],
        },
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sampleSize: { type: 'integer', description: '存量样本（去重后）条数' },
          recentSize: { type: 'integer', description: '最新内容样本条数' },
          headSize: { type: 'integer', description: '参与热度计算的头部条数' },
          numResults: { type: 'integer', description: '窗口内搜索命中总数（服务端封顶 1000）' },
          velocityPerDay: { type: 'number', description: '更新速度（条/天）' },
          relevance: { type: 'number', description: '相关性比例 0~1' },
          hotRank: {
            description: '热搜榜排名；未上榜为 null',
            oneOf: [{ type: 'integer' }, { type: 'null' }],
          },
          hotBonus: { type: 'number', description: '热搜加成' },
          medianPlay: { type: 'integer', description: '全量样本播放中位数' },
          p90Play: { type: 'integer', description: '全量样本 P90' },
          authors: { type: 'integer', description: '去重 UP 主数量' },
        },
        required: [
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
        ],
      },
      topVideos: {
        type: 'array',
        description: '按播放降序的代表视频',
        items: videoSchema,
      },
      warnings: {
        type: 'array',
        description: '降级/置信度警告（可能有空数组）',
        items: { type: 'string' },
      },
      source: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engine: { type: 'string', description: '数据引擎标识，固定 bilibili-search' },
          fetchedAt: { type: 'string', description: '数据抓取时刻（ISO 8601）' },
          cached: { type: 'boolean', description: '本次是否有磁盘缓存命中（cacheHits>0）' },
          requests: { type: 'integer', description: '本次实际发出的数据请求次数（正常 7）' },
        },
        required: ['engine', 'fetchedAt', 'cached', 'requests'],
      },
    },
    required: [
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
    ],
  }
}

// --------------------------------------------------------------------------- //
// 工具定义
// --------------------------------------------------------------------------- //

/**
 * 构造工具定义（独立出来便于离线单测直接调用 execute）。
 * @param {object} cfg resolveConfig 后的配置
 */
function buildToolDefinition(cfg) {
  const windowKeys = windowKeysFor(cfg)
  const defaultWindow = Object.hasOwn(cfg.windows, cfg.defaults.window)
    ? cfg.defaults.window
    : windowKeys[0]
  const windowDescription = `时间跨度：${windowKeys
    .map((key) => `${key}=${windowLabel(key, cfg.windows[key])}`)
    .join('，')}；默认 ${defaultWindow}`

  return {
    name: TOOL_NAME,
    description:
      '查询单个 B 站话题在指定时间跨度内的热度指数。' +
      '返回综合热度（0~100）与 4 个模型分（综合/讨论/动量/规模）、7 个分量、证据与代表视频。' +
      '数据来自 B 站搜索的双向采样（最多播放 + 最新发布），不是官方指数，适合判断话题当前热度。' +
      '只支持单个关键词，不支持逗号分隔的多个话题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          description: '单个 B 站话题关键词，例如 原神；不支持多个话题/逗号分隔',
        },
        window: {
          type: 'string',
          enum: windowKeys,
          default: defaultWindow,
          description: windowDescription,
        },
      },
      required: ['topic'],
    },
    output: {
      schema: buildOutputSchema(),
      render(_args, value) {
        return [{ type: 'text', text: renderReport(value, cfg) }]
      },
    },
    // 协作式超时预算：正常一次调用约 15~20s，给风控退避留足余量；
    // execute 会把 exec.signal 透传给 fetch / sleep，超时能及时收敛。
    timeoutMs: 90000,
    async execute(args, exec) {
      const topic = typeof args?.topic === 'string' ? args.topic.trim() : ''
      if (!topic) {
        throw new Error('topic 不能为空：请提供单个 B 站话题关键词，例如 原神。')
      }
      if (topic.length > MAX_TOPIC_LENGTH) {
        throw new Error(
          `topic 过长（${topic.length} 字）：请提供不超过 ${MAX_TOPIC_LENGTH} 字的单个话题关键词，不支持多个话题。`,
        )
      }

      const requestedWindow = args?.window === undefined ? defaultWindow : args.window
      if (typeof requestedWindow !== 'string' || !Object.hasOwn(cfg.windows, requestedWindow)) {
        throw new Error(
          `window 不合法：${String(requestedWindow)}。可用值：${windowKeys.join(' / ')}；默认 ${defaultWindow}。`,
        )
      }
      const windowDays = Number(cfg.windows[requestedWindow])
      if (!Number.isFinite(windowDays) || windowDays <= 0) {
        throw new Error(`window=${requestedWindow} 的配置天数非法，请检查插件 config.windows。`)
      }

      const signal = exec?.signal
      const client = new BiliClient(cfg, { signal })
      const extraWarnings = []

      // 热搜榜：失败不阻断主流程，降级为 warning
      let hotItems = []
      try {
        hotItems = await fetchHotSearch(client, 50, { signal })
      } catch (error) {
        if (error?.name === 'AbortError') throw describeError(error)
        const reason = error instanceof Error ? error.message : String(error)
        extraWarnings.push(`热搜榜抓取失败（${clip(reason, 60)}），未叠加热搜加成`)
      }

      // 双向采样：失败必须变成明确错误（不允许静默返回空结构）
      let sample
      try {
        sample = await fetchTopicSample(client, topic, cfg, {
          windowDays,
          windowPreset: requestedWindow,
          signal,
          warnings: extraWarnings,
        })
      } catch (error) {
        throw describeError(error)
      }

      const report = scoreTopic(sample, hotItems, cfg)
      report.warnings = [...report.warnings, ...extraWarnings]
      report.source = {
        requests: client.requestCount,
        cached: client.cacheHits > 0,
      }

      return toToolValue(report, cfg)
    },
  }
}

/** 截断一段文本（用于 warning 里的短原因）。 */
function clip(text, maxLength) {
  const chars = [...String(text ?? '')]
  return chars.length <= maxLength ? chars.join('') : `${chars.slice(0, maxLength - 1).join('')}…`
}

/**
 * 插件入口：解析配置并注册工具。
 * @param {object} ctx Cordis 插件上下文（需要 `ctx.tools`）
 * @param {object} [config] 插件 config（cordis.patch.yml 的 config 段）
 * @returns {() => void} 反注册 disposer
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config ?? DEFAULT_CONFIG)
  return ctx.tools.register(buildToolDefinition(cfg))
}

/** 导出内部构造函数便于离线测试（不属于契约面）。 */
export { buildToolDefinition }
