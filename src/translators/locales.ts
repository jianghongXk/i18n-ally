/**
 * 翻译引擎的「可用语言清单」。
 *
 * 背景：项目里的语言文件名由项目自己决定（chs.json / can.json / zh-Hans.json 都见过），
 * 而翻译 API 只认自己那套码（百度用 cht 而不是 zh-TW，用 jp 而不是 ja，用 kor 而不是 ko）。
 * 以前这层对应关系散落在每个引擎的 convertToSupportedLocales 里，既没法展示给用户，
 * 也没法在发请求前判断「这个项目里的语言到底能不能翻」，结果就是引擎把 chs / can
 * 原样发给百度、拿回一个错误码，插件静默丢掉这一条 —— 表现为「部分文案没翻译」。
 *
 * 这里把它提升为引擎能力声明，供三处消费：
 *   1. 引擎内部：把项目 locale 转成 API 语言码
 *   2. 配置命令：列出引擎支持的语言，让用户把项目语言文件逐个绑上去
 *   3. 翻译链路：发请求前校验，遇到绑定不了的语言明确报错，而不是静默跳过
 */

export interface EngineLocale {
  /** 真正发给翻译 API 的语言码 */
  code: string
  /** 配置界面里展示的名称 */
  name: string
  /** 项目语言文件名 / BCP47 / 常见简写，大小写不敏感 */
  aliases?: string[]
  /** 只能作为源语言（如 auto），不作为翻译目标 */
  sourceOnly?: boolean
  /** 补充说明，展示在配置界面里 */
  note?: string
}

/**
 * 百度通用文本翻译的语种表。
 * 以百度翻译开放平台的语种代码为准，同时把本插件 baidu.ts 原来 localeMap 里
 * 已经验证过的映射收进来；新增语种时只改这里，引擎与配置界面会同步生效。
 */
export const BAIDU_LOCALES: EngineLocale[] = [
  { code: 'auto', name: '自动检测', aliases: ['auto'], sourceOnly: true, note: '只用于源语言' },
  { code: 'zh', name: '中文（简体）', aliases: ['zh', 'chs', 'zh-cn', 'zh_cn', 'zh-hans', 'zh-hans-cn', 'zh-sg', 'cn', 'simplified-chinese'] },
  { code: 'cht', name: '中文（繁体）', aliases: ['cht', 'can', 'zh-tw', 'zh_tw', 'zh-hk', 'zh_hk', 'zh-hant', 'zh-hant-tw', 'tc', 'traditional-chinese'], note: 'can.json 这类繁体文件通常绑这里；若确实是粤语口语请绑 yue' },
  { code: 'yue', name: '粤语', aliases: ['yue', 'yue-hk', 'zh-yue', 'cantonese'] },
  { code: 'wyw', name: '文言文', aliases: ['wyw', 'classical-chinese'] },
  { code: 'en', name: '英语', aliases: ['en', 'en-us', 'en-gb', 'english'] },
  { code: 'jp', name: '日语', aliases: ['jp', 'ja', 'jpn', 'ja-jp'] },
  { code: 'kor', name: '韩语', aliases: ['kor', 'ko', 'ko-kr'] },
  { code: 'fra', name: '法语', aliases: ['fra', 'fr', 'fr-fr'] },
  { code: 'spa', name: '西班牙语', aliases: ['spa', 'es', 'es-es'] },
  { code: 'ru', name: '俄语', aliases: ['ru', 'ru-ru'] },
  { code: 'pt', name: '葡萄牙语', aliases: ['pt', 'pt-pt', 'pt-br'] },
  { code: 'de', name: '德语', aliases: ['de', 'de-de'] },
  { code: 'it', name: '意大利语', aliases: ['it', 'it-it'] },
  { code: 'el', name: '希腊语', aliases: ['el', 'el-gr'] },
  { code: 'nl', name: '荷兰语', aliases: ['nl', 'nl-nl'] },
  { code: 'pl', name: '波兰语', aliases: ['pl', 'pl-pl'] },
  { code: 'bul', name: '保加利亚语', aliases: ['bul', 'bg', 'bg-bg'] },
  { code: 'est', name: '爱沙尼亚语', aliases: ['est', 'et', 'et-ee'] },
  { code: 'dan', name: '丹麦语', aliases: ['dan', 'da', 'da-dk'] },
  { code: 'fin', name: '芬兰语', aliases: ['fin', 'fi', 'fi-fi'] },
  { code: 'cs', name: '捷克语', aliases: ['cs', 'cs-cz'] },
  { code: 'rom', name: '罗马尼亚语', aliases: ['rom', 'ro', 'ro-ro'] },
  { code: 'slo', name: '斯洛文尼亚语', aliases: ['slo', 'sl', 'sl-si'] },
  { code: 'swe', name: '瑞典语', aliases: ['swe', 'sv', 'sv-se'] },
  { code: 'hu', name: '匈牙利语', aliases: ['hu', 'hu-hu'] },
  { code: 'vie', name: '越南语', aliases: ['vie', 'vi', 'vi-vn'] },
  { code: 'th', name: '泰语', aliases: ['th', 'th-th'] },
  { code: 'ara', name: '阿拉伯语', aliases: ['ara', 'ar', 'ar-sa'] },
]

/**
 * Google 翻译的常用目标语言。
 * 免费接口与 Cloud v2 都接受 BCP47 写法（zh-CN / zh-TW），所以这里的 code
 * 直接用项目里最常见的写法；配置了 googleApiKey 时会改从 /languages 接口实时读取。
 */
export const GOOGLE_LOCALES: EngineLocale[] = [
  { code: 'zh-CN', name: '中文（简体）', aliases: ['zh', 'chs', 'zh-cn', 'zh_cn', 'zh-hans', 'cn', 'simplified-chinese'] },
  { code: 'zh-TW', name: '中文（繁体）', aliases: ['cht', 'can', 'zh-tw', 'zh_tw', 'zh-hk', 'zh-hant', 'tc', 'traditional-chinese'], note: 'can.json 这类繁体文件通常绑这里' },
  { code: 'en', name: '英语', aliases: ['en', 'en-us', 'en-gb', 'english'] },
  { code: 'ja', name: '日语', aliases: ['ja', 'jp', 'jpn', 'ja-jp'] },
  { code: 'ko', name: '韩语', aliases: ['ko', 'kor', 'ko-kr'] },
  { code: 'fr', name: '法语', aliases: ['fr', 'fra', 'fr-fr'] },
  { code: 'de', name: '德语', aliases: ['de', 'de-de'] },
  { code: 'es', name: '西班牙语', aliases: ['es', 'spa', 'es-es'] },
  { code: 'ru', name: '俄语', aliases: ['ru', 'ru-ru'] },
  { code: 'pt', name: '葡萄牙语', aliases: ['pt', 'pt-br', 'pt-pt'] },
  { code: 'it', name: '意大利语', aliases: ['it', 'it-it'] },
  { code: 'ar', name: '阿拉伯语', aliases: ['ar', 'ara'] },
  { code: 'th', name: '泰语', aliases: ['th', 'th-th'] },
  { code: 'vi', name: '越南语', aliases: ['vi', 'vie'] },
  { code: 'id', name: '印尼语', aliases: ['id', 'id-id'] },
  { code: 'nl', name: '荷兰语', aliases: ['nl', 'nl-nl'] },
  { code: 'pl', name: '波兰语', aliases: ['pl', 'pl-pl'] },
  { code: 'tr', name: '土耳其语', aliases: ['tr', 'tr-tr'] },
  { code: 'hi', name: '印地语', aliases: ['hi', 'hi-in'] },
  { code: 'uk', name: '乌克兰语', aliases: ['uk', 'uk-ua'] },
  { code: 'cs', name: '捷克语', aliases: ['cs', 'cs-cz'] },
  { code: 'sv', name: '瑞典语', aliases: ['sv', 'swe', 'sv-se'] },
  { code: 'da', name: '丹麦语', aliases: ['da', 'dan', 'da-dk'] },
  { code: 'fi', name: '芬兰语', aliases: ['fi', 'fin', 'fi-fi'] },
  { code: 'el', name: '希腊语', aliases: ['el', 'el-gr'] },
  { code: 'hu', name: '匈牙利语', aliases: ['hu', 'hu-hu'] },
  { code: 'ro', name: '罗马尼亚语', aliases: ['ro', 'rom', 'ro-ro'] },
  { code: 'auto', name: '自动检测', aliases: ['auto'], sourceOnly: true, note: '只用于源语言' },
]

/** DeepL 常用目标语言；配置了密钥时会改从 /v2/languages 实时读取。 */
export const DEEPL_LOCALES: EngineLocale[] = [
  { code: 'EN-US', name: '英语（美式）', aliases: ['en', 'en-us', 'english'] },
  { code: 'EN-GB', name: '英语（英式）', aliases: ['en-gb'] },
  { code: 'ZH', name: '中文（简体）', aliases: ['zh', 'chs', 'zh-cn', 'cn'] },
  { code: 'ZH-HANT', name: '中文（繁体）', aliases: ['cht', 'can', 'zh-tw', 'zh-hk', 'zh-hant', 'tc'], note: '项目里 can.json 请显式绑这里，否则会被截成 ZH 翻成简体' },
  { code: 'JA', name: '日语', aliases: ['ja', 'jp'] },
  { code: 'KO', name: '韩语', aliases: ['ko', 'kor'] },
  { code: 'FR', name: '法语', aliases: ['fr', 'fra'] },
  { code: 'DE', name: '德语', aliases: ['de'] },
  { code: 'ES', name: '西班牙语', aliases: ['es', 'spa'] },
  { code: 'RU', name: '俄语', aliases: ['ru'] },
  { code: 'PT-BR', name: '葡萄牙语（巴西）', aliases: ['pt', 'pt-br'] },
  { code: 'PT-PT', name: '葡萄牙语（葡萄牙）', aliases: ['pt-pt'] },
  { code: 'IT', name: '意大利语', aliases: ['it'] },
  { code: 'NL', name: '荷兰语', aliases: ['nl'] },
  { code: 'PL', name: '波兰语', aliases: ['pl'] },
  { code: 'AR', name: '阿拉伯语', aliases: ['ar', 'ara'] },
  { code: 'TR', name: '土耳其语', aliases: ['tr'] },
  { code: 'ID', name: '印尼语', aliases: ['id'] },
  { code: 'UK', name: '乌克兰语', aliases: ['uk'] },
  { code: 'VI', name: '越南语', aliases: ['vi', 'vie'] },
]

/** LibreTranslate 常见语言；服务可达时会改从 /languages 实时读取。 */
export const LIBRE_LOCALES: EngineLocale[] = [
  { code: 'zh', name: '中文（简体）', aliases: ['zh', 'chs', 'zh-cn', 'cn'] },
  { code: 'zt', name: '中文（繁体）', aliases: ['zt', 'cht', 'can', 'zh-tw', 'zh-hant'], note: 'LibreTranslate 的繁体码是 zt' },
  { code: 'en', name: '英语', aliases: ['en', 'en-us', 'en-gb'] },
  { code: 'ja', name: '日语', aliases: ['ja', 'jp'] },
  { code: 'ko', name: '韩语', aliases: ['ko', 'kor'] },
  { code: 'fr', name: '法语', aliases: ['fr', 'fra'] },
  { code: 'de', name: '德语', aliases: ['de'] },
  { code: 'es', name: '西班牙语', aliases: ['es', 'spa'] },
  { code: 'ru', name: '俄语', aliases: ['ru'] },
  { code: 'pt', name: '葡萄牙语', aliases: ['pt'] },
  { code: 'it', name: '意大利语', aliases: ['it'] },
  { code: 'ar', name: '阿拉伯语', aliases: ['ar', 'ara'] },
  { code: 'nl', name: '荷兰语', aliases: ['nl'] },
  { code: 'pl', name: '波兰语', aliases: ['pl'] },
  { code: 'tr', name: '土耳其语', aliases: ['tr'] },
  { code: 'vi', name: '越南语', aliases: ['vi', 'vie'] },
]

/**
 * 各引擎声明的「基础语言清单」。
 * 这是内置兜底：没有网络/密钥时配置界面与翻译链路仍然可用；引擎支持从服务
 * 实时读取时（DeepL / LibreTranslate / Google Cloud），结果会 merge 回这里，
 * 让 UI、别名解析、翻译前校验看到同一份数据。
 */
export const ENGINE_LOCALES: Record<string, EngineLocale[]> = {
  'baidu': BAIDU_LOCALES,
  'google': GOOGLE_LOCALES,
  'google-cn': GOOGLE_LOCALES,
  'deepl': DEEPL_LOCALES,
  'libretranslate': LIBRE_LOCALES,
}

/** 没有语言码概念的引擎，界面上的说明文字 */
export const ENGINE_LOCALE_NOTES: Record<string, string> = {
  openai: '按语言名写进提示词，不做语言码转换；项目里的语言标识会原样传给模型',
}

export type EngineLocaleListSource = 'builtin' | 'remote'

export interface EngineLocaleListResult {
  locales: EngineLocale[]
  source: EngineLocaleListSource
  note?: string
  /** 实时读取失败时的原因，界面上提示但保留内置清单 */
  error?: string
  /** 本次从接口拿到的条数 */
  fetched?: number
}

/** 按归一化 code 合并两份清单：远程结果补充新语种，内置别名始终保留 */
export function mergeEngineLocales(base: EngineLocale[], incoming: EngineLocale[]): EngineLocale[] {
  const result = base.map(l => ({ ...l, aliases: [...(l.aliases || [])] }))
  for (const item of incoming) {
    const key = normalizeEngineLocale(item.code)
    const found = result.find(l => normalizeEngineLocale(l.code) === key)
    if (!found) {
      result.push({ ...item, aliases: [...(item.aliases || [])] })
      continue
    }
    found.name = item.name || found.name
    found.note = item.note || found.note
    found.aliases = [...new Set([...(found.aliases || []), ...(item.aliases || []), key])]
  }
  return result
}

/**
 * 把引擎（或其 /languages 接口）读到的清单写回注册表。
 * 之后 Config.resolveTranslateLocale 与 isTranslateLocaleSupported 会同步认得这些新语种。
 */
export function registerEngineLocales(engine: string, locales: EngineLocale[], mode: 'replace' | 'merge' = 'merge') {
  ENGINE_LOCALES[engine] = mode === 'merge'
    ? mergeEngineLocales(ENGINE_LOCALES[engine] || [], locales)
    : locales
  return ENGINE_LOCALES[engine]
}

/** 语言码归一化：大小写不敏感，- 与 _ 等价 */
export function normalizeEngineLocale(locale: string): string {
  return (locale || '').trim().toLowerCase().replace(/_/g, '-')
}

export function getEngineLocales(engine: string): EngineLocale[] {
  return ENGINE_LOCALES[engine] || []
}

/** 在一份清单里按 API 语言码或项目别名查找 */
export function findLocaleIn(list: EngineLocale[], input: string): EngineLocale | undefined {
  const key = normalizeEngineLocale(input)
  if (!key)
    return undefined
  return list.find(l => normalizeEngineLocale(l.code) === key)
    || list.find(l => (l.aliases || []).some(a => normalizeEngineLocale(a) === key))
}

/** 按 API 语言码或项目别名查找 */
export function findEngineLocale(engine: string, input: string): EngineLocale | undefined {
  return findLocaleIn(getEngineLocales(engine), input)
}

/** 把项目里的 locale（语言文件名）解析成该引擎的 API 语言码 */
export function resolveEngineLocale(engine: string, locale: string): string | undefined {
  return findEngineLocale(engine, locale)?.code
}

/** 该引擎是否已经声明了可用语言清单 */
export function hasEngineLocaleList(engine: string): boolean {
  return getEngineLocales(engine).length > 0
}

/** 某个语言码是否在该引擎的可用清单里（不含 sourceOnly） */
export function isEngineLocaleSupported(engine: string, code: string, asSource = false): boolean {
  const found = findEngineLocale(engine, code)
  if (!found)
    return false
  return asSource ? true : !found.sourceOnly
}
