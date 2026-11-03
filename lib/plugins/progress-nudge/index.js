/**
 * progress-nudge 插件：每 N 个模型步向消息流注入一条进度提醒快照。
 *
 * 机制（与 @deepseek-ai/dsh-time-context 同路）：监听 `agent/pre-step`
 * waterfall，对自己维护的「会话级步数计数」+1，每 everySteps 步在 decision
 * 的消息末尾追加一条 user 角色、source 为 snapshot 的提醒消息。
 *
 * 为什么不走 ctx.systemPrompt：
 *   - section 是静态文本，拿不到「第几步」；
 *   - context 快照虽然每步求值，但极简模式 includeRuntimeContext: false
 *     会抑制它（除非 required），而本插件要在极简/标准两种模式下都工作；
 *   - 消息注入不经过 systemPrompt 组装，两种模式行为一致，且快照消息
 *     明确声明来源（form: 'snapshot'），不会被当成用户输入。
 *
 * 计数用 WeakMap 以会话对象为键：随会话回收，无泄漏；不依赖 sessionProjections，
 * 保持零外部依赖（bundle 内自包含，离线可测）。
 *
 * @module dsh-bilibili-bundle/plugins/progress-nudge
 */

import { randomUUID } from 'node:crypto'

import { deepFreeze, pickNumber, pickString } from '../../shared/validate.js'

/** 插件行标识（与 cordis.patch.yml 的 id 一致）。 */
export const name = 'bilibili-progress-nudge'

/** 不需要任何服务：只挂 agent/pre-step 事件。 */
export const inject = []

/** 快照消息 source.kind（带来源归因，展示层可识别注入者）。 */
const SOURCE_KIND = name

/**
 * 插件默认配置（深冻结）。
 */
export const DEFAULT_CONFIG = deepFreeze({
  // 每多少个模型步提醒一次（正整数）。
  everySteps: 5,
  // 提醒文案（模型可见，英文；persona 也是英文，保持一致）。
  text:
    'Progress checkpoint: briefly tell the user what you have accomplished so far ' +
    'and what remains for the current task, then continue working on the task.',
})

/**
 * 配置兜底：面向 cordis.patch.yml / settings 传入的普通对象，非法值回退默认值。
 * @param {unknown} config
 */
export function resolveConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  return {
    everySteps: pickNumber(input.everySteps, DEFAULT_CONFIG.everySteps, 1, 10000, {
      integer: true,
    }),
    text: pickString(input.text, DEFAULT_CONFIG.text, { maxLength: 500 }),
  }
}

/**
 * 是否到了该提醒的步数（纯函数，便于离线测试）。
 * @param {number} stepCount 本会话累计模型步数（从 1 开始）
 * @param {number} everySteps 提醒间隔
 */
export function shouldNudge(stepCount, everySteps) {
  return Number.isInteger(stepCount) && stepCount > 0 && stepCount % everySteps === 0
}

/**
 * 构造一条 snapshot 形态的用户消息（对齐 dsh-llm createUserMessage 的
 * 运行时形状：稳定 id + role + content + source；structuredClone 防别名）。
 * @param {string} text
 */
function makeSnapshotMessage(text) {
  return structuredClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text }] },
  })
}

/**
 * 插件入口：注册 agent/pre-step 监听。
 * @param {object} ctx Cordis 插件上下文
 * @param {object} [config] 插件 config（cordis.patch.yml 的 config 段）
 * @returns {() => void} 反注册 disposer
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  /** 会话对象 → 已进行的模型步数。 */
  const stepCounts = new WeakMap()

  return ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter' || signal?.aborted) return decision
      const session = agent?.session
      if (session === undefined || session === null) return decision

      const stepCount = (stepCounts.get(session) ?? 0) + 1
      stepCounts.set(session, stepCount)
      if (!shouldNudge(stepCount, cfg.everySteps)) return decision

      return {
        ...decision,
        messages: [...(decision.messages ?? []), makeSnapshotMessage(cfg.text)],
      }
    },
    { prepend: true },
  )
}
