/**
 * 共享的错误类型与风控判定：B 站接口调用失败（含风控、网络、业务错误码）。
 *
 * @module dsh-bilibili-bundle/shared/errors
 */

/** 触发风控的业务错误码。 */
export const RISK_CODES = Object.freeze(new Set([-412, -352, -509]))

/** 接口调用失败（含风控、网络、业务错误码）。 */
export class BiliApiError extends Error {
  /**
   * @param {string} message 面向开发者的说明
   * @param {{ code?: number|string|null, httpStatus?: number|null }} [details]
   */
  constructor(message, { code = null, httpStatus = null } = {}) {
    super(message)
    this.name = 'BiliApiError'
    /** 业务错误码（payload.code）；预算/超时等本地错误用字符串标记。 */
    this.code = code
    /** HTTP 状态码。 */
    this.httpStatus = httpStatus
  }
}

/**
 * 是否属于「可以退避重试」的风控错误：HTTP 412/429 或业务码 -412/-352/-509。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRiskError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.httpStatus === 412 || error.httpStatus === 429) return true
  return RISK_CODES.has(error.code)
}
