import { basename, extname } from 'path'
import { Position, TextDocument, window } from 'vscode'
import { nanoid } from 'nanoid'
import limax from 'limax'
import { Config, Global } from '../extension'
import { ExtractInfo } from './types'
import { CurrentFile } from './CurrentFile'
import { changeCase } from '~/utils/changeCase'
import { resolveProjectLocale } from '~/utils/projectLocale'
import {
  buildChainFromSegments,
  splitSlashSegments,
  splitUnitOrStandalone,
  tokenizeUnitSuffix,
} from '~/extraction/utils'

export function generateKeyFromText(text: string, filepath?: string, reuseExisting = false, usedKeys: string[] = []): string {
  let key: string | undefined

  // already existed, reuse the key
  // mostly for auto extraction
  if (reuseExisting) {
    key = Global.loader.searchKeyForTranslations(text)
    if (key)
      return key
  }

  // keygent
  const keygenStrategy = Config.keygenStrategy
  if (keygenStrategy === 'random') {
    key = nanoid()
  }
  else if (keygenStrategy === 'empty') {
    key = ''
  }
  else if (keygenStrategy === 'source') {
    key = text
  }
  else {
    text = text.replace(/\$/g, '')
    key = limax(text, { separator: Config.preferredDelimiter, tone: false })
      .slice(0, Config.extractKeyMaxLength ?? Infinity)
  }

  const keyPrefix = Config.keyPrefix
  if (keyPrefix && keygenStrategy !== 'empty' && keygenStrategy !== 'source')
    key = keyPrefix + key

  if (filepath && key.includes('fileName')) {
    key = key
      .replace('{fileName}', basename(filepath))
      .replace('{fileNameWithoutExt}', basename(filepath, extname(filepath)))
  }

  key = changeCase(key, Config.keygenStyle).trim()

  // some symbol can't convert to alphabet correctly, apply a default key to it
  if (!key)
    key = 'key'

  // suffix with a auto increment number if same key
  if (usedKeys.includes(key) || CurrentFile.loader.getNodeByKey(key)) {
    const originalKey = key
    let num = 0

    do {
      key = `${originalKey}${Config.preferredDelimiter}${num}`
      num += 1
    } while (
      usedKeys.includes(key) || CurrentFile.loader.getNodeByKey(key, false)
    )
  }

  return key
}

export async function extractHardStrings(document: TextDocument, extracts: ExtractInfo[], saveFile = false, sharedKeyCache?: Map<string, string>) {
  if (!extracts.length)
    return

  const editor = await window.showTextDocument(document)
  const filepath = document.uri.fsPath
  // 提取出来的中文要写进项目的「中文语言文件」。设置里写的可能是 zh-cn，
  // 而项目里叫 chs.json —— 不对齐就会写到一个新文件里，看着像「提取没反应」。
  const sourceLanguage = resolveProjectLocale(
    Config.sourceLanguage,
    CurrentFile.loader.locales,
    [Config.displayLanguage],
  ).locale

  // Final safeguard: no matter which extraction path produced the extracts,
  // always split the trailing unit suffix like `(kW)` / `(元/MWh)` out of the
  // message. Non-CJK unit chunks become literals, CJK chunks get their own
  // keys, so the replacement becomes:
  //   $t('key') + '(kW)'
  //   $t('key') + '(' + $t('k2') + '/MWh)'
  // Skips if the path above already did the split.
  const unitKeyCache = sharedKeyCache || new Map<string, string>()
  const extraWrites: { keypath: string; value: string; locale: string }[] = []

  const keyForSegment = (text: string, locale: string) => {
    let key = unitKeyCache.get(text)
    if (!key) {
      key = generateKeyFromText(text, filepath, true)
      unitKeyCache.set(text, key)
      extraWrites.push({ keypath: key, value: text, locale })
    }
    return key
  }

  for (const extract of extracts) {
    if (!extract.message)
      continue

    // slash separated text: `中标/邀约次数` -> `$t(k1) + '/' + $t(k2)`
    // each translatable segment gets its own key, so it can be reused
    if (extract.keypath) {
      const segments = splitSlashSegments(extract.message)
      if (segments) {
        const chain = buildChainFromSegments(
          extract.replaceTo,
          extract.keypath,
          segments,
          text => keyForSegment(text, extract.locale || sourceLanguage),
        )
        if (chain) {
          extract.replaceTo = chain
          // the whole-string key is not used anymore, skip writing it
          extract.keypath = undefined
          continue
        }
      }
    }

    let main = extract.message
    let unit = extract.unit
    let prefix = extract.prefix || ''

    // defensive path for callers that didn't split the unit themselves
    if (!unit) {
      const split = splitUnitOrStandalone(main)
      if (split.suffix) {
        unit = split.suffix
        main = split.text
        prefix = split.prefix || prefix
      }
    }

    extract.message = main

    // 整条被括号包住时（`（仅当前页面）`），把左括号放回表达式前面：
    //   $t('key')        -> '（' + $t('key')
    //   {{ $t('key') }}  -> {{ '（' + $t('key') }}
    if (prefix) {
      const literal = `'${prefix.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
      const html = extract.replaceTo.match(/^(\{\{\s*)([\s\S]*?)(\s*\}\})$/)
      extract.replaceTo = html
        ? `${html[1]}${literal} + ${html[2]}${html[3]}`
        : `${literal} + ${extract.replaceTo}`
    }

    if (unit) {
      const exprParts: string[] = []
      for (const part of tokenizeUnitSuffix(unit)) {
        if (part.kind === 'lit') {
          exprParts.push(`'${part.text.replace(/'/g, '\\\'')}'`)
          continue
        }

        const key = keyForSegment(part.text, extract.locale || sourceLanguage)
        exprParts.push(`$t('${key}')`)
      }

      if (exprParts.length)
        extract.replaceTo = `${extract.replaceTo} + ${exprParts.join(' + ')}`
    }

    // same text must always resolve to the same key: keys generated earlier in
    // this batch are not in the locale files yet, so reuse them by value here
    if (extract.keypath && main) {
      const canonical = unitKeyCache.get(main)
      if (canonical && canonical !== extract.keypath) {
        extract.replaceTo = extract.replaceTo.replace(extract.keypath, canonical)
        extract.keypath = canonical
      }
      else if (!canonical) {
        unitKeyCache.set(main, extract.keypath)
      }
    }
  }

  extracts.sort((a, b) => b.range.start.compareTo(a.range.start))

  // 脚本文件里用了 $t 却没导入时，顺手补一条 import
  const autoImport = resolveAutoImport(document, extracts)

  // replace
  await editor.edit((editBuilder) => {
    for (const extract of extracts) {
      editBuilder.replace(
        extract.range,
        extract.replaceTo,
      )
    }
    if (autoImport)
      editBuilder.insert(autoImport.position, autoImport.text)
  })

  // save keys (dedupe by keypath: identical texts share the same key)
  const writes: { textFromPath: string; filepath: undefined; keypath: string; value: string; locale: string }[] = []
  const seenKeys = new Set<string>()

  for (const e of extracts) {
    if (e.keypath == null || e.message == null)
      continue
    if (seenKeys.has(e.keypath))
      continue
    seenKeys.add(e.keypath)
    writes.push({
      textFromPath: filepath,
      filepath: undefined,
      keypath: e.keypath,
      value: e.message,
      locale: e.locale || sourceLanguage,
    })
  }

  // unit chunks / slash segments get their own keys
  for (const w of extraWrites) {
    if (seenKeys.has(w.keypath))
      continue
    seenKeys.add(w.keypath)
    writes.push({ textFromPath: filepath, filepath: undefined, ...w })
  }

  await CurrentFile.loader.write(writes)

  if (saveFile)
    await document.save()

  CurrentFile.invalidate()
}

const SCRIPT_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact'])

/** 文档里是否已经有 $t 的定义/导入（import、const $t =、{ t: $t }、function $t） */
function hasTTFunction(text: string): boolean {
  return /(?:^\s*import\b[^\n]*\$t[^\n]*from\s+['"])/m.test(text)
    || /\bconst\s+\$t\s*=/.test(text)
    || /\blet\s+\$t\s*=/.test(text)
    || /\bvar\s+\$t\s*=/.test(text)
    || /\bt\s*:\s*\$t\b/.test(text)
    || /\bfunction\s+\$t\s*\(/.test(text)
}

/** 最后一条 import 语句所在的行号；没有 import 返回 -1 */
function findLastImportLine(lines: string[]): number {
  let last = -1
  let inImport = false
  let depth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!inImport && /^\s*import\b/.test(line))
      inImport = true

    if (!inImport)
      continue

    depth += (line.match(/[{(]/g) || []).length
    depth -= (line.match(/[})]/g) || []).length

    const finishesWithFrom = /\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line)
    const sideEffectImport = /^\s*import\s+['"][^'"]+['"]\s*;?\s*$/.test(line)

    if (depth <= 0 && (finishesWithFrom || sideEffectImport)) {
      last = i
      inImport = false
      depth = 0
    }
    else if (depth <= 0 && /;\s*$/.test(line)) {
      last = i
      inImport = false
    }
  }

  return last
}

/**
 * 计算需要补的 import 及其插入位置。
 * 仅在「脚本文件 + 本次替换会引入 $t + 全文尚无 $t 定义 + 配置了导入语句」时返回。
 */
/** 找到 .vue 里第一个 <script> 块的行范围（不含标签行本身） */
function findScriptBlock(lines: string[]): { start: number; end: number } | null {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/<script\b/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0)
    return null

  for (let i = start + 1; i < lines.length; i++) {
    if (/<\/script>/.test(lines[i]))
      return { start: start + 1, end: i }
  }
  return null
}

/**
 * 计算需要补的 import 及其插入位置。
 * 仅在「脚本文件/Vue 的 script 块 + 本次替换会引入 $t + 尚无 $t 定义 + 配置了导入语句」时返回。
 */
function resolveAutoImport(document: TextDocument, extracts: ExtractInfo[]): { position: Position; text: string } | null {
  const statement = Config.extractAutoImportStatement
  if (!statement)
    return null
  if (!extracts.some(i => i.replaceTo?.includes('$t')))
    return null

  const text = document.getText()
  const lines = text.split(/\r?\n/)

  // Vue 单文件组件：$t 在模板里是全局注入，但在 <script> 里仍需显式导入，
  // 所以插入点必须是 script 块内部的最后一条 import，而不是文件顶部。
  if (document.languageId === 'vue') {
    const block = findScriptBlock(lines)
    if (!block)
      return null

    const blockLines = lines.slice(block.start, block.end)
    if (hasTTFunction(blockLines.join('\n')))
      return null

    const lastImport = findLastImportLine(blockLines)
    if (lastImport >= 0) {
      const indent = blockLines[lastImport].match(/^\s*/)?.[0] ?? ''
      const nextLine = blockLines[lastImport + 1]
      const gap = !nextLine || nextLine.trim() === '' ? '' : '\n'
      return { position: new Position(block.start + lastImport + 1, 0), text: `${indent}${statement}\n${gap}` }
    }

    // script 块里没有 import：沿用块内第一行代码的缩进，并在其后留一个空行
    const firstCodeLine = blockLines.find(l => l.trim())
    const indent = firstCodeLine?.match(/^\s*/)?.[0] ?? ''
    const gap = !firstCodeLine || blockLines[0]?.trim() === '' ? '' : '\n'
    return { position: new Position(block.start, 0), text: `${indent}${statement}\n${gap}` }
  }

  if (!SCRIPT_LANGS.has(document.languageId))
    return null

  if (hasTTFunction(text))
    return null

  const lastImport = findLastImportLine(lines)
  let insertLine = lastImport >= 0 ? lastImport + 1 : 0

  // 没有 import 时不要压到文件开头的版权注释/说明注释上
  if (lastImport < 0) {
    while (insertLine < lines.length) {
      const l = lines[insertLine].trim()
      if (l === '' || l.startsWith('//') || l.startsWith('/*') || l.startsWith('*'))
        insertLine++
      else
        break
    }
  }

  const nextLine = lines[insertLine]
  const gap = !nextLine || nextLine.trim() === '' ? '' : '\n'

  return {
    position: new Position(insertLine, 0),
    text: `${statement}\n${gap}`,
  }
}
