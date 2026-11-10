/**
 * 语言标识 ↔ 项目真实语言文件的对齐。
 *
 * 背景：`i18n-ally.sourceLanguage` / `displayLanguage` 是「标识」，而项目里的语言
 * 文件叫什么由项目自己决定（Vue.Web 用 chs/can/en，ems 用 zh-cn/en/ja…）。
 * 以前这两者不做任何校验：设置里写 `zh-cn`，项目里只有 `chs.json`，翻译就会拿
 * `zh-cn` 去 `node.locales` 里找原文 —— 找不到，一条都翻不出来，界面上还看不出原因。
 *
 * 这里提供的是「按语义把标识映射到项目里真实存在的那个语言」的能力：
 *   1. 精确匹配（zh-cn ↔ zh-cn，大小写不敏感）
 *   2. 同语种匹配（zh-cn ↔ chs ↔ cn ↔ zh-Hans，靠引擎声明里的别名表归一）
 *   3. 主语言兜底（只对别名表里查不到的自定义标识生效，避免 zh-cn 误配到 zh-tw）
 *
 * 注意：本模块只依赖纯数据（translators/locales），不引 Config / Global，
 * 避免 Config → utils → Config 的循环依赖。
 */
import { ENGINE_LOCALES, normalizeEngineLocale } from '~/translators/locales'

export type LocaleMatchKind = 'exact' | 'alias' | 'base'

export interface ProjectLocaleMatch {
  /** 项目里真实存在的语言标识（文件名解析出来的那个） */
  locale: string
  kind: LocaleMatchKind
}

export interface ResolvedSourceLocale {
  /** 实际应该用来取原文的语言标识 */
  locale: string
  /** 配置里原本写的标识 */
  configured: string
  /** 是否发生了自动改写 */
  changed: boolean
  kind: LocaleMatchKind | 'none'
}

function baseTag(locale: string): string {
  return (locale || '').split(/[-_]/)[0].toLowerCase()
}

function sameLocale(a?: string | null, b?: string | null): boolean {
  if (!a || !b)
    return false
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * 把任意写法归一到「同一种语言」的稳定键。
 * 复用引擎声明的别名表（百度表覆盖最全，chs / can / cn / zh-Hans 都在里面），
 * 查不到返回 undefined，表示这是个自定义标识。
 */
export function canonicalLanguage(locale: string): string | undefined {
  const key = normalizeEngineLocale(locale)
  if (!key)
    return undefined
  for (const list of Object.values(ENGINE_LOCALES)) {
    const hit = list.find(l => !l.sourceOnly
      && (normalizeEngineLocale(l.code) === key
        || (l.aliases || []).some(a => normalizeEngineLocale(a) === key)))
    if (hit)
      return normalizeEngineLocale(hit.code)
  }
  return undefined
}

/**
 * 在项目已有的语言里找「配置想指的那个语言」。
 * @param configured 配置里的标识，如 zh-cn / chs
 * @param locales    项目里真实存在的语言标识（loader.locales）
 * @param prefer     同语种有多个候选时的优先项（一般是 displayLanguage）
 */
export function findProjectLocale(
  configured: string | undefined,
  locales: string[],
  prefer: string[] = [],
): ProjectLocaleMatch | undefined {
  if (!configured || !locales?.length)
    return undefined

  const exact = locales.find(l => sameLocale(l, configured))
  if (exact)
    return { locale: exact, kind: 'exact' }

  // 同语种有多个候选时（比如项目里同时有 zh-cn.json 和 chs.json），
  // 先看 prefer（默认显示语言）指向哪个，再按项目本身的顺序取第一个。
  const ordered = [
    ...new Set([
      ...prefer.filter(p => locales.some(l => sameLocale(l, p))),
      ...locales,
    ]),
  ]

  const target = canonicalLanguage(configured)
  if (target) {
    // 只在归一后完全相同的情况下才算匹配：zh-cn 不会误配到 zh-tw（后者归一到 cht）
    const hit = ordered.find(l => canonicalLanguage(l) === target)
    if (hit)
      return { locale: hit, kind: 'alias' }
    return undefined
  }

  // 别名表里没有的自定义标识，退到主语言子标签
  const base = baseTag(configured)
  const hit = ordered.find(l => baseTag(l) === base)
  return hit ? { locale: hit, kind: 'base' } : undefined
}

/**
 * 解析「翻译/提取时真正该用的源语言」。
 * 配置的标识在项目里有对应文件时原样返回；没有时按语种语义自动对齐到项目文件。
 * 项目语言还没加载（locales 为空）时不做任何改写，保持旧行为。
 */
export function resolveProjectLocale(
  configured: string,
  locales: string[],
  prefer: string[] = [],
): ResolvedSourceLocale {
  const match = findProjectLocale(configured, locales, prefer)
  if (!match)
    return { locale: configured, configured, changed: false, kind: 'none' }

  return {
    locale: match.locale,
    configured,
    changed: !sameLocale(match.locale, configured),
    kind: match.kind,
  }
}
