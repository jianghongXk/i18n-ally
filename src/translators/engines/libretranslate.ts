import axios from 'axios'
import type { EngineLocale } from '../locales'
import TranslateEngine, { TranslateOptions, TranslateResult } from './base'
import { Config } from '~/core'

export default class LibreTranslate extends TranslateEngine {
  get id() {
    return 'libretranslate'
  }

  apiRoot = 'http://localhost:5000'

  /** LibreTranslate 服务的 /languages：无需密钥，服务可达时读真实清单 */
  async fetchSupportedLocales(): Promise<EngineLocale[] | undefined> {
    const root = (Config.libreTranslateApiRoot || this.apiRoot).replace(/\/$/, '')
    const { data } = await axios.get(`${root}/languages`, { timeout: 4000 })
    const list: { code: string; name: string }[] = Array.isArray(data) ? data : []
    if (!list.length)
      return undefined

    return list.map(l => ({ code: l.code, name: l.name, aliases: [l.code] }))
  }

  async translate(options: TranslateOptions) {
    const {
      from = 'auto',
      to = 'auto',
    } = options

    let apiRoot = this.apiRoot
    if (Config.libreTranslateApiRoot)
      apiRoot = Config.libreTranslateApiRoot

    const response = await axios.post(`${apiRoot}/translate`, {
      q: options.text,
      source: from,
      target: to,
      format: 'html',
    }, {
      headers: {
        'Content-Type': 'application/json',
      },
    },
    )

    return this.transform(response, options)
  }

  transform(response: any, options: TranslateOptions): TranslateResult {
    const {
      text,
      to = 'auto',
    } = options

    const r: TranslateResult = {
      text,
      to,
      from: response.src,
      response,
      result: [response.data.translatedText],
      linkToResult: '',
    }

    return r
  }
}
