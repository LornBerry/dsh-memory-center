/**
 * 锚点初判：给一条记忆一个「完全锚点 / 权重锚点 / 不设锚点」的初始分类。
 *
 * 为什么要判：新建的记忆如果一律是「不设锚点」，注入时就没有优先级，
 * 硬性约束（必须/禁止/只写某处）会和随口一提的偏好抢同样的位置；
 * 用户又不可能每条都手动点一遍菜单。
 *
 * 判据只用确定性规则（不联网、不调模型），所以结果可复现、可解释：
 *   full   —— 硬性约束：必须 / 禁止 / 只能 / 只写 / 切记 / 安全类（密码、密钥、凭据）
 *   weight —— 偏好与惯例：喜欢 / 偏好 / 尽量 / 最好 / 建议 / 统一 / 约定 / 默认
 *   off    —— 普通事实，没有强弱要求
 *
 * 为什么弱否定词（不能 / 不要 / 不得）不直接算硬性：
 *   「Windows 路径不能超过 260 字符」「不能正常启动」是在描述事实与故障，
 *   把它们标成「必须完全照此执行」比漏判更糟——模型会把事实当命令。
 *   所以弱否定只有在同时出现「立规矩」信号（以后 / 每次 / 一律 / 默认 / 所有…）
 *   时才升为 full，否则按普通事实处理。
 *   这条与 MEMORY_POLICY 里「别…/不要… 只在明确立规矩时才算关键词」保持同一口径。
 *
 * 强弱冲突时 full 优先（硬性压过软性）。用户一旦手动设过锚点，就记为 source='user'，
 * 之后改正文也不会被自动覆盖。
 */

// 强命令词：出现即视为硬性要求
const HARD_CUES = [
  '必须',
  '务必',
  '禁止',
  '严禁',
  '不允许',
  '只能',
  '只允许',
  '只写',
  '只存',
  '只放在',
  '绝不',
  '切勿',
  '切记',
  '一定要',
  '一律',
  '统一用',
  '强制',
  '仅限',
  '仅可',
]

// 弱否定：单独出现多半是在描述事实/故障，不构成硬性要求
const WEAK_NEGATIVES = ['不能', '不要', '不可以', '不得', '别用', '别把', '勿']

// 「立规矩」信号：与弱否定同时出现，才算真的在下命令。
// 只收真正的祈使/长期约束词；「默认 / 一般 / 通常 / 所有 / 任何 / 全部 / 统一」在技术描述里太常见
// （「NTFS 默认限制」「所有文件」），拿来当立规矩信号会把事实判成命令，已移除。
const RULE_CUES = [
  '以后',
  '每次',
  '一律',
  '都要',
  '凡是',
  '只要',
  '记得',
  '记住',
  '永远',
  '始终',
  '任何时候',
]

const SOFT_CUES = [
  '喜欢',
  '偏好',
  '倾向于',
  '倾向',
  '尽量',
  '最好',
  '建议',
  '宁愿',
  '宁可',
  '优先',
  '习惯',
  '风格',
  '约定',
  '规范',
  '默认',
  '一般',
  '通常',
  '比较',
  '推荐',
]

// 安全类词 + 否定 → 一律硬性（「密码不要写进仓库」是命令，不是描述）。
// 英文词一律小写存放，匹配时对文本做 toLowerCase；不放裸 key（会命中「关键」「keyboard」）。
const SAFETY_CUES = [
  '密码',
  '密钥',
  '口令',
  '凭据',
  '隐私',
  '敏感',
  'token',
  'api key',
  'apikey',
  'api_key',
  'access key',
  'secret',
  'password',
]
const SAFETY_NEGATION = /不要|不得|禁止|别|不能|切勿|never|do not|don't|dont/i

// 否定式的前缀（用于把「不喜欢」和「喜欢」区分开，避免理由文案反着说）
const NEGATOR = /[不没别无非无]/

function collect(text, cues) {
  const hits = []
  for (const cue of cues) {
    let from = 0
    let count = 0
    for (;;) {
      const at = text.indexOf(cue, from)
      if (at < 0) break
      count += 1
      from = at + cue.length
    }
    if (count) hits.push({ cue, count })
  }
  return hits
}

function collectNegated(text, cues) {
  const hits = []
  for (const cue of cues) {
    let from = 0
    let count = 0
    let negated = false
    for (;;) {
      const at = text.indexOf(cue, from)
      if (at < 0) break
      const before = text.slice(Math.max(0, at - 2), at)
      if (NEGATOR.test(before)) negated = true
      count += 1
      from = at + cue.length
    }
    if (count) hits.push({ cue, count, negated })
  }
  return hits
}

/**
 * @param {{ title?: string, body?: string, tags?: string[]|string }} input
 * @returns {{ mode: 'full'|'weight'|'off', why: string, hard: string[], soft: string[] }}
 */
export function inferAnchor(input) {
  const title = String(input?.title ?? '')
  const body = String(input?.body ?? '')
  const tags = Array.isArray(input?.tags) ? input.tags.join(' ') : String(input?.tags ?? '')
  const text = `${title}\n${body}\n${tags}`
  // 英文安全词大小写不敏感（「API key」「Secret」都要能命中）
  const lower = text.toLowerCase()
  const lowerTitle = title.toLowerCase()

  const hard = collect(text, HARD_CUES)
  const weak = collect(text, WEAK_NEGATIVES)
  const rules = collect(text, RULE_CUES)
  const soft = collectNegated(text, SOFT_CUES)
  const safety = collect(lower, SAFETY_CUES)

  // 标题里的线索权重更高（标题通常是结论），正文补充细节
  const weightOf = (hit) => {
    const inTitle = /[a-z]/.test(hit.cue) ? lowerTitle.includes(hit.cue) : title.includes(hit.cue)
    return hit.count * (inTitle ? 2 : 1)
  }
  const hardScore = hard.reduce((sum, hit) => sum + weightOf(hit), 0)
  const softScore = soft.reduce((sum, hit) => sum + weightOf(hit), 0)

  if (hardScore > 0) {
    const cues = hard.map((hit) => hit.cue)
    return { mode: 'full', why: `命中硬性措辞：${cues.slice(0, 3).join('、')}`, hard: cues, soft: [] }
  }

  // 弱否定 + 立规矩信号 → 才算下命令
  if (weak.length && rules.length) {
    const cues = weak.map((hit) => hit.cue)
    return {
      mode: 'full',
      why: `否定式约束（${cues.slice(0, 2).join('、')}）+ 立规矩措辞：${rules.slice(0, 2).map((hit) => hit.cue).join('、')}`,
      hard: cues,
      soft: [],
    }
  }

  // 安全类：无论强弱，只要出现否定就按硬性
  if (safety.length && SAFETY_NEGATION.test(text)) {
    const why = `安全相关：${safety.map((hit) => hit.cue).slice(0, 2).join('、')}`
    return { mode: 'full', why, hard: safety.map((hit) => hit.cue), soft: [] }
  }

  if (softScore > 0) {
    const negated = soft.filter((hit) => hit.negated).map((hit) => hit.cue)
    const plain = soft.filter((hit) => !hit.negated).map((hit) => hit.cue)
    const cues = plain.concat(negated)
    const label = plain.length ? `命中偏好措辞：${plain.slice(0, 3).join('、')}` : `命中偏好措辞（否定式）：${negated.slice(0, 3).join('、')}`
    const extra = plain.length && negated.length ? `；另有否定式：${negated.slice(0, 2).join('、')}` : ''
    return { mode: 'weight', why: label + extra, hard: [], soft: cues }
  }

  if (weak.length) {
    return { mode: 'off', why: `只是描述（弱否定：${weak.map((hit) => hit.cue).slice(0, 2).join('、')}），不构成硬性要求`, hard: [], soft: [] }
  }

  return { mode: 'off', why: '没有强弱措辞，按普通事实处理', hard: [], soft: [] }
}

export const ANCHOR_CUES = { hard: HARD_CUES, weak: WEAK_NEGATIVES, rule: RULE_CUES, soft: SOFT_CUES, safety: SAFETY_CUES }
