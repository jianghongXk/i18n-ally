import { commands, TextDocument, Uri, window, workspace } from 'vscode'
import { notNullish } from '@antfu/utils'
import fs from 'fs-extra'
import { DetectHardStrings } from './detectHardStrings'
import { ExtensionModule } from '~/modules'
import { Commands } from '~/commands'
import { extractHardStrings, generateKeyFromText } from '~/core/Extract'
import { Config, Global } from '~/core'
import { parseHardString } from '~/extraction/parseHardString'
import { splitUnitOrStandalone } from '~/extraction/utils'
import { analyzeUntouchedChinese, ChineseBreakdown, describeBreakdown, mergeBreakdown } from '~/extraction/explain'
import { DetectionResultToExtraction } from '~/editor/extract'
import { Log } from '~/utils'
import { gitignoredGlob } from '~/utils/glob'
import { ActionSource, Telemetry, TelemetryKey } from '~/core/Telemetry'

export async function BatchHardStringExtraction(...args: any[]) {
  const documents: (TextDocument | undefined)[] = []
  let actionSource: ActionSource

  // call from file explorer context
  if (args.length >= 2 && Array.isArray(args[1])) {
    actionSource = ActionSource.ContextMenu
    const map = new Map<string, Uri>()

    for (const uri of args[1]) {
      // folder, scan glob
      if (fs.lstatSync(uri.fsPath).isDirectory()) {
        const files = await gitignoredGlob('**/*.*', uri.fsPath)

        files.forEach((f) => {
          if (!map.has(f))
            map.set(f, Uri.file(f))
        })
      }
      // file, append to the map
      else {
        map.set(uri.fsPath, uri)
      }
    }

    const files = [...map.values()]

    documents.push(
      ...await Promise.all(files.map(i => workspace.openTextDocument(i))),
    )
  }
  // call from command pattale
  else {
    actionSource = ActionSource.CommandPattele
    documents.push(window.activeTextEditor?.document)
  }

  Telemetry.track(TelemetryKey.ExtractStringBulk, { source: actionSource, files: documents.length })

  Log.info('📤 Bulk extracting')
  Log.info(documents.map(i => `  ${i?.uri.fsPath}`).join('\n'))

  // same text must resolve to the same key across the whole run
  const textKeyCache = new Map<string, string>()

  // 以前整批跑完没有任何回执：检测到 0 条时用户完全不知道是没中文、还是被过滤了，
  // 只能怀疑「功能坏了」。这里把每个文件的检测结果收起来，最后给一次汇总。
  const emptyReports: ChineseBreakdown[] = []
  let scanned = 0
  let unsupported = 0
  let extracted = 0

  for (const document of documents) {
    if (!document)
      continue

    try {
      scanned += 1
      const result = await DetectHardStrings(document, false)
      Log.info(`📤 Extracting [${result?.length || 0}] ${document.uri.fsPath}`)

      // 语言没有对应的提取框架：batch 模式传了 warn=false，以前连提示都没有
      if (!result) {
        unsupported += 1
        continue
      }

      if (!result.length) {
        emptyReports.push(analyzeUntouchedChinese(document.getText(), Config.extractParserHTMLOptions))
        continue
      }

      const usedKeys: string[] = []

      const extracts = result.map((i) => {
        const options = DetectionResultToExtraction(i, document)

        if (options.rawText && !options.text) {
          const result = parseHardString(options.rawText, options.document.languageId, options.isDynamic)
          options.text = result?.text || ''
          options.args = result?.args
        }

        const { rawText, text, range, args } = options
        const filepath = document.uri.fsPath

        // split trailing unit suffix like "(kW)" out of the text,
        // so the key/value only contains the translatable part,
        // and the replacement becomes `$t('key') + '(kW)'`
        // 整条被括号包住的（`（仅当前页面）`）会额外拆出左括号，
        // 替换成 `'（' + $t('key') + '）'`
        const split = args?.length
          ? { text, prefix: '', suffix: '' }
          : splitUnitOrStandalone(text)
        const { text: mainText, prefix, suffix } = split

        const keypath = generateKeyFromText(suffix ? mainText : (rawText || text), filepath, true, usedKeys)
        const templates = Global.interpretRefactorTemplates(keypath, args, document, i).filter(Boolean)

        if (!templates.length) {
          Log.warn(`No refactor template found for "${keypath}" in "${filepath}"`)
          return undefined
        }

        usedKeys.push(keypath)

        return {
          range,
          replaceTo: templates[0],
          keypath,
          message: mainText,
          unit: suffix || undefined,
          prefix: prefix || undefined,
          locale: Config.displayLanguage,
        }
      })
        .filter(notNullish)

      await extractHardStrings(
        document,
        extracts,
        true,
        textKeyCache,
      )

      extracted += extracts.length
    }
    catch (e) {
      Log.error(`Failed to extract ${document.fileName}`)
      Log.error(e, false)
    }
  }

  reportBatchResult({ scanned, extracted, unsupported, emptyReports })
}

function reportBatchResult(summary: {
  scanned: number
  extracted: number
  unsupported: number
  emptyReports: ChineseBreakdown[]
}) {
  const { scanned, extracted, unsupported, emptyReports } = summary
  if (!scanned)
    return

  const openSettings = '打开提取设置'
  const detail = describeBreakdown(mergeBreakdown(emptyReports))

  if (extracted > 0) {
    window.showInformationMessage(
      `已从 ${scanned} 个文件提取 ${extracted} 条中文${emptyReports.length ? `；另有 ${emptyReports.length} 个文件没有可提取的中文` : ''}`,
    )
    return
  }

  const lines = [`本批扫描 ${scanned} 个文件，没有可提取的中文。`]
  if (emptyReports.length) {
    lines.push(
      detail
        ? `检测到的中文分布：${detail}。注释和 console 输出里的中文不会被提取（设计如此）。`
        : '这些文件里没有检测到中文。',
    )
  }
  if (unsupported)
    lines.push(`${unsupported} 个文件的语言不支持自动提取。`)
  if (detail.includes('未纳入检测的属性'))
    lines.push('需要提取这类属性时，把属性名加到 i18n-ally.extract.parsers.html 的 attributes 里。')

  window.showWarningMessage(lines.join(' '), openSettings).then((choice) => {
    if (choice === openSettings)
      commands.executeCommand('workbench.action.openSettings', 'i18n-ally.extract.parsers.html')
  })
}

const m: ExtensionModule = () => {
  return [
    commands.registerCommand(Commands.extract_hard_strings_batch, BatchHardStringExtraction),
  ]
}

export default m
