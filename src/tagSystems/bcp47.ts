import * as bcp47 from 'bcp-47'
import { BaseTagSystem } from './base'
import { Config } from '~/core'
import { DEFAULT_LOCALE_COUNTRY_MAP } from '~/meta'

// https://tools.ietf.org/html/bcp47
export class BCP47 extends BaseTagSystem {
  normalize(locale?: string, fallback = 'en', strict = false) {
    if (!locale)
      return fallback

    return bcp47.stringify(bcp47.parse(locale, { normalize: strict, forgiving: !strict })) || fallback
  }

  toBCP47(locale: string) {
    return bcp47.stringify(bcp47.parse(locale, { normalize: true, forgiving: false })) || undefined
  }

  toFlagname(locale: string) {
    const { region, language } = bcp47.parse(locale, { normalize: true, forgiving: true })
    if (!language)
      return ''

    // 逐级兜底，第一个落在 res/flags 里的就用：
    //   ① localeCountryMap 的整串键（用户显式指定，优先级最高，如 ca → es-ca）
    //   ② locale 名本身就是旗帜名（ja / ko / vi / es-ca / es-eu / es-gl）
    //   ③ 显式地区（en-US → us、zh-TW → tw）
    //   ④ localeCountryMap 的语言键（en → us）
    //   ⑤ 内置默认表（④ 被写坏时还能救回来）
    //   ⑥ 语言码本身
    // ② 必须在 ③ 之前：es-CA 的地区是 CA，照 ③ 会显示成加拿大旗，
    // 而这几个条目本来就是「语言旗帜」。
    // 一路校验的原因：localeCountryMap 的值必须是旗帜名，但有人当成「语言显示名」
    // 写成 { en: "English" }，english.svg 不存在，EN 那一行就成了「?」。
    const candidates = [
      Config.localeCountryMap[locale.toLowerCase()],
      locale.toLowerCase(),
      region,
      Config.localeCountryMap[language],
      DEFAULT_LOCALE_COUNTRY_MAP[language as keyof typeof DEFAULT_LOCALE_COUNTRY_MAP],
      language,
    ]
    for (const candidate of candidates) {
      const flag = candidate?.toLowerCase()
      if (this.isValidFlag(flag))
        return flag
    }
    return language.toLowerCase()
  }

  lookup(locale: string) {
    locale = this.normalize(locale)
    // @ts-ignore
    const canonical = Intl.getCanonicalLocales(locale)[0]
    return Intl.Collator.supportedLocalesOf(canonical, { localeMatcher: 'lookup' })[0]
  }
}
