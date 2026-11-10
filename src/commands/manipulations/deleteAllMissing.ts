import { window } from 'vscode'
import { CurrentFile, Config, Global, LocaleRecord } from '~/core'
import { ProgressMissingListItem } from '~/views'

export async function DeleteAllMissing(item?: ProgressMissingListItem) {
  try {
    const loader = CurrentFile.loader
    const targetLocale = item?.node?.locale
    // 源语言要对齐到项目真实文件（chs.json），否则会把源语言也当目标语言清掉
    const source = Config.alignToProject(Global.allLocales)
    const locales = targetLocale
      ? [targetLocale]
      : Global.allLocales.filter(locale =>
        !Config.isSameLocale(locale, source)
        && !Config.ignoredLocales.some(ignored => Config.isSameLocale(ignored, locale)),
      )

    if (!locales.length) {
      window.showInformationMessage('没有可删除的目标语言')
      return
    }

    const records: LocaleRecord[] = []
    const seenKeys = new Set<string>()

    for (const locale of locales) {
      const coverage = loader.getCoverage(locale)
      if (!coverage)
        continue

      for (const key of coverage.missingKeys) {
        if (seenKeys.has(key))
          continue
        seenKeys.add(key)

        const sourceNode = loader.getNodeByKey(key)
        if (sourceNode) {
          for (const localeRecord of Object.values(sourceNode.locales))
            records.push(localeRecord)
        }
      }
    }

    if (!records.length) {
      window.showInformationMessage('没有缺失的文案路径可删除')
      return
    }

    const confirmMsg = item
      ? `确认删除 "${targetLocale}" 中 ${seenKeys.size} 条缺失文案的所有路径（从全部语言中移除）？此操作不可恢复。`
      : `确认从全部目标语言中删除 ${seenKeys.size} 条缺失文案（从全部语言中移除）？此操作不可恢复。`

    const result = await window.showWarningMessage(
      confirmMsg,
      { modal: true },
      '确定删除',
    )
    if (result !== '确定删除')
      return

    await loader.write(
      records
        .filter(r => !r.shadow)
        .map(r => ({
          value: undefined,
          keypath: r.keypath,
          filepath: r.filepath,
          locale: r.locale,
          features: r.features,
        })),
      false,
    )

    window.showInformationMessage(`已删除 ${records.length} 条路径`)
  }
  catch (e: any) {
    console.error('[DeleteAllMissing] Error:', e)
    window.showErrorMessage(`删除出错: ${e?.message || e}`)
  }
}
