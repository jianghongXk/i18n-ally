import { window } from 'vscode'
import { CurrentFile, LocaleRecord } from '~/core'

const ALPHA = /[A-Za-z]/
const PREVIEW_LIMIT = 10

/**
 * 批量删除「含字母的字符串 key」（如 `1_3G_XJ_XCTD_T4_LZO2IA_EULC`），
 * 保留纯数字的后端码 key（如 `401`、`1002802`）。
 *
 * 遍历所有语言文件中实际存在的记录，先弹确认框（含数量与前几个示例），
 * 确认后逐条写入 undefined 触发删除。
 */
export async function DeleteAlphaKeys() {
  try {
    const loader = CurrentFile.loader
    const nodes = Object.values(loader.flattenLocaleTree)
    const targets = nodes.filter(n => ALPHA.test(n.keypath))

    if (!targets.length) {
      window.showInformationMessage('没有找到含字母的 key，无需清理')
      return
    }

    const records: LocaleRecord[] = []
    for (const node of targets) {
      for (const record of Object.values(node.locales)) {
        if (!record.shadow && record.value !== undefined)
          records.push(record)
      }
    }

    if (!records.length) {
      window.showInformationMessage('这些 key 在各语言文件里都没有实际值，无需清理')
      return
    }

    const preview = targets.slice(0, PREVIEW_LIMIT).map(n => `  ${n.keypath}`).join('\n')
    const more = targets.length > PREVIEW_LIMIT ? `\n  …等共 ${targets.length} 个 key` : ''
    const locales = [...new Set(records.map(r => r.locale))]

    const confirmMsg = [
      `将删除 ${targets.length} 个含字母的 key，共 ${records.length} 条记录`,
      `涉及语言：${locales.join(', ')}`,
      '',
      preview + more,
      '',
      '纯数字 key 会被保留。此操作不可恢复。',
    ].join('\n')

    const result = await window.showWarningMessage(confirmMsg, { modal: true }, '确定删除')
    if (result !== '确定删除')
      return

    await loader.write(
      records.map(r => ({
        value: undefined,
        keypath: r.keypath,
        filepath: r.filepath,
        locale: r.locale,
        features: r.features,
      })),
      false,
    )

    window.showInformationMessage(`已删除 ${targets.length} 个含字母的 key（${records.length} 条记录）`)
  }
  catch (e: any) {
    console.error('[DeleteAlphaKeys] Error:', e)
    window.showErrorMessage(`删除出错: ${e?.message || e}`)
  }
}
