import { window } from 'vscode'
import { Translator, CurrentFile, Config, Global, AccaptableTranslateItem, TranslateSaveOutcome } from '~/core'

export async function TranslateAllMissing(
  options?: { skipConfirm?: boolean },
): Promise<TranslateSaveOutcome | undefined> {
  try {
    const loader = CurrentFile.loader
    // 配置里可能是 zh-cn，而项目里的简体中文文件叫 chs.json：先对齐到真实文件，
    // 否则过滤目标语言时会把源语言自己当成目标语言（或反过来把真源语言漏掉）。
    const source = Translator.alignSourceLanguage(loader, Config.sourceLanguage)
    const fallbackEnabled = Config.translateFallbackFromOtherLocales
    // 大小写不敏感：文件名通常是小写（zh-cn.json），设置里常写 zh-CN，
    // 直接用 !== / includes 会把源语言也当成目标语言，或让 ignoredLocales 失效。
    // 交叉引用开启时把源语言也纳入目标：源语言文件自己缺的 key 同样要补齐。
    const locales = Global.allLocales.filter(locale =>
      (fallbackEnabled || !Config.isSameLocale(locale, source))
      && !Config.ignoredLocales.some(ignored => Config.isSameLocale(ignored, locale)),
    )

    if (!locales.length) {
      window.showInformationMessage('没有可翻译的目标语言')
      return undefined
    }

    const nodes: AccaptableTranslateItem[] = []

    for (const locale of locales) {
      const coverage = loader.getCoverage(locale)
      if (!coverage)
        continue

      const keysToTranslate = [...coverage.missingKeys, ...coverage.emptyKeys]

      for (const key of keysToTranslate) {
        const node = loader.getNodeByKey(key)
        if (!node)
          continue
        // 以前只认「源语言有文案」，源语言缺值时整条 key 被跳过，永远补不回来。
        // 现在只要任意语言有文案，就交给 Translator.resolveSourceLocaleFor 决定
        // 该交叉引用谁当原文（配置关闭时仍走原来的源语言路径）。
        const hasAnyValue = Object.values(node.locales).some(r => !!r.value)
        if (hasAnyValue)
          nodes.push({ locale, keypath: key, type: undefined })
      }
    }

    if (!nodes.length) {
      window.showInformationMessage('没有待翻译的文案')
      return undefined
    }

    const mode = Config.translateSaveAsCandidates
      ? '（当前为候选模式，译文不会写入语言文件）'
      : ''
    const crossRef = fallbackEnabled
      ? `；源语言缺失的 key 会交叉引用其它语言（优先 ${Config.translateFallbackSourceOrder.join('、') || '项目语言顺序'}）`
      : ''
    window.showInformationMessage(`开始翻译 ${nodes.length} 条缺失/空值文案，源语言: ${source}${mode}${crossRef}`)

    // 必须 return：同步后端链路要靠这个结果判断译文有没有真正落盘
    return await Translator.translateNodes(loader, nodes, source, undefined, { skipConfirm: options?.skipConfirm })
  }
  catch (e: any) {
    console.error('[TranslateAllMissing] Error:', e)
    window.showErrorMessage(`翻译出错: ${e?.message || e}`)
    return undefined
  }
}
