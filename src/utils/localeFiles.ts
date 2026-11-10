/**
 * 扫描项目里真实存在的语言文件，并按插件自己的 pathMatcher 解析出 locale。
 *
 * 以前「配置翻译语言映射」靠一套写死的文件名正则认语言文件，只认得
 * chs.json / zh-CN.json 这种平铺命名，遇到 locales/zh-CN/common.json、
 * messages.en.json 就漏；而 loader 其实已经把这些文件读进来了。
 * 这里把「目录扫描 + 路径匹配」做成不依赖 vscode/core 的纯函数，
 * 命令侧再与 Global.loader.files 的解析结果合并，两边互为补充：
 *   - loader 认得的：用 loader 给的 locale（翻译链路真正使用的那个标识）
 *   - 磁盘上有但 loader 没认出来的：用 pathMatcher 从相对路径提取
 *   - 仍然匹配不上的（commWord.json 等）：保留为「未识别」，界面上可手动纳入
 */
import fs from 'fs'
import path from 'path'
import { ParsePathMatcher, ReplaceLocale } from './PathMatcher'

export interface LocaleMatcher {
  regex: RegExp
  matcher: string
}

export interface ScannedFile {
  /** 绝对路径 */
  filepath: string
  /** 相对扫描根目录的路径（统一用 /） */
  relativePath: string
  /** 从路径里提取到的语言标识；undefined 表示没认出来 */
  locale?: string
  /** 命中的 pathMatcher */
  matcher?: string
  namespace?: string
  /** 文件里的词条数（能解析时） */
  keyCount?: number
  /** 是否被识别成语言文件 */
  recognized: boolean
}

export const LOCALE_FILE_EXT_RE = /\.(json5?|ya?ml|js|ts)$/i
export const LOCALE_EXTS = 'json|json5|ya?ml|js|ts'

/** 明显不是语言文件的常见数据/配置文件名 */
export const NOT_LOCALE_FILE = /^(index|package(?:-lock)?|pnpm-lock|yarn|tsconfig|jsconfig|settings|config|mock|mocks|data|manifest|app|env|schema|routes|menu|dict|constants)$/i

/** 语言码形态：2-3 位主语言 + 最多两段子标签（chs / can / en / zh-CN / pt-BR） */
export const LOCALE_NAME_RE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8}){0,2}$/i

/**
 * pathMatcher 里的 {locale} 是宽松的 [\w-_]+，会把 commWord.json 的 commWord、
 * messages.en.json 的 common 之类也当成语言。这里做一次形态校验，
 * 避免把普通数据文件误列成语言；确实需要的项目可以在界面里手动纳入。
 */
export function isPlausibleLocale(locale?: string): boolean {
  return !!locale && LOCALE_NAME_RE.test(locale)
}

const SKIP_DIRS = /^(node_modules|\.git|\.vscode|\.idea|dist|build|out|coverage|vendor|\.cache|__pycache__)$/i

export interface ScanOptions {
  matchers?: LocaleMatcher[]
  maxDepth?: number
  maxFiles?: number
  /** 是否允许「文件名长得像语言码」作为兜底识别 */
  fallbackByFilename?: boolean
}

/**
 * 没有自定义 pathMatcher 时的通用规则，覆盖常见的平铺 / 按语言分目录 /
 * 按命名空间分目录三种布局。
 */
export function defaultLocaleMatchers(): LocaleMatcher[] {
  const rules = [
    '{locale}.{ext}',
    '{locale}/{namespace}.{ext}',
    '{locale}/{namespaces}.{ext}',
    '{namespaces}/{locale}.{ext}',
    '{namespace}.{locale}.{ext}',
    '{namespace}/{locale}.{ext}',
  ]
  return rules.map(matcher => ({
    matcher,
    regex: ParsePathMatcher(matcher, LOCALE_EXTS),
  }))
}

/** 按 pathMatcher 从相对路径里提取 {locale} / {namespace} */
export function matchLocaleFromPath(
  relativePath: string,
  matchers: LocaleMatcher[],
): { locale?: string; matcher?: string; namespace?: string } {
  const normalized = relativePath.replace(/\\/g, '/')
  const candidates = [normalized, path.posix.basename(normalized)]
  for (const candidate of candidates) {
    for (const { regex, matcher } of matchers) {
      const match = regex.exec(candidate)
      const locale = match?.groups?.locale
      if (locale && isPlausibleLocale(locale)) {
        return {
          locale,
          namespace: match?.groups?.namespace || match?.groups?.namespaces,
          matcher,
        }
      }
    }
  }
  return {}
}

/** 统计语言文件里的词条数（递归到叶子），解析失败返回 undefined */
export function countLocaleKeys(filepath: string): number | undefined {
  try {
    const raw = fs.readFileSync(filepath, 'utf-8').replace(/^\uFEFF/, '')
    if (!/\.json5?$/i.test(filepath))
      return undefined
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object')
      return undefined
    let count = 0
    const walk = (node: any, depth = 0) => {
      if (depth > 8 || !node || typeof node !== 'object')
        return
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object' && !Array.isArray(value))
          walk(value, depth + 1)
        else
          count += 1
      }
    }
    walk(data)
    return count
  }
  catch {
    return undefined
  }
}

/**
 * 扫描 localesPaths 下的真实文件。
 * 返回「识别为语言文件」和「未识别」的所有候选文件，由界面决定要不要纳入。
 */
export function scanLocaleFiles(dirs: string[], options: ScanOptions = {}): ScannedFile[] {
  const {
    matchers = defaultLocaleMatchers(),
    maxDepth = 3,
    maxFiles = 800,
    fallbackByFilename = true,
  } = options

  const results: ScannedFile[] = []
  const seen = new Set<string>()

  const walk = (dir: string, root: string, depth: number) => {
    if (depth > maxDepth || results.length >= maxFiles)
      return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxFiles)
        break
      const fullpath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.test(entry.name))
          walk(fullpath, root, depth + 1)
        continue
      }
      if (!entry.isFile() || !LOCALE_FILE_EXT_RE.test(entry.name))
        continue
      const key = fullpath.toLowerCase()
      if (seen.has(key))
        continue
      seen.add(key)

      const relativePath = path.relative(root, fullpath).replace(/\\/g, '/')
      const matched = matchLocaleFromPath(relativePath, matchers)
      let locale = matched.locale
      let matcher = matched.matcher
      const base = entry.name.replace(LOCALE_FILE_EXT_RE, '')

      // 没命中 pathMatcher 时，文件名本身像语言码也算（chs.json / can.json）。
      // 但 commWord、manifest 这类普通数据文件必须排除，不能当成语言。
      if (!locale && fallbackByFilename && !NOT_LOCALE_FILE.test(base) && LOCALE_NAME_RE.test(base)) {
        locale = base
        matcher = '{locale}.{ext}（按文件名推断）'
      }

      results.push({
        filepath: fullpath,
        relativePath,
        locale,
        matcher,
        namespace: matched.namespace,
        keyCount: locale ? countLocaleKeys(fullpath) : undefined,
        recognized: !!locale,
      })
    }
  }

  for (const dir of dirs) {
    try {
      if (fs.statSync(dir).isDirectory())
        walk(dir, dir, 0)
    }
    catch {
      // 目录不存在时跳过，界面会提示先跑初始化引导
    }
  }

  return results
}

// #region 从已有语言文件创建新的语言文件

const WRITABLE_EXTS = /^\.(json|json5|ya?ml)$/i

export function isWritableLocaleExt(ext: string): boolean {
  return WRITABLE_EXTS.test(ext)
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const uniq = <T>(list: T[]): T[] => [...new Set(list)]

/** 项目里最通用的语言码写法：引擎自有码（百度的 jp / kor）让位给 ISO 写法 */
const COMMON_PROJECT_LOCALES = new Set([
  'en', 'en-us', 'en-gb', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'it', 'pt', 'pt-br',
  'zh', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-hans', 'zh-hant', 'ar', 'th', 'vi', 'id',
  'nl', 'pl', 'cs', 'hu', 'sv', 'da', 'fi', 'no', 'el', 'ro', 'sl', 'et', 'bg', 'tr', 'he', 'hi', 'uk',
])

/**
 * 依据「项目里已有语言标识」的命名风格，给新建语言文件建议一个语言标识。
 *
 * - 项目全是 chs / can / en 这种小写短码 → 优先 cht / ja 这种短码
 * - 项目里有 zh-cn / pt-BR → 优先 zh-TW 这种带子标签的写法
 * - 已被占用的别名直接排除，避免建出重名文件
 */
export function suggestLocaleName(
  code: string,
  aliases: string[] = [],
  existing: string[] = [],
): string {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/_/g, '-')
  const taken = new Set(existing.map(normalize))
  const candidates = uniq([...aliases, code].map(s => s.trim()).filter(Boolean))
  const shortLower = /^[a-z]{2,3}$/
  const allShort = existing.length > 0 && existing.every(l => shortLower.test(l))
  const hasSubtag = existing.some(l => /[-_]/.test(l))

  const score = (s: string) => {
    let n = 0
    if (allShort && shortLower.test(s))
      n += 4
    if (hasSubtag && s.includes('-'))
      n += 3
    if (!allShort && !hasSubtag && /^[a-z]{2,3}[-_][a-z0-9]{2,8}$/i.test(s))
      n += 2
    if (COMMON_PROJECT_LOCALES.has(normalize(s)))
      n += 2
    if (s === code)
      n += 1
    return n
  }

  const usable = candidates.filter(s => !taken.has(normalize(s)))
  return usable.sort((a, b) => score(b) - score(a))[0] || code
}

/**
 * 由源语言文件路径推导新语言文件路径，保持项目原有的目录结构与命名方式：
 *   src/assets/chs.json             → src/assets/ja.json
 *   src/locales/files/zh-cn.json    → src/locales/files/zh-TW.json
 *   locales/zh-CN/common.json       → locales/ja/common.json
 *   messages.en.json                → messages.ja.json
 *
 * 先用 loader 命中过的 pathMatcher（与插件自己缺文件时补全路径的做法一致），
 * 匹配不上再按路径片段里的语言码替换，最后退回「同目录 / 新语言码.原扩展名」。
 */
export function deriveLocaleFilePath(
  sourceFile: string,
  baseDir: string,
  sourceLocale: string,
  targetLocale: string,
  matcher?: string,
  exts = '',
): string {
  const relative = path.relative(baseDir, sourceFile).replace(/\\/g, '/')
  const cleanMatcher = matcher?.replace(/（.*$/, '').trim()

  if (cleanMatcher) {
    try {
      const replaced = ReplaceLocale(relative, cleanMatcher, targetLocale, exts)
      if (replaced !== relative && replaced.toLowerCase().includes(targetLocale.toLowerCase()))
        return path.join(baseDir, replaced.replace(/\//g, path.sep))
    }
    catch {
      // pathMatcher 太特殊时退回按片段替换
    }
  }

  const segments = relative.split('/')
  const token = new RegExp(`(^|[^a-z0-9])(${escapeRegExp(sourceLocale)})(?=[^a-z0-9]|$)`, 'i')
  for (let i = segments.length - 1; i >= 0; i--) {
    if (token.test(segments[i])) {
      segments[i] = segments[i].replace(token, (_match, prefix) => `${prefix}${targetLocale}`)
      return path.join(baseDir, segments.join(path.sep))
    }
  }

  const ext = path.posix.extname(relative) || '.json'
  return path.join(baseDir, path.posix.dirname(relative), `${targetLocale}${ext}`)
}

/** 生成与源语言文件同结构、但叶子值全为空串的对象，供「翻译全部缺失」逐条填充 */
export function buildEmptySkeleton(data: unknown): Record<string, any> {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return {}
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(data as Record<string, any>)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? buildEmptySkeleton(value)
      : ''
  }
  return result
}

/** 从源文件内容里猜缩进，尽量让新文件和原文件排版一致 */
export function detectIndent(raw: string): string | number {
  const line = raw.split(/\r?\n/).find(l => /^([ \t]+)\S/.test(l))
  const spaces = line?.match(/^([ \t]+)/)?.[1]
  if (!spaces)
    return 2
  return spaces.includes('\t') ? '\t' : spaces.length
}

// #endregion
