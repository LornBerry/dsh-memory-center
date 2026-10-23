/**
 * 锚点初判：给一条记忆一个「完全锚点 / 权重锚点 / 不设锚点」的初始分类。
 *
 * 为什么要判：新建的记忆如果一律是「不设锚点」，注入时就没有优先级，
 * 硬性约束（必须/禁止/只写某处）会和随口一提的偏好抢同样的位置；
 * 用户又不可能每条都手动点一遍菜单。
 *
 * 判据只用确定性规则（不联网、不调模型），所以结果可复现、可解释：
 *   full   —— 硬性约束：必须 / 禁止 / 不得 / 只能 / 只写 / 切记 / 安全类（密码、密钥、凭据）
 *   weight —— 偏好与惯例：喜欢 / 偏好 / 尽量 / 最好 / 建议 / 统一 / 约定 / 默认
 *   off    —— 普通事实，没有强弱要求
 *
 * 强弱冲突时 full 优先（硬性压过软性）。用户一旦手动设过锚点，就记为 source='user'，
 * 之后改正文也不会被自动覆盖。
 */

const HARD_CUES = [
  '必须',
  '务必',
  '禁止',
  '严禁',
  '不得',
  '不允许',
  '不可以',
  '不能',
  '只能',
  '只允许',
  '只写',
  '只存',
  '只放在',
  '不要',
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

// 出现在这些语境里时，即使是「不要 / 不能」也通常是在描述别人的东西，不算硬约束
const SAFETY_CUES = ['密码', '密钥', '口令', '凭据', 'token', 'Token', 'TOKEN', '隐私', '敏感']

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

/**
 * @param {{ title?: string, body?: string, tags?: string[]|string }} input
 * @returns {{ mode: 'full'|'weight'|'off', why: string, hard: string[], soft: string[] }}
 */
export function inferAnchor(input) {
  const title = String(input?.title ?? '')
  const body = String(input?.body ?? '')
  const tags = Array.isArray(input?.tags) ? input.tags.join(' ') : String(input?.tags ?? '')
  const text = `${title}\n${body}\n${tags}`

  const hard = collect(text, HARD_CUES)
  const soft = collect(text, SOFT_CUES)
  const safety = collect(text, SAFETY_CUES)

  // 标题里的线索权重更高（标题通常是结论），正文补充细节
  const hardScore = hard.reduce((sum, hit) => sum + hit.count * (title.includes(hit.cue) ? 2 : 1), 0)
  const softScore = soft.reduce((sum, hit) => sum + hit.count * (title.includes(hit.cue) ? 2 : 1), 0)

  if (hardScore > 0) {
    const cues = hard.map((hit) => hit.cue).concat(safety.map((hit) => hit.cue))
    const why = cues.length ? `命中硬性措辞：${cues.slice(0, 3).join('、')}` : '命中硬性措辞'
    return { mode: 'full', why, hard: cues, soft: soft.map((hit) => hit.cue) }
  }

  if (safety.length && /不要|不得|禁止|别/.test(text)) {
    const why = `安全相关：${safety.map((hit) => hit.cue).slice(0, 2).join('、')}`
    return { mode: 'full', why, hard: safety.map((hit) => hit.cue), soft: soft.map((hit) => hit.cue) }
  }

  if (softScore > 0) {
    const cues = soft.map((hit) => hit.cue)
    return { mode: 'weight', why: `命中偏好措辞：${cues.slice(0, 3).join('、')}`, hard: [], soft: cues }
  }

  return { mode: 'off', why: '没有强弱措辞，按普通事实处理', hard: [], soft: [] }
}

export const ANCHOR_CUES = { hard: HARD_CUES, soft: SOFT_CUES, safety: SAFETY_CUES }
