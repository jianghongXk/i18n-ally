import axios from 'axios'
import type { EngineLocale } from '../locales'
import TranslateEngine, { TranslateOptions, TranslateResult } from './base'
import { Config } from '~/core'

export default class GoogleTranslate extends TranslateEngine {
  get id() {
    return 'google'
  }

  link = 'https://translate.google.com'
  apiRoot = 'https://translate.googleapis.com'
  apiRootIfUserSuppliedKey = 'https://translation.googleapis.com'

  /**
   * 免费接口没有语种列表端点；配置了 Cloud API key 时从官方 /languages 读取真实清单。
   * 没有 key 时返回 undefined，配置界面退回 GOOGLE_LOCALES 内置声明。
   */
  async fetchSupportedLocales(): Promise<EngineLocale[] | undefined> {
    const key = Config.googleApiKey
    if (!key)
      return undefined

    const { data } = await axios.get(`${this.apiRootIfUserSuppliedKey}/language/translate/v2/languages`, {
      params: { key, target: 'en' },
      timeout: 6000,
    })
    const languages: { language: string; name: string }[] = data?.data?.languages || []
    if (!languages.length)
      return undefined

    return languages.map(l => ({ code: l.language, name: l.name, aliases: [l.language] }))
      .filter(l => l.code !== 'auto')
  }

  async translate(options: TranslateOptions) {
    let {
      from = 'auto',
      to = 'auto',
    } = options

    const key = Config.googleApiKey

    if (key) {
      from = this.convertToSupportedLocalesForGoogleCloud(from)
      to = this.convertToSupportedLocalesForGoogleCloud(to)
    }

    const slugs = {
      from: from === 'auto' || !from ? '' : `&source=${from}`,
      to: to === 'auto' || !to ? '' : `&target=${to}`,
    }

    const { data } = await axios({
      method: 'GET',
      url: key
        ? `${this.apiRootIfUserSuppliedKey}/language/translate/v2?key=${key}&q=${encodeURI(options.text)}${slugs.from}${slugs.to}&alt=json&format=text`
        : `${this.apiRoot}/translate_a/single?client=gtx&sl=${from}&tl=${to}&hl=zh-CN&dt=t&dt=bd&ie=UTF-8&oe=UTF-8&dj=1&source=icon&q=${encodeURI(options.text)}`,
    })

    return this.transform(data, options, !!key)
  }

  convertToSupportedLocalesForGoogleCloud(locale: string): string {
    const longSupportedLocales = ['ceb', 'zh-TW', 'haw', 'hmn', 'auto']
    if (locale && !longSupportedLocales.includes(locale))
      locale = locale.substring(0, 2)

    return locale
  }

  transform(response: any, options: TranslateOptions, apiKeySuppliedByUser: boolean): TranslateResult {
    const {
      text,
      to = 'auto',
    } = options

    const r: TranslateResult = {
      text,
      to,
      from: response.src,
      response,
      linkToResult: `${this.link}/#auto/${to}/${text}`,
    }

    if (apiKeySuppliedByUser) {
      try {
        const result: string[] = []
        response.data.translations.forEach((v: any) => {
          result.push(v.translatedText)
        })
        r.result = result
      }
      catch (e) {}
    }

    else {
      // 尝试获取详细释义
      try {
        const detailed: string[] = []
        response.dict.forEach((v: any) => {
          detailed.push(`${v.pos}：${(v.terms.slice(0, 3) || []).join(',')}`)
        })
        r.detailed = detailed
      }
      catch (e) {}

      // 尝试取得翻译结果
      try {
        const result: string[] = []
        response.sentences.forEach((v: any) => {
          result.push(v.trans)
        })
        r.result = result
      }
      catch (e) {}
    }

    if (!r.detailed && !r.result)
      r.error = new Error('No result')

    return r
  }
}
