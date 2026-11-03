/**
 * B 站 API 客户端：Cookie 引导、wbi 签名、全局限速、磁盘缓存、风控退避重试。
 *
 * bundle 内所有访问 B 站接口的插件共用的基础设施，本身不是插件（没有 apply），
 * 不注册任何工具 / 服务。只用 Node 内置模块（node:crypto / node:fs / node:path），
 * 是 Python demo `biliheat/client.py` 的忠实移植，并补充了：
 *   - 实例级 + 全局（跨实例）限速；
 *   - 请求预算只统计「数据请求」为 requestCount（正常一次工具调用 7 次 = 3+3+1），
 *     Cookie 引导与 wbi 密钥请求计入 httpRequests 预算但不算进 source.requests；
 *   - fetch 使用 AbortSignal 合并调用方取消与单请求超时；
 *   - 缓存命中计数 cacheHits 与「本次是否命中缓存」标记。
 *
 * ⚠️ 限速器是模块级单例（下方 throttleChain / globalLastRequestAt）：它跨 BiliClient
 * 实例、跨插件生效，语义是「整个 dsh 进程对 B 站任意两次请求间隔 >= intervalMs」。
 * 这是有意的——对同一站点必须共用同一个限速器——但它是 per-process 的。
 *
 * 实测要点（2026-11）：
 *   * 裸请求直接 412，必须带正常 UA + Referer，并先访问 www.bilibili.com 拿 buvid3；
 *   * 连续请求 4~5 次后会开始 412，需要限速 + 指数退避 + 刷新 Cookie；
 *   * 搜索接口 numResults 硬性封顶 1000。
 *
 * @module dsh-bilibili-bundle/shared/client
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { BiliApiError, isRiskError } from './errors.js'
import { DEFAULT_REQUEST_CONFIG, resolveCacheDir } from './http.js'

/** B 站主站（Cookie 引导用）。 */
const WWW_BASE = 'https://www.bilibili.com/'

/** B 站 API 根地址。 */
export const API_BASE = 'https://api.bilibili.com'

/** 指纹接口：会下发 buvid3 / buvid4 等风控 Cookie。 */
export const FINGER_SPI_PATH = '/x/frontend/finger/spi'

/** wbi 密钥接口。 */
export const NAV_PATH = '/x/web-interface/nav'

/** wbi 混淆表（社区公开，与 Python demo 完全一致）。 */
export const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
])

/** wbi 密钥缓存有效期（毫秒）。 */
const WBI_KEY_TTL_MS = 3600 * 1000

// --------------------------------------------------------------------------- //
// 错误小工具
// --------------------------------------------------------------------------- //

/** 构造与 fetch/DOMException 类似的取消错误。 */
function makeAbortError(message = '请求已取消') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/**
 * 可被 AbortSignal 打断的 sleep。
 * @param {number} ms
 * @param {AbortSignal[]} signals
 */
function sleep(ms, signals = []) {
  return new Promise((resolve, reject) => {
    if (signals.some((signal) => signal?.aborted)) {
      reject(makeAbortError())
      return
    }
    let timer = null
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      cleanup()
      reject(makeAbortError())
    }
    const cleanup = () => {
      for (const signal of signals) signal?.removeEventListener?.('abort', onAbort)
    }
    for (const signal of signals) signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}

// --------------------------------------------------------------------------- //
// 全局限速：跨 BiliClient 实例、跨插件，保证两次 HTTP 请求间隔 >= intervalMs
// （模块级单例，per-process，见文件头注释）
// --------------------------------------------------------------------------- //

let throttleChain = Promise.resolve()
let globalLastRequestAt = 0

// --------------------------------------------------------------------------- //
// 查询串 / md5 小工具
// --------------------------------------------------------------------------- //

/** RFC3986 编码（与浏览器 encodeURIComponent 一致，wbi 签名要求）。 */
function encodeComponent(value) {
  return encodeURIComponent(String(value))
}

/**
 * 按键名排序拼接查询串；签名与真实请求共用，保证两者字节一致。
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function encodeQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeComponent(key)}=${encodeComponent(params[key])}`)
    .join('&')
}

/** 计算 md5 十六进制串。 */
function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** 从 wbi_img 的 URL 中提取 key（文件名去掉扩展名）。 */
function extractWbiKey(url) {
  if (typeof url !== 'string' || !url) return ''
  const file = url.split('/').pop() ?? ''
  return file.split('.')[0] ?? ''
}

/** 生成缓存 key：sha1(path + '?' + 排序查询串) 前 16 位（与 Python demo 一致）。 */
export function cacheKeyFor(pathname, params = {}) {
  return createHash('sha1')
    .update(`${pathname}?${encodeQuery(params)}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

// --------------------------------------------------------------------------- //
// BiliClient
// --------------------------------------------------------------------------- //

/**
 * 带磁盘缓存与风控退避的 B 站接口客户端。
 */
export class BiliClient {
  /**
   * @param {object} [config] 含 `request` 分组的对象（resolveHttpConfig 的结果
   *   或完整插件 config 均可，只读取 .request 字段）
   * @param {{
   *   cacheDir?: string,
   *   offline?: boolean,
   *   signal?: AbortSignal,
   *   verbose?: boolean,
   * }} [options]
   */
  constructor(config, options = {}) {
    /** @type {{ request: typeof DEFAULT_REQUEST_CONFIG }} */
    this.config = config && typeof config === 'object' && config.request
      ? config
      : { request: DEFAULT_REQUEST_CONFIG }
    /** 离线模式：只读缓存，不联网。 */
    this.offline = options.offline === true
    /** 调用方取消信号（整个工具调用共享）。 */
    this.signal = options.signal
    /** 调试日志开关。 */
    this.verbose = options.verbose === true

    /** 数据请求次数（不含 Cookie 引导 / wbi 密钥请求）。正常一次调用 = 7。 */
    this.requestCount = 0
    /** 所有 HTTP 请求次数（含引导 / 密钥），用于 maxRequests 预算。 */
    this.httpRequests = 0
    /** 磁盘缓存命中次数。 */
    this.cacheHits = 0
    /** 最近一次请求/缓存命中的数据抓取时间（毫秒时间戳）。 */
    this.lastFetchedAt = 0
    /** 最近一次 getJson 是否来自缓存。 */
    this.lastRequestCached = false

    this.cacheDir = resolveCacheDir(options.cacheDir ?? this.config.request.cacheDir)
    /** @type {Map<string, string>} Cookie jar：name → value。 */
    this.cookies = new Map()
    this._bootstrapped = false
    /** @type {[string, string]|null} */
    this._wbiKeys = null
    this._wbiKeysAt = 0

    if (this.cacheDir) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true })
      } catch {
        // 缓存目录不可写时静默降级为无缓存，不影响抓取
        if (this.verbose) console.warn(`[bilibili] 无法创建缓存目录: ${this.cacheDir}`)
      }
    }
  }

  // ------------------------------------------------------------------ //
  // 底层 HTTP
  // ------------------------------------------------------------------ //

  /** 调试日志。 */
  _log(message) {
    if (this.verbose) console.warn(`[bilibili] ${message}`)
  }

  /** 请求头：正常 UA + Referer + Cookie（契约 §3.3）。 */
  _headers() {
    const headers = {
      'User-Agent': this.config.request.userAgent,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.Cookie = cookie
    return headers
  }

  /** 解析并保存响应里的 set-cookie（Node 22 的 Headers.getSetCookie）。 */
  _storeSetCookies(headers) {
    if (!headers) return
    let lines = []
    try {
      if (typeof headers.getSetCookie === 'function') lines = headers.getSetCookie()
    } catch {
      lines = []
    }
    if (lines.length === 0) {
      const raw = typeof headers.get === 'function' ? headers.get('set-cookie') : ''
      if (raw) lines = [raw]
    }
    for (const line of lines) {
      const pair = String(line).split(';', 1)[0] ?? ''
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (name) this.cookies.set(name, value)
    }
  }

  /** 全局串行化限速：保证任意两次 HTTP 请求开始时间间隔 >= intervalMs。 */
  async _throttle(signals) {
    const interval = this.config.request.intervalMs
    const previous = throttleChain
    let release = () => {}
    throttleChain = new Promise((resolve) => {
      release = resolve
    })
    try {
      await previous
      const wait = globalLastRequestAt + interval - Date.now()
      if (wait > 0) await sleep(wait, signals)
      globalLastRequestAt = Date.now()
    } finally {
      release()
    }
  }

  /**
   * 执行一次原始 GET，返回状态码与文本（不抛 HTTP 状态错误，交给上层判断）。
   * @returns {Promise<{status:number, text:string}>}
   */
  async _rawGet(url, { signal, countAsData = false } = {}) {
    const signals = [this.signal, signal].filter((item) => item && typeof item.aborted === 'boolean')
    if (signals.some((item) => item.aborted)) throw makeAbortError()

    await this._throttle(signals)

    if (this.httpRequests >= this.config.request.maxRequests) {
      throw new BiliApiError(
        `超过单次调用请求预算 maxRequests=${this.config.request.maxRequests}，请稍后再试`,
        { code: 'BUDGET' },
      )
    }
    this.httpRequests += 1
    if (countAsData) this.requestCount += 1

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.config.request.timeoutMs)
    const combined = signals.length > 0 ? AbortSignal.any([controller.signal, ...signals]) : controller.signal

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this._headers(),
        redirect: 'follow',
        signal: combined,
      })
      this._storeSetCookies(response.headers)
      const text = await response.text()
      return { status: response.status, text }
    } catch (error) {
      if (timedOut) {
        throw new BiliApiError(`请求超时（${this.config.request.timeoutMs}ms），请检查网络后重试`, {
          code: 'TIMEOUT',
        })
      }
      if (signals.some((item) => item.aborted)) throw makeAbortError()
      const message = error instanceof Error ? error.message : String(error)
      throw new BiliApiError(`网络错误：${message}`, { code: 'NETWORK' })
    } finally {
      clearTimeout(timer)
    }
  }

  // ------------------------------------------------------------------ //
  // Cookie 引导 & wbi 签名
  // ------------------------------------------------------------------ //

  /**
   * 访问主站与 spi 接口拿风控 Cookie（buvid3 / buvid4 等）。
   * 引导失败不致命：后续接口若被风控，会在退避时强制重新引导。
   * @param {boolean} force 是否强制刷新（清空现有 Cookie 重新拿）
   * @param {AbortSignal} [signal]
   */
  async bootstrap(force = false, signal) {
    if (this._bootstrapped && !force) return
    if (this.offline) {
      this._bootstrapped = true
      return
    }
    if (force && this.cookies.size > 0) {
      this._log('刷新 Cookie（清空 jar 重新引导）')
      this.cookies.clear()
    }
    for (const url of [WWW_BASE, `${API_BASE}${FINGER_SPI_PATH}`]) {
      try {
        const { status, text } = await this._rawGet(url, { signal })
        if (status === 200 && url.endsWith(FINGER_SPI_PATH)) {
          try {
            const payload = JSON.parse(text)
            const data = payload && typeof payload === 'object' ? payload.data : null
            if (data && typeof data === 'object') {
              if (data.b_3) this.cookies.set('buvid3', String(data.b_3))
              if (data.b_4) this.cookies.set('buvid4', String(data.b_4))
            }
          } catch {
            // fingerprint 响应不是 JSON 时只能依赖 set-cookie
          }
        }
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'BUDGET') throw error
        this._log(`cookie 引导跳过 ${url}: ${error?.message ?? error}`)
      }
    }
    this._bootstrapped = true
    this._log(`cookie 引导完成: ${[...this.cookies.keys()].sort().join(',') || '(空)'}`)
  }

  /**
   * 取 wbi 签名用的 img_key / sub_key（缓存 1 小时）。
   * @returns {Promise<[string, string]>}
   */
  async _getWbiKeys(signal) {
    const now = Date.now()
    if (this._wbiKeys && now - this._wbiKeysAt < WBI_KEY_TTL_MS) return this._wbiKeys
    const { status, text } = await this._rawGet(`${API_BASE}${NAV_PATH}`, { signal })
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      throw new BiliApiError(`获取 wbi 签名密钥失败：nav 响应不是合法 JSON（HTTP ${status}）`, {
        httpStatus: status,
      })
    }
    const wbi = payload && typeof payload === 'object' ? payload.data?.wbi_img : null
    const imgKey = extractWbiKey(wbi?.img_url)
    const subKey = extractWbiKey(wbi?.sub_url)
    if (!imgKey || !subKey) {
      throw new BiliApiError(`获取 wbi 签名密钥失败（HTTP ${status}，可能触发风控），请稍后重试`, {
        httpStatus: status,
        code: payload?.code,
      })
    }
    this._wbiKeys = [imgKey, subKey]
    this._wbiKeysAt = now
    return this._wbiKeys
  }

  /** 按 wbi 算法给参数签名，返回带 `wts` / `w_rid` 的对象。 */
  _signParams(params, imgKey, subKey) {
    const raw = `${imgKey}${subKey}`
    let mixin = ''
    for (const index of MIXIN_KEY_ENC_TAB) mixin += raw[index] ?? ''
    mixin = mixin.slice(0, 32)

    const signed = {}
    for (const [key, value] of Object.entries(params)) signed[key] = String(value)
    signed.wts = String(Math.floor(Date.now() / 1000))
    signed.w_rid = md5(encodeQuery(signed) + mixin)
    return signed
  }

  // ------------------------------------------------------------------ //
  // 磁盘缓存
  // ------------------------------------------------------------------ //

  _cachePath(key) {
    return this.cacheDir ? path.join(this.cacheDir, `${key}.json`) : ''
  }

  /**
   * 读缓存；ttlSeconds 为 0 表示永不过期（与 Python demo 语义一致）。
   * @returns {object|null}
   */
  _cacheRead(key, ttlSeconds) {
    const file = this._cachePath(key)
    if (!file) return null
    let blob = null
    try {
      blob = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    if (!blob || typeof blob !== 'object') return null
    const fetchedAt = Number(blob._fetchedAt)
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
    if (ttlSeconds > 0 && Date.now() - fetchedAt > ttlSeconds * 1000) return null
    const payload = blob.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    this.cacheHits += 1
    this.lastFetchedAt = fetchedAt
    this.lastRequestCached = true
    return payload
  }

  /** 原子写缓存（先写 tmp 再 rename），失败静默忽略，不影响抓取。 */
  _cacheWrite(key, payload, request) {
    const file = this._cachePath(key)
    if (!file) return
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true })
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
      const blob = {
        _fetchedAt: Date.now(),
        _request: {
          path: request?.path ?? '',
          keyword: request?.params?.keyword ?? '',
          order: request?.params?.order ?? '',
        },
        payload,
      }
      fs.writeFileSync(tmp, JSON.stringify(blob), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      this._log(`写缓存失败 ${file}: ${error?.message ?? error}`)
    }
  }

  // ------------------------------------------------------------------ //
  // 高层 JSON 请求
  // ------------------------------------------------------------------ //

  /**
   * 请求一个返回 `{code,data}` 的接口，返回完整 payload（未解包 data）。
   *
   * @param {string} path 接口路径（以 / 开头）
   * @param {Record<string, unknown>} [params]
   * @param {{
   *   signed?: boolean,
   *   useCache?: boolean,
   *   cacheTtlSeconds?: number,
   *   signal?: AbortSignal,
   * }} [options]
   * @returns {Promise<object>}
   */
  async getJson(path, params = {}, options = {}) {
    const { signed = false, useCache = true, cacheTtlSeconds } = options
    const signal = options.signal
    const ttl = Number.isFinite(cacheTtlSeconds)
      ? cacheTtlSeconds
      : this.config.request.cacheTtlSeconds

    const key = cacheKeyFor(path, params)
    if (useCache) {
      const cached = this._cacheRead(key, ttl)
      if (cached) {
        this._log(`缓存命中 ${path}`)
        return cached
      }
    }
    if (this.offline) {
      const cached = this._cacheRead(key, 0)
      if (cached) return cached
      throw new BiliApiError(`离线模式但没有可用缓存：${path}（请先联网运行一次）`)
    }

    await this.bootstrap(false, signal)

    const maxRetries = this.config.request.maxRetries
    let lastError = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const payload = await this._requestOnce(path, params, {
          signed,
          signal,
          countAsData: true,
        })
        this.lastFetchedAt = Date.now()
        this.lastRequestCached = false
        if (useCache) this._cacheWrite(key, payload, { path, params })
        return payload
      } catch (error) {
        lastError = error
        if (error?.name === 'AbortError') throw error
        if (!isRiskError(error) || attempt >= maxRetries) throw error
        const wait = 1000 * 2 ** attempt + Math.floor(Math.random() * 800)
        this._log(
          `风控 ${error?.httpStatus ?? error?.code}，${wait}ms 后重试（${attempt + 1}/${maxRetries}）`,
        )
        await sleep(wait, [this.signal, signal].filter(Boolean))
        await this.bootstrap(true, signal)
      }
    }
    throw lastError ?? new BiliApiError('B 站接口请求失败')
  }

  /** 单次请求（不重试）：拼 URL → 取 wbi 签名 → 校验 HTTP/业务码/隐性风控。 */
  async _requestOnce(path, params, { signed, signal, countAsData = true } = {}) {
    let query
    if (signed) {
      const [imgKey, subKey] = await this._getWbiKeys(signal)
      query = encodeQuery(this._signParams(params, imgKey, subKey))
    } else {
      query = encodeQuery(params)
    }
    const url = `${API_BASE}${path}?${query}`
    const { status, text } = await this._rawGet(url, { signal, countAsData })

    if (status === 412 || status === 429) {
      throw new BiliApiError(`触发 B 站风控（HTTP ${status}）`, { httpStatus: status })
    }
    if (status !== 200) {
      throw new BiliApiError(`B 站接口返回 HTTP ${status}`, { httpStatus: status })
    }
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      throw new BiliApiError(`B 站接口响应不是合法 JSON（HTTP ${status}）`, {
        httpStatus: status,
      })
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BiliApiError('B 站接口响应结构异常', { httpStatus: status })
    }

    const data = payload.data
    // wbi 校验失败时 B 站会返回 code=0 但 data 里只有 v_voucher，属于隐性风控
    if (data && typeof data === 'object' && 'v_voucher' in data && !data.result) {
      throw new BiliApiError('wbi 校验未通过（v_voucher），按风控处理', {
        code: -412,
        httpStatus: status,
      })
    }
    const code = Number(payload.code ?? 0)
    if (code !== 0) {
      const message = payload.message ? `，message=${payload.message}` : ''
      throw new BiliApiError(`B 站接口错误 code=${code}${message}`, { code, httpStatus: status })
    }
    return payload
  }
}

// 兼容性再导出：历史代码 / 测试从 client.js 导入错误类型与判定函数。
export { BiliApiError, isRiskError } from './errors.js'
