#!/usr/bin/env node
/**
 * bilibili-bundle 的真实接口联调测试（会联网，默认由人工/验证者显式运行）。
 *
 * 做法：
 *   1. 用 fake ctx 捕获 `apply` 注册的工具定义，然后真正 `execute({topic:'原神',window:'7d'})`；
 *   2. 第一次调用清空默认磁盘缓存目录，确保真的走网络（限速 2s，正常 15~25s）；
 *   3. 同一参数第二次调用必须命中磁盘缓存：`source.cached===true`、`source.requests===0`、
 *      耗时 < 3s（缓存 TTL 默认 3600s，窗口端点按 900s 量化，两次调用在同一刻钟内必然复用）；
 *   4. 校验契约 §6 的关键约束：0≤index≤100、numResults>0、topVideos 1~5 条、
 *      models 4 个、components 7 个、source.requests 1~20、无 NaN/Infinity。
 *
 * 运行：node test/live.mjs        （约 20~30s；退出码 0 = 通过，1 = 失败）
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

import { resolveCacheDir } from '../lib/shared/http.js'
import { apply } from '../lib/plugins/topic-heat/index.js'

const TOPIC = '原神'
const WINDOW = '7d'
const MODEL_IDS = ['composite', 'discussion', 'momentum', 'scale']
const COMPONENT_IDS = ['play', 'engagement', 'rate', 'peak', 'velocity', 'supply', 'relevance']
const FIRST_CALL_BUDGET_MS = 150_000
const CACHE_CALL_LIMIT_MS = 3000
const BUCKET_MS = 900_000 // 窗口端点按 900s 量化；两次调用要落在同一刻钟内

/** 递归检查没有 NaN / Infinity / undefined / 函数，返回统计信息。 */
function inspectJsonSafe(value) {
  let numbers = 0
  const walk = (node, at) => {
    if (node === undefined) throw new Error(`${at}: 出现 undefined`)
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`${at}: 出现非有限数字 ${node}`)
      numbers += 1
      return
    }
    if (typeof node === 'function') throw new Error(`${at}: 出现函数`)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`))
      return
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], `${at}.${key}`)
    }
  }
  walk(value, 'value')
  // JSON 往返必须完全一致（反证没有 NaN→null / undefined 丢字段）
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, '工具 value 不能无损 JSON 序列化')
  return numbers
}

/** 断言工具 value 满足契约 §6 的硬性约束。 */
function assertToolValue(value, phase, { allowZeroRequests = false } = {}) {
  assert.ok(value && typeof value === 'object', `${phase}: value 不是对象`)
  // 主指数
  assert.ok(Number.isFinite(value.heat?.index), `${phase}: heat.index 不是有限数`)
  assert.ok(value.heat.index >= 0 && value.heat.index <= 100, `${phase}: heat.index 越界 ${value.heat.index}`)
  assert.equal(typeof value.heat.tier, 'string')
  assert.ok(Number.isFinite(value.heat.baseIndex))
  assert.ok(Number.isFinite(value.heat.hotBonus))
  // 窗口
  assert.equal(value.window?.preset, WINDOW, `${phase}: window.preset`)
  assert.equal(value.window?.days, 7, `${phase}: window.days`)
  assert.equal(value.window?.label, '近7天', `${phase}: window.label`)
  assert.ok(Number.isFinite(Date.parse(value.window?.start)), `${phase}: window.start 非 ISO`)
  assert.ok(Number.isFinite(Date.parse(value.window?.end)), `${phase}: window.end 非 ISO`)
  assert.ok(Number.isFinite(Date.parse(value.asOf)), `${phase}: asOf 非 ISO`)
  // 证据
  assert.ok(Number.isInteger(value.evidence?.numResults), `${phase}: numResults 非整数`)
  assert.ok(value.evidence.numResults > 0, `${phase}: numResults 应为正数，实际 ${value.evidence.numResults}`)
  assert.ok(value.evidence.sampleSize > 0, `${phase}: sampleSize 应为正数`)
  assert.ok(value.evidence.headSize >= 1 && value.evidence.headSize <= 50, `${phase}: headSize 越界`)
  assert.ok(Number.isFinite(value.evidence.velocityPerDay))
  assert.ok(Number.isFinite(value.evidence.relevance))
  assert.ok(value.evidence.hotRank === null || Number.isInteger(value.evidence.hotRank), `${phase}: hotRank`)
  // 模型 / 分量 / 代表视频
  assert.equal(value.models?.length, 4, `${phase}: models 应为 4 个`)
  assert.deepEqual(value.models.map((model) => model.id), MODEL_IDS)
  for (const model of value.models) {
    assert.ok(Number.isFinite(model.index) && model.index >= 0 && model.index <= 100, `${phase}: model ${model.id} 越界`)
    assert.equal(typeof model.tier, 'string')
    assert.equal(typeof model.summary, 'string')
  }
  assert.equal(value.components?.length, 7, `${phase}: components 应为 7 个`)
  assert.deepEqual(value.components.map((component) => component.id), COMPONENT_IDS)
  for (const component of value.components) {
    assert.ok(component.normalized >= 0 && component.normalized <= 1, `${phase}: ${component.id}.normalized 越界`)
    assert.ok(Number.isFinite(component.raw) && Number.isFinite(component.points))
  }
  assert.ok(Array.isArray(value.consensus) === false && value.consensus && typeof value.consensus === 'object')
  assert.equal(typeof value.consensus.agreement, 'string')
  assert.ok(value.topVideos.length >= 1 && value.topVideos.length <= 5, `${phase}: topVideos 应为 1~5 条，实际 ${value.topVideos.length}`)
  for (const video of value.topVideos) {
    assert.ok(Number.isInteger(video.play) && video.play >= 0, `${phase}: topVideo.play`)
    assert.match(video.url, /^https:\/\/www\.bilibili\.com\/video\//, `${phase}: topVideo.url`)
  }
  assert.ok(Array.isArray(value.warnings) && value.warnings.length <= 6, `${phase}: warnings 条数越界`)
  // 来源
  assert.equal(value.source?.engine, 'bilibili-search')
  const minRequests = allowZeroRequests ? 0 : 1
  assert.ok(Number.isInteger(value.source?.requests) && value.source.requests >= minRequests && value.source.requests <= 20,
    `${phase}: source.requests 应在 ${minRequests}~20，实际 ${value.source?.requests}`)
  assert.equal(typeof value.source?.cached, 'boolean')
  const numbers = inspectJsonSafe(value)
  return { numbers }
}

/** 距离上一个 900s 刻钟边界还有多少毫秒。 */
function msIntoBucket(now = Date.now()) {
  return now % BUCKET_MS
}

function summarize(value, elapsedMs) {
  return {
    index: value.heat.index,
    tier: value.heat.tier,
    baseIndex: value.heat.baseIndex,
    hotBonus: value.heat.hotBonus,
    numResults: value.evidence.numResults,
    sampleSize: value.evidence.sampleSize,
    headSize: value.evidence.headSize,
    topVideos: value.topVideos.length,
    models: Object.fromEntries(value.models.map((model) => [model.id, model.index])),
    components: value.components.length,
    warnings: value.warnings,
    source: value.source,
    elapsedMs,
  }
}

async function main() {
  // —— 准备：捕获工具定义 ——
  let captured = null
  const ctx = {
    tools: {
      register(definition) {
        captured = definition
        return () => {
          captured = null
        }
      },
    },
  }
  const disposer = apply(ctx, {})
  assert.equal(typeof disposer, 'function', 'apply 应返回 disposer')
  assert.ok(captured, 'apply 应调用 ctx.tools.register')
  assert.equal(captured.name, 'bili_topic_heat')

  // —— 清空默认磁盘缓存，保证第一次调用真的联网 ——
  const cacheDir = resolveCacheDir('')
  fs.rmSync(cacheDir, { recursive: true, force: true })
  console.log(`[live] 缓存目录已清空: ${cacheDir}`)

  // —— 避免两次调用跨 900s 刻钟边界导致第二次缓存未命中 ——
  const into = msIntoBucket()
  const remaining = BUCKET_MS - into
  if (remaining < 120_000) {
    const wait = remaining + 2000
    console.log(`[live] 距窗口刻钟边界仅 ${Math.round(remaining / 1000)}s，等待 ${Math.round(wait / 1000)}s 再开始（保证两次调用同一窗口端点）`)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }

  // —— 第一次调用：真实网络（约 15~25s） ——
  const controller = new AbortController()
  const hardTimeout = setTimeout(() => controller.abort(), FIRST_CALL_BUDGET_MS)
  let first
  let firstElapsed
  try {
    const startedAt = Date.now()
    first = await captured.execute({ topic: TOPIC, window: WINDOW }, { signal: controller.signal })
    firstElapsed = Date.now() - startedAt
  } finally {
    clearTimeout(hardTimeout)
  }
  assert.equal(first.source.cached, false, '第一次调用（已清空缓存）不应命中缓存')
  assert.notEqual(first.source.requests, 0, '第一次调用应发出真实请求')
  const firstStats = assertToolValue(first, 'first')
  const firstSummary = summarize(first, firstElapsed)
  console.log('[live] 第一次调用（真实网络）：')
  console.log(JSON.stringify(firstSummary, null, 2))
  console.log(`[live] 第一次调用耗时 ${firstElapsed}ms，JSON 数字字段 ${firstStats.numbers} 个，无 NaN/undefined`)

  // —— 第二次调用：必须命中缓存、且足够快 ——
  const secondStartedAt = Date.now()
  const second = await captured.execute({ topic: TOPIC, window: WINDOW }, {})
  const secondElapsed = Date.now() - secondStartedAt
  assert.equal(second.source.cached, true, '第二次调用应命中磁盘缓存（source.cached=true）')
  assert.equal(second.source.requests, 0, '第二次调用不应再发数据请求')
  assert.ok(secondElapsed < CACHE_CALL_LIMIT_MS, `第二次调用应 <${CACHE_CALL_LIMIT_MS}ms，实际 ${secondElapsed}ms`)
  assertToolValue(second, 'second', { allowZeroRequests: true })
  assert.equal(second.heat.index, first.heat.index, '两次调用的 heat.index 应一致（同一份缓存）')
  const secondSummary = summarize(second, secondElapsed)
  console.log('[live] 第二次调用（磁盘缓存）：')
  console.log(JSON.stringify(secondSummary, null, 2))
  console.log(`[live] 第二次调用耗时 ${secondElapsed}ms（阈值 ${CACHE_CALL_LIMIT_MS}ms），source.cached=${second.source.cached}`)

  console.log('')
  console.log('─'.repeat(72))
  console.log(
    `LIVE PASS：${TOPIC}/${WINDOW} index=${first.heat.index}（${first.heat.tier}），` +
      `numResults=${first.evidence.numResults}，topVideos=${first.topVideos.length}，` +
      `requests=${first.source.requests}，首次 ${firstElapsed}ms / 缓存 ${secondElapsed}ms`,
  )
  console.log('─'.repeat(72))
}

main().catch((error) => {
  console.error('')
  console.error('─'.repeat(72))
  console.error(`LIVE FAIL：${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'))
  console.error('─'.repeat(72))
  process.exitCode = 1
})
