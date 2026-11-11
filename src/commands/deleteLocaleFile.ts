import path from 'path'
import { commands, Uri, window, workspace } from 'vscode'
import { Commands } from './commands'
import type { ExtensionModule } from '~/modules'
import { Config, CurrentFile, Global } from '~/core'
import { Log } from '~/utils'

interface LocaleItemArg {
  locale?: unknown
}

function relativeToRoot(filepath: string) {
  return path.relative(Global.rootpath, filepath).replace(/\\/g, '/')
}

/** 该 locale 在磁盘上的全部语言文件（单文件 / 多 namespace / 多目录都算） */
function filesOfLocale(locale: string): string[] {
  return (Global.loader?.files || [])
    .filter(file => Config.isSameLocale(file.locale, locale))
    .map(file => file.filepath)
}

/** 进度视图中行内按钮传进来的是树节点（带 locale），命令面板调用时没有参数 */
function localeFromArgument(arg?: unknown): string | undefined {
  if (typeof arg === 'string')
    return arg
  const locale = (arg as LocaleItemArg | undefined)?.locale
  return typeof locale === 'string' ? locale : undefined
}

async function pickLocale(): Promise<string | undefined> {
  const locales = Object.values(Global.allLocales || {})
  if (!locales.length) {
    window.showWarningMessage('还没有任何语言文件。用进度视图标题栏的「+」从翻译引擎语言清单创建一个。')
    return undefined
  }
  const source = Config.alignToProject(Global.loader?.locales)
  const picked = await window.showQuickPick(
    locales.map(locale => ({
      label: locale,
      description: Config.isSameLocale(locale, source)
        ? '源语言（不可删除）'
        : `${filesOfLocale(locale).length} 个文件`,
    })),
    {
      title: '删除语言文件',
      placeHolder: '选择要删除的语言；它的全部语言文件都会移到回收站',
    },
  )
  return picked?.label
}

/**
 * 删除单个语言在磁盘上的全部语言文件。
 * 只动翻译文件本身：翻译引擎的 localeMap 绑定保留（以后重建同名语言可直接复用），
 * 文件走系统回收站，误删还能捞回来。
 */
export async function deleteLocaleFile(arg?: unknown): Promise<void> {
  const root = Global.rootpath
  if (!root) {
    window.showErrorMessage('还没有打开的工作区，无法删除语言文件。')
    return
  }

  const locale = localeFromArgument(arg) || await pickLocale()
  if (!locale)
    return

  const source = Config.alignToProject(Global.loader?.locales)
  if (Config.isSameLocale(locale, source)) {
    window.showWarningMessage(`「${locale}」是源语言文件，不能删除。要删先把 sourceLanguage 改成别的语言。`)
    return
  }

  const files = filesOfLocale(locale)
  if (!files.length) {
    window.showWarningMessage(`没找到「${locale}」的语言文件：可能刚被删掉，或者它不在 loader 的识别范围内。`)
    return
  }

  const relatives = files.map(relativeToRoot)
  const warning = files.length === 1
    ? `确定删除语言「${locale}」的翻译文件？`
    : `确定删除语言「${locale}」的 ${files.length} 个翻译文件？`
  const choice = await window.showWarningMessage(
    warning,
    {
      modal: true,
      detail: `${relatives.join('\n')}\n\n文件会移到系统回收站（可手动还原）。翻译引擎的语言绑定会保留，之后用标题栏的「+」重建同名语言可以直接复用。`,
    },
    '删除',
  )
  if (choice !== '删除')
    return

  const failed: string[] = []
  for (const filepath of files) {
    try {
      await workspace.fs.delete(Uri.file(filepath), { useTrash: true })
    }
    catch (e) {
      failed.push(`${relativeToRoot(filepath)}（${(e as Error).message}）`)
    }
  }

  // 白名单里残留已删文件的路径会让下次加载一直报「文件不存在」，顺手清掉
  const whitelist = Config.localeFiles
  if (whitelist.length) {
    const removed = new Set(relatives.map(i => i.toLowerCase()))
    const next = whitelist.filter(i => !removed.has(i.toLowerCase()))
    if (next.length !== whitelist.length) {
      try {
        await Config.updateConfig('localeFiles', next, false)
      }
      catch (e) {
        Log.warn(`[delete-locale] 清理 localeFiles 白名单失败：${(e as Error).message}`)
      }
    }
  }

  try {
    await Global.loader?.reloadFromDisk()
    CurrentFile.invalidate()
  }
  catch (e) {
    Log.warn(`[delete-locale] 删除后刷新失败（文件监听会兜底）：${(e as Error).message}`)
  }

  const done = relatives.length - failed.length
  const message = failed.length
    ? `已删除「${locale}」的 ${done} 个文件，${failed.length} 个失败：${failed.join('、')}`
    : `已删除「${locale}」的 ${done} 个语言文件`
  Log.info(`[delete-locale] ${message}`)
  if (failed.length)
    window.showErrorMessage(message)
  else
    window.showInformationMessage(message)
}

const m: ExtensionModule = () => {
  return [
    commands.registerCommand(Commands.delete_locale_file, (arg?: unknown) => deleteLocaleFile(arg)),
  ]
}

export default m
