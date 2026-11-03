/**
 * 共享的请求控制与采样规模配置：默认值、字段规格、解析兜底。
 *
 * 这一组配置被 bundle 内所有要访问 B 站接口的插件共用（同一套限速 / 预算 /
 * 缓存语义），因此放在 shared；插件私有的配置（锚点、权重、评级等）留在各自
 * 的 config.js。
 *
 * @module dsh-bilibili-bundle/shared/http
 */

import os from 'node:os'
import path from 'node:path'

import { deepFreeze, deepMerge, pickNumber, pickString, sanitizeNumberGroup } from './validate.js'

/** 默认 User-Agent：实测可用的普通浏览器 UA（裸 UA 会直接 412）。 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * 共享的请求控制默认值（深冻结）。
 * 注意：`request.cacheDir` 为空字符串表示「用系统临时目录下的默认缓存目录」，
 * 实际路径由 {@link resolveCacheDir} 解析。
 */
export const DEFAULT_REQUEST_CONFIG = deepFreeze({
  intervalMs: 2000, // 两次请求最小间隔
  timeoutMs: 15000, // 单次请求超时
  maxRetries: 3, // 风控退避重试次数
  maxRequests: 60, // 单次工具调用的 HTTP 请求预算（含 Cookie 引导）
  cacheTtlSeconds: 3600, // 磁盘缓存有效期
  cacheDir: '', // 空 → os.tmpdir()/dsh-bilibili-cache
  userAgent: DEFAULT_USER_AGENT,
})

/** 共享的采样规模默认值（深冻结）。 */
export const DEFAULT_SAMPLING_CONFIG = deepFreeze({
  pageSize: 50, // 单页条数（实测 50 可用）
  stockPages: 3, // 存量排序（order=click）翻页数
  flowPages: 3, // 增量排序（order=pubdate）翻页数
  headSize: 50, // 进入规模类分量的头部 K 条
  minSample: 5, // 头部样本少于该数量时告警
})

/** request 分组的字段规格。 */
const REQUEST_SPECS = {
  intervalMs: [0, 60000, true],
  timeoutMs: [100, 120000, true],
  maxRetries: [0, 10, true],
  maxRequests: [1, 1000, true],
  cacheTtlSeconds: [0, 604800, true],
}

/** sampling 分组的字段规格。 */
const SAMPLING_SPECS = {
  pageSize: [1, 50, true],
  stockPages: [1, 10, true],
  flowPages: [1, 10, true],
  headSize: [1, 200, true],
  minSample: [0, 200, true],
}

/**
 * 解析共享的 { request, sampling } 配置：深合并默认值并做类型/范围兜底，
 * 任何非法输入都回退默认值，绝不抛错。
 *
 * @param {unknown} [userConfig] 插件 config（取其中的 request / sampling 字段）
 * @returns {{ request: typeof DEFAULT_REQUEST_CONFIG, sampling: typeof DEFAULT_SAMPLING_CONFIG }}
 */
export function resolveHttpConfig(userConfig) {
  const user = userConfig && typeof userConfig === 'object' ? userConfig : {}
  const mergedRequest = deepMerge(DEFAULT_REQUEST_CONFIG, user.request)
  const mergedSampling = deepMerge(DEFAULT_SAMPLING_CONFIG, user.sampling)

  const request = sanitizeNumberGroup(DEFAULT_REQUEST_CONFIG, mergedRequest, REQUEST_SPECS)
  const sampling = sanitizeNumberGroup(DEFAULT_SAMPLING_CONFIG, mergedSampling, SAMPLING_SPECS)

  // cacheDir / userAgent 是字符串字段，单独兜底
  request.cacheDir =
    typeof mergedRequest.cacheDir === 'string' ? mergedRequest.cacheDir.trim() : ''
  request.userAgent = pickString(mergedRequest.userAgent, DEFAULT_USER_AGENT, { maxLength: 500 })

  return { request, sampling }
}

/**
 * 解析磁盘缓存目录：空字符串 → `os.tmpdir()/dsh-bilibili-cache`。
 * 整个 bundle 共用一个缓存目录（key 已含接口路径，插件间不会互相覆盖）；
 * 这里只做路径归一化（不 mkdir），目录创建由 BiliClient 负责。
 * @param {string} cacheDir
 * @returns {string}
 */
export function resolveCacheDir(cacheDir) {
  if (typeof cacheDir === 'string' && cacheDir.trim()) return cacheDir.trim()
  return path.join(os.tmpdir(), 'dsh-bilibili-cache')
}
