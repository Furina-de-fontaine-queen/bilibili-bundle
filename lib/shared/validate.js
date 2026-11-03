/**
 * 共享的配置校验小工具：纯函数、不抛错，非法值一律回退默认值。
 *
 * bundle 内所有插件（以及 shared 自己的 request/sampling 解析）共用这一套，
 * 保证「config 清洗」语义全包一致。只依赖 Node 内置模块。
 *
 * @module dsh-bilibili-bundle/shared/validate
 */

/** 是否为普通对象（排除 null / 数组 / class 实例）。 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深拷贝仅含 JSON 数据的对象（默认配置与用户配置都满足）。 */
export function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 递归冻结，防止运行期意外修改默认配置。 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/** 深合并：对象递归合并，数组/标量直接覆盖，缺失的保留 base 值。 */
export function deepMerge(base, extra) {
  if (!isPlainObject(base) || !isPlainObject(extra)) {
    return isPlainObject(extra) ? deepClone(extra) : deepClone(base)
  }
  const out = deepClone(base)
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else if (isPlainObject(value)) {
      out[key] = deepClone(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 把值转成有限数字；失败返回 NaN。 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

/**
 * 数值字段兜底：非法（NaN/类型错误/越界）时回退默认值，而不是夹到边界。
 * @param {unknown} value 用户值
 * @param {number} fallback 默认值
 * @param {number} low 允许下限（含）
 * @param {number} high 允许上限（含）
 * @param {{ integer?: boolean }} [opts]
 */
export function pickNumber(value, fallback, low, high, opts = {}) {
  let number = toFiniteNumber(value)
  if (!Number.isFinite(number)) return fallback
  if (opts.integer) number = Math.trunc(number)
  if (number < low || number > high) return fallback
  return number
}

/** 字符串字段兜底：空串/非字符串回退默认值。 */
export function pickString(value, fallback, { maxLength = 500 } = {}) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return fallback
  return trimmed
}

/**
 * 按字段规格表清洗一个纯数值配置分组。
 * @param {Record<string, number>} base 默认值
 * @param {unknown} user 用户值（可能是 undefined）
 * @param {Record<string, [number, number, boolean?] | {low:number,high:number,integer?:boolean}>} specs 规格表
 */
export function sanitizeNumberGroup(base, user, specs) {
  const out = {}
  const source = isPlainObject(user) ? user : {}
  for (const [key, fallback] of Object.entries(base)) {
    const spec = specs[key]
    const range = Array.isArray(spec) ? spec : [spec?.low ?? -Infinity, spec?.high ?? Infinity]
    const integer = Array.isArray(spec) ? Boolean(spec[2]) : Boolean(spec?.integer)
    out[key] = pickNumber(source[key], fallback, range[0], range[1], { integer })
  }
  return out
}
