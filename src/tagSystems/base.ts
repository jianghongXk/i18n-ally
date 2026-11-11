import { FLAGS } from '~/utils'
import { DEFAULT_LOCALE_COUNTRY_MAP } from '~/meta'

export abstract class BaseTagSystem {
  normalize(locale?: string, fallback = 'en', strict = false): string {
    return locale || fallback
  }

  toBCP47(str: string): string | undefined {
    return str
  }

  fromBCP47(bcp47: string): string {
    return bcp47
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toFlagname(locale: string): string | undefined {
    return undefined
  }

  /** 只有 res/flags 里真实存在的名字才算合法，避免走到 unknown 的「?」 */
  protected isValidFlag(flag?: string): flag is string {
    return !!flag && FLAGS.includes(flag)
  }

  getFlagName(locale: string): string {
    const normalized = locale.replace(/_/g, '-').toLowerCase()
    const language = normalized.split('-')[0]

    // 顺序很重要：先看「整串」是不是一面真实存在的旗帜，再看各 tagSystem 拆出来的结果。
    // legacy 会把 es-CA 拆成 ca（加拿大），先看 primary 的话加泰罗尼亚永远显示加拿大旗；
    // 而 zh-CN 的 zh-cn 不在资源里，自然会落到下一步的 cn，不会被这条影响。
    if (this.isValidFlag(normalized))
      return normalized

    const primary = this.toFlagname(locale)
    if (this.isValidFlag(primary))
      return primary

    // 统一兜底：各 tagSystem 的 toFlagname 只负责「把 locale 拆成旗帜名」，
    // 拆出来不是合法旗帜就无解了。legacy 下 en 会拆成 'en'，而 res/flags 里没有
    // en.svg（en 是语言码不是国家），于是 EN 那行永远显示「?」；
    // ko / ja 只是碰巧有同名旗帜才没暴露。这里补一条各处共用的回退：
    //   语言部分（es-ca 若不在资源里，退回 es）→ 内置语言→国家表（en → us、vi → vn）
    const candidates = [language, (DEFAULT_LOCALE_COUNTRY_MAP as Record<string, string>)[language]]
    for (const candidate of candidates) {
      const flag = candidate?.toLowerCase()
      if (this.isValidFlag(flag))
        return flag
    }
    return 'unknown'
  }

  lookup(locale: string): string|undefined {
    return locale
  }
}
