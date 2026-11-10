import { ExtractionHTMLOptions } from './parsers/options'

/**
 * 「提取当前文件中的中文」检测到 0 条时，用户完全看不到任何反馈：
 * 命令跑完什么都没发生，既不知道是没检测到、还是检测到了但被过滤掉。
 * 这里做一次轻量归因，告诉使用者那些中文到底"卡"在哪一类里。
 *
 * 只做粗略归类（不算 AST），数字用于解释，不作为精确统计。
 */

export const CJK_TEXT_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]+/g

export interface ChineseBreakdown {
  /** 全文中文片段总数 */
  total: number
  /** 在 HTML / JS 注释里 */
  comment: number
  /** 在 console.* 输出里（解析器主动忽略） */
  consoleCall: number
  /** 已经被 $t() / t() 包裹 */
  wrapped: number
  /** 在没纳入检测的属性里（v-if、自定义属性等） */
  untrackedAttribute: number
  /** 其它（含你手动加入忽略清单的文案） */
  other: number
}

const DEFAULT_ATTRS = ['title', 'alt', 'placeholder', 'label', 'aria-label']
const DEFAULT_IGNORED_TAGS = ['script', 'style']

type Range = [number, number]

function collectCjk(text: string): Range[] {
  const out: Range[] = []
  CJK_TEXT_RE.lastIndex = 0
  let match = CJK_TEXT_RE.exec(text)
  while (match) {
    out.push([match.index, match.index + match[0].length])
    match = CJK_TEXT_RE.exec(text)
  }
  return out
}

function rangesOf(text: string, re: RegExp, group = 0): Range[] {
  const out: Range[] = []
  re.lastIndex = 0
  let match = re.exec(text)
  while (match) {
    const value = match[group] ?? ''
    const start = match.index + match[0].indexOf(value)
    out.push([start, start + value.length])
    if (!match[0].length)
      re.lastIndex++
    match = re.exec(text)
  }
  return out
}

/** 从 openParen 开始找配对的右括号，粗略跳过字符串内的括号 */
function findClosingParen(text: string, openParen: number): number {
  let depth = 0
  let quote = ''
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\')
        i++
      else if (ch === quote)
        quote = ''

      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth--
      if (depth <= 0)
        return i
    }
  }
  return text.length - 1
}

/** 函数调用（含参数）覆盖的区间 */
function callRanges(text: string, re: RegExp): Range[] {
  const out: Range[] = []
  re.lastIndex = 0
  let match = re.exec(text)
  while (match) {
    const open = text.indexOf('(', match.index)
    if (open >= 0) {
      out.push([match.index, findClosingParen(text, open) + 1])
      re.lastIndex = Math.max(re.lastIndex, open + 1)
    }
    match = re.exec(text)
  }
  return out
}

function inside(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(([s, e]) => s <= start && end <= e)
}

/**
 * 统计文档里的中文都分布在哪些「不会被提取」的位置。
 * @param text 文档全文
 * @param options 与检测时相同的 html 解析选项
 */
export function analyzeUntouchedChinese(text: string, options: ExtractionHTMLOptions = {}): ChineseBreakdown {
  const cjk = collectCjk(text)
  const attrs = options.attributes?.length ? options.attributes : DEFAULT_ATTRS
  const vBind = options.vBind !== false
  const ignoredTags = options.ignoredTags?.length ? options.ignoredTags : DEFAULT_IGNORED_TAGS

  const commentRanges: Range[] = [
    ...rangesOf(text, /<!--[\s\S]*?-->/g),
    ...rangesOf(text, /\/\*[\s\S]*?\*\//g),
    ...rangesOf(text, /\/\/[^\r\n]*/g),
  ]

  const consoleRanges = callRanges(text, /\bconsole\s*\.\s*[\w$]+(?:\s*\.\s*[\w$]+)*\s*\(/g)
  const wrappedRanges = callRanges(text, /(?<![\w$.])\$?t(?:c|n)?\s*\(/g)

  // 没纳入检测的属性值：v-if / v-show / save-text 这类
  const trackedAttr = (name: string) => {
    if (attrs.includes(name))
      return true
    return vBind && attrs.some(a => name === `:${a}` || name === `v-bind:${a}`)
  }

  const untrackedAttrRanges: Range[] = []
  const tagRe = /<([\w:-]+)([^>]*)>/g
  let tagMatch = tagRe.exec(text)
  while (tagMatch) {
    const tagName = tagMatch[1].toLowerCase()
    const shouldScan = !ignoredTags.includes(tagName) || tagName === 'template'
    if (shouldScan) {
      const attrsText = tagMatch[2] || ''
      const attrBase = tagMatch.index + 1 + tagMatch[1].length
      const attrRe = /([\w:@.$-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
      let attrMatch = attrRe.exec(attrsText)
      while (attrMatch) {
        const name = attrMatch[1]
        const raw = attrMatch[3] ?? attrMatch[4] ?? ''
        if (!trackedAttr(name) && raw && CJK_TEXT_RE.test(raw)) {
          CJK_TEXT_RE.lastIndex = 0
          const valueStart = attrBase + attrMatch.index + attrMatch[0].indexOf(attrMatch[2]) + 1
          untrackedAttrRanges.push([valueStart, valueStart + raw.length])
        }
        attrMatch = attrRe.exec(attrsText)
      }
    }
    tagMatch = tagRe.exec(text)
  }

  const report: ChineseBreakdown = {
    total: cjk.length,
    comment: 0,
    consoleCall: 0,
    wrapped: 0,
    untrackedAttribute: 0,
    other: 0,
  }

  for (const [start, end] of cjk) {
    if (inside(commentRanges, start, end))
      report.comment++
    else if (inside(consoleRanges, start, end))
      report.consoleCall++
    else if (inside(wrappedRanges, start, end))
      report.wrapped++
    else if (inside(untrackedAttrRanges, start, end))
      report.untrackedAttribute++
    else
      report.other++
  }

  return report
}

/** 把归因结果拼成一句人话，只列非零项 */
export function describeBreakdown(report: ChineseBreakdown): string {
  const parts: string[] = []
  if (report.comment)
    parts.push(`${report.comment} 处在注释里`)
  if (report.consoleCall)
    parts.push(`${report.consoleCall} 处在 console 输出里`)
  if (report.wrapped)
    parts.push(`${report.wrapped} 处已经被 $t() 包裹`)
  if (report.untrackedAttribute)
    parts.push(`${report.untrackedAttribute} 处在未纳入检测的属性（v-if / 自定义属性）里`)
  if (report.other)
    parts.push(`${report.other} 处未命中任何提取规则`)
  return parts.join('、')
}

/** 累加多个文件的归因结果 */
export function mergeBreakdown(reports: ChineseBreakdown[]): ChineseBreakdown {
  return reports.reduce<ChineseBreakdown>((acc, cur) => ({
    total: acc.total + cur.total,
    comment: acc.comment + cur.comment,
    consoleCall: acc.consoleCall + cur.consoleCall,
    wrapped: acc.wrapped + cur.wrapped,
    untrackedAttribute: acc.untrackedAttribute + cur.untrackedAttribute,
    other: acc.other + cur.other,
  }), { total: 0, comment: 0, consoleCall: 0, wrapped: 0, untrackedAttribute: 0, other: 0 })
}
