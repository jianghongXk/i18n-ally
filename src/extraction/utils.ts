import { DetectionResult } from '~/core/types'

const regexLeading = /^[\s\n]*/mg
const regexTailing = /[\s\n]+$/mg

// trailing unit suffix group(s) like (kW), (kWh), (m/s²), (元/MWh) — the group
// content may contain CJK as well; it gets split into translatable runs later
const UNIT_SUFFIX_REGEX = /(?:\s*[（(][^（()）]*[）)])+$/

// fully wrapped text like `（仅当前页面）` / `(仅当前页面)`: the brackets are
// punctuation, only the inner text is translatable
const FULLY_WRAPPED_REGEX = /^([（(])([^（()）]+)([）)])$/

// CJK ranges that should become their own $t() keys inside a unit suffix
export const CJK_CHAR_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/

/**
 * Split a trailing unit suffix like `(kW)` / `(元/MWh)` out of the text, so the
 * extracted key/value only contains the translatable part, and the unit can be
 * rebuilt in code as `$t('key') + '(kW)'` / `$t('key') + '(' + $t('k2') + '/MWh)'`.
 *
 * Only splits when the remaining text still contains non-ascii characters
 * (i.e. the translatable part), so pure-ascii texts are kept intact.
 */
export function splitUnitSuffix(text: string): { text: string; prefix: string; suffix: string } {
  // 整条被括号包住：`（仅当前页面）` -> 词条只留括号内的中文，两个括号由代码还原成
  // `'（' + $t('key') + '）'`。括号内必须是真文案（含非 ASCII），`(kW)` 这类不动。
  const wrapped = text.trim().match(FULLY_WRAPPED_REGEX)
  if (wrapped) {
    const inner = wrapped[2].trim()
    if (inner && /[^\x00-\x7F]/.test(inner))
      return { text: inner, prefix: wrapped[1], suffix: wrapped[3] }
  }

  const match = text.match(UNIT_SUFFIX_REGEX)
  if (!match?.index)
    return { text, prefix: '', suffix: '' }

  const main = text.slice(0, match.index).trimEnd()
  if (!main || !/[^\x00-\x7F]/.test(main))
    return { text, prefix: '', suffix: '' }

  return { text: main, prefix: '', suffix: match[0].trim() }
}

export interface UnitExprPart {
  /** `t` = translatable CJK run (gets its own key), `lit` = literal chunk */
  kind: 'lit' | 't'
  text: string
}

// standalone unit-like text: CJK prefix followed by a non-CJK tail, e.g. `元/MWh`
const STANDALONE_UNIT_SUFFIX_REGEX = /^([\u3400-\u4dbf\u4e00-\u9fff]+)([^\u3400-\u4dbf\u4e00-\u9fff]+)$/

/**
 * Split a standalone unit-like text such as `元/MWh` / `万元/kWh` into the
 * translatable prefix and the literal tail, so it can be rebuilt in code as
 * `$t('key') + '/MWh'`.
 *
 * Requires a `/` separator: plain mixed labels like `所属VPP` / `功率kW` are
 * kept intact. Also requires the CJK part to be the whole prefix and the tail
 * to have no CJK, so mixed labels such as `第3机组` are never split.
 */
export function splitStandaloneUnitSuffix(text: string): { text: string; prefix: string; suffix: string } {
  if (!text.includes('/'))
    return { text, prefix: '', suffix: '' }

  const match = text.trim().match(STANDALONE_UNIT_SUFFIX_REGEX)
  if (!match)
    return { text, prefix: '', suffix: '' }

  return { text: match[1], prefix: '', suffix: match[2] }
}

/**
 * Split a unit out of the text, supporting both the parenthesized form
 * (`中标价格(元/MWh)`), the fully wrapped form (`（仅当前页面）`) and the
 * standalone form (`元/MWh`).
 */
export function splitUnitOrStandalone(text: string): { text: string; prefix: string; suffix: string } {
  const paren = splitUnitSuffix(text)
  if (paren.suffix)
    return paren
  return splitStandaloneUnitSuffix(text)
}

/**
 * Slash-separated text with at least two translatable segments, e.g.
 * `中标/邀约次数` — each CJK segment deserves its own key for better reuse.
 * Texts containing braces (vue interpolations / `{0}` placeholders) are skipped.
 */
export function splitSlashSegments(text: string): string[] | undefined {
  if (!text.includes('/') || /[{}]/.test(text))
    return undefined

  const segments = text.split('/').map(s => s.trim()).filter(Boolean)
  if (segments.length < 2)
    return undefined
  if (segments.filter(s => CJK_CHAR_REGEX.test(s)).length < 2)
    return undefined

  return segments
}

/**
 * Rebuild a slash separated text into a chain of `$t()` calls, keeping the
 * wrapper of the original template intact:
 *   `$t('KEY')`          -> `$t(k1) + '/' + $t(k2)`
 *   `{{ $t('KEY') }}`    -> `{{ $t(k1) + '/' + $t(k2) }}`
 *   `:label="$t('KEY')"` -> `:label="$t(k1) + '/' + $t(k2)"`
 */
export function buildChainFromSegments(
  replaceTo: string,
  keypath: string,
  segments: string[],
  keyFor: (text: string) => string,
): string | undefined {
  // html interpolation: `{{ ... }}`
  const html = replaceTo.match(/^(\{\{\s*)([\s\S]*?)(\s*\}\})$/)
  if (html) {
    const inner = buildChainFromSegments(html[2], keypath, segments, keyFor)
    return inner == null ? undefined : `${html[1]}${inner}${html[3]}`
  }

  // bound attribute: `:label="..."` / `v-bind:label="..."`
  const attr = replaceTo.match(/^((?::|v-bind:)[\w-]+=")([\s\S]*)"$/)
  if (attr) {
    const inner = buildChainFromSegments(attr[2], keypath, segments, keyFor)
    return inner == null ? undefined : `${attr[1]}${inner}"`
  }

  // plain js expression: wrap every key with the same scaffold
  const idx = replaceTo.indexOf(keypath)
  if (idx < 0)
    return undefined

  const head = replaceTo.slice(0, idx)
  const tail = replaceTo.slice(idx + keypath.length)
  const atoms = segments.map((seg) => {
    if (CJK_CHAR_REGEX.test(seg))
      return `${head}${keyFor(seg)}${tail}`
    return `'${seg.replace(/'/g, '\\\'')}'`
  })

  return atoms.join(' + \'/\' + ')
}

/**
 * Tokenize a unit suffix (including its surrounding parens, e.g. `(元/MWh)`)
 * into runs of CJK characters (translatable) and non-CJK chunks (literal).
 */
export function tokenizeUnitSuffix(unit: string): UnitExprPart[] {
  const parts: UnitExprPart[] = []
  let buf = ''
  let curCjk: boolean | null = null

  const flush = () => {
    if (buf)
      parts.push({ kind: curCjk ? 't' : 'lit', text: buf })
    buf = ''
  }

  for (const ch of unit) {
    const cjk = CJK_CHAR_REGEX.test(ch)
    if (curCjk === null || cjk === curCjk) {
      buf += ch
      curCjk = cjk
    }
    else {
      flush()
      buf = ch
      curCjk = cjk
    }
  }
  flush()

  return parts
}

export function trimDetection(detection: DetectionResult): DetectionResult | undefined {
  const leadingSpace = detection.text.match(regexLeading)?.[0] || ''
  const tailingSpace = detection.text.match(regexTailing)?.[0] || ''
  detection.start += leadingSpace.length
  detection.end -= tailingSpace.length

  if (detection.start >= detection.end)
    return undefined

  return detection
}
