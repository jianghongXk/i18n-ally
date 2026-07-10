import crypto from 'crypto'
import axios from 'axios'
import qs from 'qs'
import TranslateEngine, { TranslateOptions, TranslateResult, BatchTranslateOptions, BatchTranslateResult } from './base'
import { Config } from '~/core'

interface BaiduSignOptions {
  appid: string | null | undefined
  salt: string
  secret: string | null | undefined
  query: string
}

export default class BaiduTranslate extends TranslateEngine {
  apiLink = 'https://fanyi.baidu.com'
  apiRoot = 'https://fanyi-api.baidu.com'

  async translate(options: TranslateOptions) {
    let { from = 'auto', to = 'auto' } = options

    from = this.convertToSupportedLocales(from)
    to = this.convertToSupportedLocales(to)

    const appid = Config.baiduAppid
    const secret = Config.baiduApiSecret
    const salt = Date.now().toString()
    const sign = this.getSign({ appid, secret, query: options.text, salt })

    const form = {
      q: options.text,
      appid,
      salt,
      from,
      to,
      sign,
    }

    const { data } = await axios({
      method: 'GET',
      url: `${this.apiRoot}/api/trans/vip/translate?${qs.stringify(form)}`,
    })

    return this.transform(data, options)
  }

  async translateBatch(options: BatchTranslateOptions): Promise<BatchTranslateResult> {
    let { from = 'auto', to = 'auto' } = options

    from = this.convertToSupportedLocales(from)
    to = this.convertToSupportedLocales(to)

    const appid = Config.baiduAppid
    const secret = Config.baiduApiSecret
    const salt = Date.now().toString()

    const validTexts: { text: string; index: number }[] = []
    const results: TranslateResult[] = new Array(options.texts.length)

    for (let i = 0; i < options.texts.length; i++) {
      const text = options.texts[i]
      if (!text || !text.trim()) {
        results[i] = {
          text,
          to,
          from,
          response: null,
          linkToResult: `${this.apiLink}/#${from}/${to}/${text}`,
          error: new Error('Empty or whitespace-only text'),
        }
      }
      else {
        validTexts.push({ text, index: i })
      }
    }

    if (validTexts.length === 0) {
      return { results }
    }

    const query = validTexts.map(t => t.text).join('\n')
    const byteLength = Buffer.byteLength(query, 'utf8')

    if (byteLength > 6000) {
      console.warn(`Batch query too long: ${byteLength} bytes, falling back to single translation`)
      for (const { text, index } of validTexts) {
        try {
          const result = await this.translate({ text, from, to })
          results[index] = result
        }
        catch (e) {
          results[index] = {
            text,
            to,
            from,
            response: null,
            linkToResult: `${this.apiLink}/#${from}/${to}/${text}`,
            error: e as Error,
          }
        }
      }
      return { results }
    }

    const sign = this.getSign({ appid, secret, query, salt })

    const form = {
      q: query,
      appid,
      salt,
      from,
      to,
      sign,
    }

    console.log(`Baidu translate batch: ${validTexts.length} valid texts, query length: ${query.length}`)

    const { data } = await axios({
      method: 'GET',
      url: `${this.apiRoot}/api/trans/vip/translate?${qs.stringify(form)}`,
    })

    console.log(`Baidu batch response: ${JSON.stringify(data)}`)

    try {
      const transResults = data.trans_result || []

      console.log(`Valid texts: ${validTexts.length}, Output results: ${transResults.length}`)

      if (transResults.length === 0) {
        throw new Error(`API returned empty results: ${JSON.stringify(data)}`)
      }

      for (let i = 0; i < validTexts.length; i++) {
        const { text, index } = validTexts[i]
        const r: TranslateResult = {
          text,
          to: data.to,
          from: data.from,
          response: data,
          linkToResult: `${this.apiLink}/#${data.from}/${data.to}/${text}`,
        }

        if (i < transResults.length) {
          r.result = [transResults[i].dst]
        }
        else {
          console.warn(`Missing result for text ${index}: "${text}"`)
          r.error = new Error('No result')
        }

        results[index] = r
      }
    }
    catch (e) {
      console.error('Batch translation error:', e)
      for (const { text, index } of validTexts) {
        results[index] = {
          text,
          to,
          from,
          response: data,
          linkToResult: `${this.apiLink}/#${from}/${to}/${text}`,
          error: new Error((`[${data.error_code}] ${data.error_msg}`) || 'Batch translation failed'),
        }
      }
    }

    return { results }
  }

  convertToSupportedLocales(locale: string): string {
    const normalized = locale.replace(/-/g, '_')
    const localeMap: Record<string, string> = {
      ja: 'jp',
      ko: 'kor',
      fr: 'fra',
      es: 'spa',
      ar: 'ara',
      ru: 'ru',
      pt: 'pt',
      de: 'de',
      it: 'it',
      el: 'el',
      nl: 'nl',
      pl: 'pl',
      bul: 'bul',
      est: 'est',
      dan: 'dan',
      fin: 'fin',
      cs: 'cs',
      rom: 'rom',
      slo: 'slo',
      swe: 'swe',
      hu: 'hu',
      vie: 'vie',
      th: 'th',
      zh: 'zh',
      zh_CN: 'zh',
      zh_TW: 'cht',
      zh_HK: 'cht',
    }
    
    if (localeMap[normalized])
      return localeMap[normalized]
    
    const primary = normalized.split('_')[0]
    return localeMap[primary] || primary
  }

  getSign({ appid, salt, query, secret }: BaiduSignOptions): string {
    if (appid && salt) {
      const string = appid + query + salt + secret
      const md5 = crypto.createHash('md5')
      md5.update(string)
      return md5.digest('hex')
    }
    return ''
  }

  transform(response: any, options: TranslateOptions): TranslateResult {
    const { text } = options

    const r: TranslateResult = {
      text,
      to: response.to,
      from: response.from,
      response,
      linkToResult: `${this.apiLink}/#${response.from}/${response.to}/${text}`,
    }

    try {
      const result: string[] = []
      response.trans_result.forEach((v: any) => {
        result.push(v.dst)
      })
      r.result = result
    }
    catch (e) {}

    if (!r.result) r.error = new Error((`[${response.error_code}] ${response.error_msg}`) || 'No result')

    return r
  }
}
