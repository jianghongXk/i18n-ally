import TranslateEngine, { TranslateOptions } from './engines/base'
import type { EngineLocaleListResult } from './locales'
import GoogleTranslateEngine from './engines/google'
import GoogleTranslateCnEngine from './engines/google-cn'
import DeepLTranslateEngine from './engines/deepl'
import LibreTranslateEngine from './engines/libretranslate'
import BaiduTranslate from './engines/baidu'
import OpenAITranslateEngine from './engines/openai'

export class Translator {
  engines: Record<string, TranslateEngine> ={
    'google': new GoogleTranslateEngine(),
    'google-cn': new GoogleTranslateCnEngine(),
    'deepl': new DeepLTranslateEngine(),
    'libretranslate': new LibreTranslateEngine(),
    'baidu': new BaiduTranslate(),
    'openai': new OpenAITranslateEngine(),
  }

  getEngine(key: string): TranslateEngine | undefined {
    return this.engines[key]
  }

  get engineIds(): string[] {
    return Object.keys(this.engines)
  }

  async translate(options: TranslateOptions & { engine: string }) {
    const engine = this.engines[options.engine]
    return await engine.translate(options)
  }
}

/**
 * 全扩展共用一组引擎实例：语言清单缓存、/languages 实时读取结果都挂在实例上，
 * 配置界面（core/Translator）与翻译执行读的是同一份，不会两边不一致。
 */
export const translator = new Translator()

/** 配置界面读「引擎支持哪些语言」的入口 */
export async function getEngineSupportedLocales(engine: string, force = false): Promise<EngineLocaleListResult> {
  const instance = translator.getEngine(engine)
  return instance
    ? instance.getSupportedLocales(force)
    : { locales: [], source: 'builtin' as const, note: '未知引擎' }
}

export {
  TranslateEngine,
  GoogleTranslateEngine,
  GoogleTranslateCnEngine,
  DeepLTranslateEngine,
  LibreTranslateEngine,
  BaiduTranslate,
  OpenAITranslateEngine,
}

export * from './engines/base'
export * from './locales'
