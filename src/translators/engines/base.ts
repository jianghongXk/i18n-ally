import type { EngineLocale, EngineLocaleListResult } from '../locales'
import { findLocaleIn, getEngineLocales, mergeEngineLocales, normalizeEngineLocale, registerEngineLocales } from '../locales'

/** 实时读取结果缓存，避免每次打开配置面板都打一次接口 */
const remoteCache = new Map<string, { at: number; result: EngineLocaleListResult }>()
const REMOTE_CACHE_TTL = 10 * 60 * 1000

export interface TranslateEngineConfig {
  timeout?: number
  apiKey?: string
}

export interface TranslateOptions {
  text: string
  from?: string
  to?: string
}

export interface BatchTranslateOptions {
  texts: string[]
  from?: string
  to?: string
}

export interface TranslateResult {
  text: string
  from: string
  to: string
  response: any
  linkToResult: string
  error?: Error
  result?: string[]
  detailed?: string[]
}

export interface BatchTranslateResult {
  results: TranslateResult[]
}

export default abstract class TranslateEngine {
  constructor(public config: TranslateEngineConfig = {}) {}

  /** 引擎 id，对应 translators/index.ts 注册表与 translate.engines 里的名字 */
  get id(): string {
    return ''
  }

  /** 没有语言码概念的引擎，在配置界面里给出的说明 */
  get localesNote(): string | undefined {
    return undefined
  }

  /**
   * 该引擎可接受的 API 语言码清单。返回空数组表示引擎未声明清单，
   * 此时 resolveLocale 原样透传，保持旧引擎的行为不变。
   * 清单统一从注册表读取：引擎声明与 /languages 接口实时读取的结果都会写回这里，
   * 配置界面、别名解析、翻译前校验因此始终看到同一份数据。
   */
  get supportedLocales(): EngineLocale[] {
    return getEngineLocales(this.id)
  }

  /**
   * 从引擎服务实时读取支持的语言。返回 undefined 表示该引擎没有这种接口、
   * 或还缺密钥/服务不可达，此时退回内置清单。
   */
  async fetchSupportedLocales(): Promise<EngineLocale[] | undefined> {
    return undefined
  }

  /**
   * 配置界面读清单的唯一入口：内置声明兜底 + 接口实时读取（有缓存、可强制刷新）。
   * 读取成功会把结果合并回注册表，让翻译链路也认得接口返回的新语种。
   */
  async getSupportedLocales(force = false): Promise<EngineLocaleListResult> {
    const cached = remoteCache.get(this.id)
    if (!force && cached && Date.now() - cached.at < REMOTE_CACHE_TTL)
      return cached.result

    const builtin = this.supportedLocales
    let result: EngineLocaleListResult = {
      locales: builtin,
      source: 'builtin',
      note: this.localesNote,
    }

    try {
      const fetched = await this.fetchSupportedLocales()
      if (fetched?.length) {
        const merged = mergeEngineLocales(builtin, fetched)
        registerEngineLocales(this.id, merged, 'replace')
        result = {
          locales: merged,
          source: 'remote',
          note: this.localesNote,
          fetched: fetched.length,
        }
      }
    }
    catch (e) {
      result = {
        locales: builtin,
        source: 'builtin',
        note: this.localesNote,
        error: (e as Error).message,
      }
    }

    remoteCache.set(this.id, { at: Date.now(), result })
    return result
  }

  /** 把项目里的 locale（语言文件名）解析成引擎的 API 语言码；解析不了返回 undefined */
  resolveLocale(locale: string): string | undefined {
    if (!this.supportedLocales.length)
      return locale
    return findLocaleIn(this.supportedLocales, locale)?.code
  }

  /** 某个语言码能否作为该引擎的翻译目标 */
  isLocaleSupported(locale: string, asSource = false): boolean {
    if (!this.supportedLocales.length)
      return true
    const found = findLocaleIn(this.supportedLocales, locale)
    if (!found)
      return false
    return asSource ? true : !found.sourceOnly
  }

  /** 大小写不敏感的语言码比较 */
  isSameLocale(a?: string, b?: string): boolean {
    return !!a && !!b && normalizeEngineLocale(a) === normalizeEngineLocale(b)
  }

  resolve(lang: string) {
    return lang
  }

  abstract translate(options: TranslateOptions): Promise<TranslateResult>

  async translateBatch(options: BatchTranslateOptions): Promise<BatchTranslateResult> {
    const results: TranslateResult[] = []
    for (const text of options.texts) {
      const result = await this.translate({ text, from: options.from, to: options.to })
      results.push(result)
    }
    return { results }
  }
}
