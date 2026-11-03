/**
 * topic-heat-guidance 插件：当且仅当 `bili_topic_heat` 出现在组装的工具
 * schema 中时，往系统提示词里追加一段英文使用策略。
 *
 * 机制：`system-prompt/assemble` waterfall。段的 text 函数拿不到最终工具
 * 列表（段在 waterfall 之前组装），而「工具是否出现在 schema 中」取决于
 * tools provider 收集 + 按 agent 限制之后的结果，所以判断必须放在
 * waterfall 里对 assembly.tools 做（这是组装后的权威结果）。
 *
 * 为什么不无条件注册 section：若工具被注册但某个 preset/agent 又把它从
 * 可见 schema 里过滤掉，无条件段会失真；waterfall 判断严格满足
 * 「if and only if it appears in the tool schema」。
 *
 * 排序：2500 —— 全库共享 SECTION_ORDERS 工具引导号段中
 * TOOL_GOAL(2400) 与 TOOL_WORKFLOW(2600) 之间的空档。
 *
 * @module dsh-bilibili-bundle/plugins/topic-heat-guidance
 */

/** 插件行标识（与 cordis.patch.yml 的 id 一致）。 */
export const name = 'bilibili-topic-heat-guidance'

/** 系统提示词组装注册表必须先存在。 */
export const inject = ['systemPrompt']

/** 被引导的工具名。 */
export const TOOL_NAME = 'bili_topic_heat'

/** 段名（同层内唯一，名字空间化避免与他人冲突）。 */
export const SECTION_NAME = 'bilibili:topic-heat-policy'

/**
 * 段排序：SECTION_ORDERS 工具引导号段（1000–3100）内，
 * TOOL_GOAL(2400) 与 TOOL_WORKFLOW(2600) 之间的空档。
 */
export const SECTION_ORDER = 2500

/**
 * 引导文案（模型可见，英文）。
 * 契约：B 站话题热度只允许经 bili_topic_heat 获取。
 */
export const GUIDANCE_TEXT =
  'Use the bili_topic_heat tool ONLY when the user asks for the heat or popularity ' +
  'of a topic on Bilibili. It is the only allowed source for Bilibili topic heat ' +
  'information; do not estimate topic heat from any other tool or source.'

/**
 * 若工具出现在 schema 中则追加引导段，否则原样返回（纯函数，便于离线测试）。
 * @param {object} assembly system-prompt/assemble 的组装结果
 * @returns {object} 新的 assembly（未命中时返回原对象）
 */
export function withGuidanceSection(assembly) {
  if (!assembly || typeof assembly !== 'object') return assembly
  const tools = Array.isArray(assembly.tools) ? assembly.tools : []
  const sections = Array.isArray(assembly.sections) ? assembly.sections : []
  const present = tools.some((tool) => tool?.name === TOOL_NAME)
  if (!present) return assembly
  return {
    ...assembly,
    sections: [...sections, { name: SECTION_NAME, order: SECTION_ORDER, text: GUIDANCE_TEXT }],
  }
}

/**
 * 插件入口：注册 system-prompt/assemble waterfall。
 *
 * 注意 Cordis waterfall 的语义：`next()` 不传递参数，`next(x)` 的 x 会被
 * 忽略，链条最内层的 fallback 永远返回「原始」assembly。正确模式是
 * `const result = await next(); return modify(result)` —— 自己 return
 * 修改值，由外层监听器返回值逐级向上传播（dsh-working-directory 同款）。
 * @param {object} ctx Cordis 插件上下文（需要 `ctx.systemPrompt`）
 * @returns {() => void} 反注册 disposer
 */
export function apply(ctx) {
  return ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return withGuidanceSection(assembled)
  })
}
