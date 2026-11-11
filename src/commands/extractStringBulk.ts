import { commands, TextDocument, Uri, window, workspace } from 'vscode'
import { notNullish } from '@antfu/utils'
import fs from 'fs-extra'
import { DetectHardStrings } from './detectHardStrings'
import { ExtensionModule } from '~/modules'
import { Commands } from '~/commands'
import { extractHardStrings, generateKeyFromText } from '~/core/Extract'
import { Config, Global, CurrentFile, Translator, AccaptableTranslateItem } from '~/core'
import { parseHardString } from '~/extraction/parseHardString'
import { splitUnitOrStandalone } from '~/extraction/utils'
import { analyzeUntouchedChinese, ChineseBreakdown, describeBreakdown, mergeBreakdown } from '~/extraction/explain'
import { DetectionResultToExtraction } from '~/editor/extract'
import { Log } from '~/utils'
import { gitignoredGlob } from '~/utils/glob'
import { ActionSource, Telemetry, TelemetryKey } from '~/core/Telemetry'

/**
 * 提取后是否顺手把这批 key 翻译到其它语言。
 * 两个命令共用同一套扫描/提取流程，只是最后一步不同 —— 见下方 registerCommand。
 */
export async function BatchHardStringExtraction(...args: any[]) {
  return runBatch(args, false)
}

/** 右键文件夹 →「提取并翻译此文件夹」 */
export async function ExtractAndTranslateBatch(...args: any[]) {
  return runBatch(args, true)
}

async function runBatch(args: any[], translateAfter: boolean) {
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

    // 右键整个文件夹时会扫到图片、字体、压缩包这类二进制文件。
    // openTextDocument 对它们会 reject，而 Promise.all 是「一个失败全盘失败」——
    // 以前随便有个 .png 就能让整条命令崩掉，连一个文件都不处理。改成逐个结算。
    const opened = await Promise.allSettled(files.map(i => workspace.openTextDocument(i)))
    let unreadable = 0
    opened.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        documents.push(result.value)
      }
      else {
        unreadable += 1
        Log.warn(`跳过无法作为文本打开的文件: ${files[index].fsPath}`)
      }
    })
    if (unreadable)
      Log.info(`共跳过 ${unreadable} 个非文本文件`)
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
  // 本次真正写进语言文件的 key，用于提取完立刻翻译
  const extractedKeys = new Set<string>()
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

      const writtenKeys = await extractHardStrings(
        document,
        extracts,
        true,
        textKeyCache,
      )

      for (const key of writtenKeys)
        extractedKeys.add(key)

      extracted += extracts.length
    }
    catch (e) {
      Log.error(`Failed to extract ${document.fileName}`)
      Log.error(e, false)
    }
  }

  // 「提取并翻译」时不先弹提取结果：紧接着翻译自己要弹一次确认框，
  // 两个弹窗叠在一起会让人以为要连点两次同意。
  reportBatchResult({ scanned, extracted, unsupported, emptyReports }, translateAfter && extracted > 0)

  if (translateAfter && extractedKeys.size)
    await translateExtractedKeys([...extractedKeys])
}

/**
 * 把刚提取出来的 key 翻译到其它语言。
 *
 * 只处理这批 key（不碰项目里其它缺失项），且只补「缺失或空值」的目标语言 ——
 * 已有译文的不会被覆盖。这正是「按文件夹翻译 / 按文件夹同步 key」的落点：
 * 一个模块开发完，右键该文件夹一次，源码里的中文变 key，其它语言同时补齐。
 *
 * 注意提取阶段只改了 loader 内存里的文件数据（LocaleLoader.write 里那句
 * `_files[filepath].value = modified`），节点树并没有重建，所以这里必须先
 * reloadFromDisk，否则 getNodeByKey 拿不到刚写进去的 key。
 */
async function translateExtractedKeys(keypaths: string[]) {
  const loader = CurrentFile.loader

  try {
    await loader.reloadFromDisk()

    const source = Translator.alignSourceLanguage(loader, Config.sourceLanguage)
    const fallbackEnabled = Config.translateFallbackFromOtherLocales
    const locales = Global.allLocales.filter(locale =>
      (fallbackEnabled || !Config.isSameLocale(locale, source))
      && !Config.ignoredLocales.some(ignored => Config.isSameLocale(ignored, locale)),
    )

    const nodes: AccaptableTranslateItem[] = []
    // 目标语言按「实际有缺失的语言」算，直接报 allLocales.length 会虚高。
    // 不能从 nodes 上取 .locale —— AccaptableTranslateItem 是联合类型，那里只有部分成员有该字段。
    const touched = new Set<string>()

    for (const locale of locales) {
      for (const keypath of keypaths) {
        const node = loader.getNodeByKey(keypath)
        if (!node)
          continue
        // 已有译文就跳过，批量操作不该覆盖人工校对过的内容
        if (node.locales[locale]?.value)
          continue
        // 一条文案在所有语言里都是空的（比如语言文件刚建），无从翻译
        if (!Object.values(node.locales).some(r => !!r.value))
          continue
        nodes.push({ locale, keypath, type: undefined })
        touched.add(locale)
      }
    }

    if (!nodes.length) {
      Log.info(`📤 提取完成，${keypaths.length} 个 key 在其它语言均无需补译`)
      // 提取结果提示在这条路径上被静音了（避免和翻译确认框叠加），
      // 所以「无事可做」必须在这里说一声，否则看起来像点了没反应
      window.showInformationMessage(`已处理 ${keypaths.length} 个 key，其它语言均已有译文，无需补译`)
      return
    }

    Log.info(`📤 提取完成，开始翻译 ${nodes.length} 条（${touched.size} 种目标语言 / ${keypaths.length} 个 key）`)
    await Translator.translateNodes(loader, nodes, source)
  }
  catch (e: any) {
    // 提取本身已经成功，翻译失败不该让人以为整件事没做
    Log.error('提取后的翻译失败')
    Log.error(e, false)
    window.showWarningMessage(`文案已提取，但翻译失败：${e?.message || e}`)
  }
}

function reportBatchResult(summary: {
  scanned: number
  extracted: number
  unsupported: number
  emptyReports: ChineseBreakdown[]
}, quiet = false) {
  const { scanned, extracted, unsupported, emptyReports } = summary
  if (!scanned)
    return

  const openSettings = '打开提取设置'
  const detail = describeBreakdown(mergeBreakdown(emptyReports))

  if (extracted > 0) {
    if (quiet)
      return
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
    commands.registerCommand(Commands.extract_hard_strings_translate, ExtractAndTranslateBatch),
  ]
}

export default m
