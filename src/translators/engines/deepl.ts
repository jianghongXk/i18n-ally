import axios from 'axios'
import qs from 'qs'

import type { EngineLocale } from '../locales'
import { findLocaleIn, normalizeEngineLocale } from '../locales'
import TranslateEngine, { TranslateOptions, TranslateResult } from './base'
import { Log } from '~/utils'
import { Config } from '~/core'

interface DeepLUsage {
  character_count: number
  character_limit: number
}

interface DeepLTranslate {
  detected_source_language: string
  text: string
}

interface DeepLTranslateRes {
  translations: DeepLTranslate[]
}

const deepl = axios.create({})

deepl.interceptors.request.use((req) => {
  req.baseURL = Config.deeplUseFreeApiEntry
    ? 'https://api-free.deepl.com/v2'
    : 'https://api.deepl.com/v2'

  req.params = {
    auth_key: Config.deeplApiKey,
  }

  if (req.method === 'POST' || req.method === 'post') {
    req.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req.data = qs.stringify(req.data)
  }

  log(true, req)

  return req
})

deepl.interceptors.response.use((res) => {
  log(true, res)

  return res
})

function log(inspector: boolean, ...args: any[]): void {
  if (Config.deeplLog) {
    // eslint-disable-next-line no-console
    if (inspector) console.log('[DeepL]\n', ...args)
    else Log.raw(...args)
  }
}

async function usage(): Promise<DeepLUsage> {
  try {
    return await deepl.get('/usage').then(({ data }) => data)
  }
  catch (err) {
    log(false, err)

    throw err
  }
}

function stripeLocaleCode(locale?: string): string | undefined {
  if (!locale)
    return locale
  const index = locale.indexOf('-')
  if (index === -1)
    return locale
  return locale.slice(0, index)
}

class DeepL extends TranslateEngine {
  get id() {
    return 'deepl'
  }

  /** DeepL 官方 /v2/languages：需要密钥，返回服务当前真正支持的目标语言 */
  async fetchSupportedLocales(): Promise<EngineLocale[] | undefined> {
    if (!Config.deeplApiKey)
      return undefined

    // 拦截器会覆盖 req.params（塞 auth_key），所以 type 直接拼在 url 上
    const { data } = await deepl.get('/languages?type=target', { timeout: 6000 })
    const list: { language: string; name: string }[] = Array.isArray(data) ? data : []
    if (!list.length)
      return undefined

    return list.map(l => ({
      code: l.language,
      name: l.name,
      aliases: [l.language],
      note: l.language.includes('-') ? '带变体的语言码，绑定后不会被截成主码' : undefined,
    }))
  }

  /**
   * 已经是引擎清单里的 API 码（EN-US / ZH-HANT 等）就原样传，
   * 否则按老规则截主码：项目里的 zh-CN / can 等由 Config 先解析过。
   */
  private normalizeApiLocale(locale?: string): string | undefined {
    if (!locale)
      return locale
    const found = findLocaleIn(this.supportedLocales, locale)
    if (found && normalizeEngineLocale(found.code) === normalizeEngineLocale(locale))
      return locale
    return stripeLocaleCode(locale)
  }

  async translate(options: TranslateOptions) {
    try {
      const res: DeepLTranslateRes = await deepl({
        method: 'POST',
        url: '/translate',
        data: {
          text: options.text,
          source_lang: this.normalizeApiLocale(options.from || undefined),
          target_lang: this.normalizeApiLocale(options.to),
        },
      }).then(({ data }) => data)

      return this.transform(res.translations, options)
    }
    catch (err) {
      log(false, err)

      throw err
    }
  }

  transform(res: DeepLTranslate[], options: TranslateOptions): TranslateResult {
    const r: TranslateResult = {
      text: options.text,
      to: options.to || 'auto',
      from: options.from || 'auto',
      response: res,
      linkToResult: '',
    }

    try {
      const result: string[] = []

      res.forEach((tran: DeepLTranslate) => result.push(tran.text))

      r.result = result
    }
    catch (err) {}

    if (!r.detailed && !r.result) r.error = new Error('No result')

    log(false, `DEEPL TRANSLATE!! ${JSON.stringify(r.result)}, from ${options.from} to ${options.to}`)

    return r
  }
}

export default DeepL

export {
  usage,
}
