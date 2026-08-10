import { window } from 'vscode'
import { Translator, CurrentFile, Config, Global, AccaptableTranslateItem } from '~/core'

export async function TranslateAllMissing() {
  try {
    const loader = CurrentFile.loader
    const source = Config.sourceLanguage
    const locales = Global.allLocales.filter(locale => locale !== source && !Config.ignoredLocales.includes(locale))

    if (!locales.length) {
      window.showInformationMessage('没有可翻译的目标语言')
      return
    }

    const nodes: AccaptableTranslateItem[] = []

    for (const locale of locales) {
      const coverage = loader.getCoverage(locale)
      if (!coverage)
        continue

      const keysToTranslate = [...coverage.missingKeys, ...coverage.emptyKeys]

      for (const key of keysToTranslate) {
        const sourceNode = loader.getNodeByKey(key)
        if (sourceNode?.getValue(source)) {
          nodes.push({ locale, keypath: key, type: undefined })
        }
      }
    }

    if (!nodes.length) {
      window.showInformationMessage('没有待翻译的文案')
      return
    }

    window.showInformationMessage(`开始翻译 ${nodes.length} 条缺失/空值文案，源语言: ${source}`)

    await Translator.translateNodes(loader, nodes, source)
  }
  catch (e: any) {
    console.error('[TranslateAllMissing] Error:', e)
    window.showErrorMessage(`翻译出错: ${e?.message || e}`)
  }
}