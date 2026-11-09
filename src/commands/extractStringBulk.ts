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

  for (const document of documents) {
    if (!document)
      continue

    try {
      const result = await DetectHardStrings(document, false)
      Log.info(`📤 Extracting [${result?.length || 0}] ${document.uri.fsPath}`)
      if (!result)
        continue

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

    }
    catch (e) {
      Log.error(`Failed to extract ${document.fileName}`)
      Log.error(e, false)
    }
  }

}


const m: ExtensionModule = () => {
  return [
    commands.registerCommand(Commands.extract_hard_strings_batch, BatchHardStringExtraction),
  ]
}

export default m
