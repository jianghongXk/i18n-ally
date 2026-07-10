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
