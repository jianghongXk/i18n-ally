import fs from 'fs'
import path from 'path'
import { commands, ProgressLocation, Uri, window, workspace } from 'vscode'
import type { QuickPickItem } from 'vscode'
import { Commands } from './commands'
import type { ExtensionModule } from '~/modules'
import { Config, CurrentFile, Global, Translator } from '~/core'
import type { AccaptableTranslateItem } from '~/core'
import { File, Log } from '~/utils'
import { getEngineSupportedLocales } from '~/translators'
import type { EngineLocale, EngineLocaleListResult } from '~/translators'
import {
  buildEmptySkeleton,
  countLocaleKeys,
  defaultLocaleMatchers,
  deriveLocaleFilePath,
  detectIndent,
  isWritableLocaleExt,
  isPlausibleLocale,
  scanLocaleFiles,
  suggestLocaleName,
} from '~/utils/localeFiles'
import type { LocaleMatcher, ScannedFile } from '~/utils/localeFiles'

interface Pick extends QuickPickItem {
  value: string
}

interface ProjectLocale {
  /** 翻译链路真正用的语言标识：loader 优先，目录扫描补充 */
  locale: string
  files: ScannedFile[]
  fromLoader: boolean
  keyCount?: number
}

interface ProjectScan {
  locales: ProjectLocale[]
  /** 目录里有、但 pathMatcher / loader 都没认出来的文件，可手动纳入 */
  unrecognized: ScannedFile[]
  dirs: string[]
  loaderCount: number
  scannedCount: number
  matchers: LocaleMatcher[]
}

interface ApplyResult {
  written: number
  unresolved: string[]
  fixedTagSystem: boolean
}

const BIND = '__bind__'
const LIST = '__list__'
const REFRESH = '__refresh__'
const APPLY = '__apply__'
const DIAGNOSE = '__diagnose__'
const MANUAL = '__manual__'
const MANUAL_FILE = '__manual_file__'
const CREATE = '__create__'
const MIGRATE = '__migrate__'
const FIX_SCAN = '__fix_scan__'
const SELECT_FILES = '__select_files__'
const OPEN_SETTINGS = '__open_settings__'
const LOCALE_MAP_KEY = 'translate.localeMap'

const normalizeKey = (s: string) => s.trim().toLowerCase().replace(/_/g, '-')

function engineLabel(engine: string) {
  return engine === 'baidu' ? '百度翻译' : engine
}

function resolveDirs(root: string, localePath?: string): string[] {
  // localesPaths 允许配多个目录，全部都要扫；显式传入的目录合并进去即可
  const raw = [...new Set([...(Global.localesPaths || []), ...(localePath ? [localePath] : [])])]
  return raw.map(d => path.isAbsolute(d) ? d : path.join(root, d))
}

// #region 项目级配置：来源识别、写入位置、语言文件识别自检

interface LocaleMapOrigin {
  label: string
  globalValue?: Record<string, any>
  projectValue?: Record<string, any>
  needsMigration: boolean
}

/**
 * `translate.localeMap` 常被写进用户级 settings.json（设置编辑器的
 * 「在 settings.json 中编辑」默认就指向那里），于是 A 项目的映射会串到 B 项目。
 * 这里把生效值拆开，好在界面上说清「当前这份配置到底来自哪」。
 */
function inspectLocaleMapOrigin(): LocaleMapOrigin {
  const inspected = workspace.getConfiguration('i18n-ally').inspect<Record<string, any>>(LOCALE_MAP_KEY)
  const globalValue = inspected?.globalValue
  const projectValue = inspected?.workspaceValue ?? inspected?.workspaceFolderValue
  const hasGlobal = !!globalValue && Object.keys(globalValue).length > 0
  const hasProject = !!projectValue && Object.keys(projectValue).length > 0
  return {
    label: hasProject ? '本项目 .vscode/settings.json' : hasGlobal ? '⚠ 用户级 settings.json（跨项目生效）' : '尚未配置',
    globalValue,
    projectValue,
    needsMigration: hasGlobal && !hasProject,
  }
}

/** 直接打开当前项目的 .vscode/settings.json，不存在时先建一个空的 */
export async function openWorkspaceSettings(): Promise<void> {
  const folder = workspace.workspaceFolders?.[0]
  if (!folder) {
    window.showWarningMessage('当前没有打开的项目文件夹，无法定位项目级 settings.json')
    return
  }
  const settingsPath = path.join(folder.uri.fsPath, '.vscode', 'settings.json')
  const uri = Uri.file(settingsPath)
  try {
    let doc
    try {
      doc = await workspace.openTextDocument(uri)
    }
    catch {
      try {
        await workspace.fs.createDirectory(Uri.file(path.join(folder.uri.fsPath, '.vscode')))
      }
      catch {
        // 目录已存在
      }
      await workspace.fs.writeFile(uri, Buffer.from('{\n}\n', 'utf-8'))
      doc = await workspace.openTextDocument(uri)
    }
    await window.showTextDocument(doc)
  }
  catch (e) {
    window.showErrorMessage(`打开项目设置失败：${(e as Error).message}`)
  }
}

async function migrateUserLocaleMap(origin: LocaleMapOrigin): Promise<void> {
  const merged = {
    ...(origin.projectValue || {}),
    ...(origin.globalValue || {}),
    ...Config.translateLocaleMapRaw,
  }
  await Config.updateConfig(LOCALE_MAP_KEY, merged, false)
  window.showInformationMessage(
    '映射已复制进当前项目的 .vscode/settings.json。用户级那份保留未动（其它项目可能还在用），建议手动清理以避免继续串项目。',
  )
}

interface DirHealth {
  configured: string[]
  dirs: string[]
  missing: string[]
  /** 目录根下直接存在的 json 文件名 */
  jsonNames: string[]
}

function inspectLocaleDirs(root: string, localePath?: string): DirHealth {
  const configured = Global.localesPaths || []
  const dirs = resolveDirs(root, localePath)
  const missing: string[] = []
  const jsonNames: string[] = []
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && /\.json5?$/i.test(entry.name))
          jsonNames.push(entry.name)
      }
    }
    catch {
      missing.push(dir)
    }
  }
  return { configured, dirs, missing, jsonNames }
}

/** 用文件夹选择器把 localesPaths 写进当前项目设置，而不是用户级 */
async function pickAndWriteLocalesPaths(root: string): Promise<void> {
  const picked = await window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: Uri.file(root),
    openLabel: '选为语言文件目录',
  })
  const dir = picked?.[0]?.fsPath
  if (!dir)
    return
  const rel = path.relative(root, dir).replace(/\\/g, '/') || '.'
  await Config.updateConfig('localesPaths', [rel], false)
  window.showInformationMessage(`已把 localesPaths 设为 ${rel}（写入当前项目 .vscode/settings.json），插件会自动重新扫描`)
}

interface LocaleFilePick extends QuickPickItem {
  /** 相对工作区根的路径，localeFiles 白名单里存的就是它 */
  workspaceRelative: string
  /** 相对语言文件目录的路径，用来判断是否平铺 */
  scanRelative: string
  filepath: string
  locale?: string
  plausible: boolean
}

/** 相对工作区根的路径（统一用 /） */
export function toWorkspaceRelative(root: string, filepath: string): string {
  return path.relative(root, filepath).replace(/\\/g, '/')
}

/**
 * 白名单启用时把新文件追加进去（新建语言文件 / 手动纳入都要调用）。
 * 没配白名单时不擅自生成一份，保持按 pathMatcher 自动识别。
 */
export async function addToLocaleFiles(root: string, filepaths: string[]): Promise<boolean> {
  const current = Config.localeFiles
  if (!current.length)
    return false
  const next = [...current]
  for (const filepath of filepaths) {
    const relative = toWorkspaceRelative(root, filepath)
    if (!next.some(i => i.toLowerCase() === relative.toLowerCase()))
      next.push(relative)
  }
  if (next.length === current.length)
    return false
  await Config.updateConfig('localeFiles', next, false)
  return true
}

/** 被当成语言、但名字根本不像语言码的项（COMMWORD / ICONFONT 之类） */
export function findSuspiciousLocales(scan: ProjectScan): string[] {
  return scan.locales.filter(l => !isPlausibleLocale(l.locale)).map(l => l.locale)
}

/**
 * 逐个选取语言文件：把目录里的候选文件全列出来由使用者勾选，结果写成
 * i18n-ally.localeFiles 白名单，loader 只加载列出的文件。
 *
 * 原来的「按当前文件名自动修复」会直接写 pathMatcher={locale}.{ext}，
 * 而 {locale} 编译成宽松的 [\w-_]+，同目录的 commWord.json 也被吃进来，
 * 侧边栏于是冒出一门叫 COMMWORD 的「语言」。
 */
export async function selectLocaleFiles(root: string, localePath?: string): Promise<void> {
  const health = inspectLocaleDirs(root, localePath)
  if (!health.configured.length || health.missing.length === health.dirs.length) {
    const choice = await window.showWarningMessage(
      '还没配置语言文件目录（localesPaths）或目录不存在，先选目录再逐个选取语言文件。',
      '选择语言文件目录',
    )
    if (choice === '选择语言文件目录')
      await pickAndWriteLocalesPaths(root)
    return
  }

  const candidates = scanLocaleFiles(health.dirs, { matchers: getMatchers(), fallbackByFilename: true })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  if (!candidates.length) {
    window.showWarningMessage('语言文件目录里没有可选取的 json / yaml / js / ts 文件')
    return
  }

  const whitelist = Config.localeFiles
  const whitelistSet = new Set(whitelist.map(i => i.toLowerCase()))
  const items: LocaleFilePick[] = candidates.map((f) => {
    const workspaceRelative = toWorkspaceRelative(root, f.filepath)
    const plausible = !!f.recognized && isPlausibleLocale(f.locale)
    return {
      label: `${plausible ? '$(file)' : '$(exclude)'} ${workspaceRelative}`,
      description: plausible
        ? `${f.locale} · ${f.keyCount ?? '—'} 条词条`
        : '不像语言文件（默认不勾选）',
      detail: f.filepath,
      picked: whitelist.length
        ? whitelistSet.has(workspaceRelative.toLowerCase())
        : plausible,
      workspaceRelative,
      scanRelative: f.relativePath,
      filepath: f.filepath,
      locale: f.locale,
      plausible,
    }
  })

  const chosen = await window.showQuickPick(items, {
    canPickMany: true,
    title: '逐个选取本项目的语言文件',
    placeHolder: `共 ${items.length} 个候选文件，勾选的才会被加载；commWord.json 之类数据文件保持不勾`,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  })
  if (!chosen)
    return
  if (!chosen.length) {
    window.showWarningMessage('至少要选一个语言文件，本次未改动任何配置')
    return
  }

  const chosenPaths = new Set(chosen.map(i => i.workspaceRelative.toLowerCase()))
  const selected = chosen.map(i => i.workspaceRelative)
  const rejected = items.filter(i => !chosenPaths.has(i.workspaceRelative.toLowerCase()))
  const patch: Record<string, any> = { localeFiles: selected }

  const allFlat = chosen.every(i => !i.scanRelative.includes('/'))
  if (allFlat) {
    patch.dirStructure = 'file'
    patch.namespace = false
  }
  // 现有 matcher 解析不出所选文件时才补通用规则，别覆盖项目已有的复杂 pathMatcher
  if (chosen.some(i => !i.locale) && allFlat)
    patch.pathMatcher = '{locale}.{ext}'
  const tagSystem = workspace.getConfiguration('i18n-ally').get<string>('languageTagSystem') || 'bcp47'
  if (tagSystem === 'legacy' && chosen.some(i => (i.locale || '').split(/[-_]/)[0].length > 2))
    patch.languageTagSystem = 'none'

  const summary = Object.entries(patch)
    .map(([k, v]) => k === 'localeFiles' ? `localeFiles=${(v as string[]).length} 个文件` : `${k}=${JSON.stringify(v)}`)
    .join('、')
  const confirm = await window.showWarningMessage(
    `将写入当前项目 .vscode/settings.json：${summary}。选中的 ${selected.length} 个文件会成为唯一加载的语言文件，其余 ${rejected.length} 个（${rejected.slice(0, 4).map(i => path.basename(i.filepath)).join('、') || '无'}）不再被当作语言。`,
    { modal: true },
    '写入当前项目设置',
  )
  if (confirm !== '写入当前项目设置')
    return

  for (const [key, value] of Object.entries(patch))
    await Config.updateConfig(key, value, false)

  try {
    await Global.loader?.reloadFromDisk()
    CurrentFile.invalidate()
  }
  catch (e) {
    Log.warn(`[translate-locales] 白名单写入后主动刷新失败：${(e as Error).message}`)
  }

  window.showInformationMessage(
    `已把 ${selected.length} 个语言文件写进本项目白名单，排除 ${rejected.length} 个文件；配置变更会自动重建 loader。`,
  )
}

type LocaleIssue = 'no-path' | 'recognition'

/** 只看不改：判断当前项目属于哪种「找不到翻译文件」 */
function detectLocaleIssue(
  root: string,
  localePath: string | undefined,
  scan: ProjectScan,
): { issue?: LocaleIssue; health: DirHealth } {
  const health = inspectLocaleDirs(root, localePath)
  if (!health.configured.length || health.missing.length === health.dirs.length)
    return { issue: 'no-path', health }
  if (!scan.loaderCount && health.jsonNames.length)
    return { issue: 'recognition', health }
  return { health }
}

/**
 * 进入可视化配置前先排查「找不到翻译文件」的两类根因：
 * ① localesPaths 没配 / 配的目录不存在；② 目录已配但 json 文件名没被 pathMatcher / loader 认出来。
 * 返回 true 表示已经给出引导，本次不再往下走。
 */
async function guideMissingLocaleFiles(
  root: string,
  localePath: string | undefined,
  scan: ProjectScan,
): Promise<boolean> {
  const { issue, health } = detectLocaleIssue(root, localePath, scan)
  if (!issue)
    return false
  const engine = Config.translateEngines[0] || 'google'

  if (issue === 'no-path') {
    const why = !health.configured.length
      ? '还没配置语言文件目录（localesPaths）'
      : `配置的语言文件目录不存在：${health.missing.map(d => path.relative(root, d).replace(/\\/g, '/')).join('、')}`
    const choice = await window.showWarningMessage(
      `找不到翻译文件：${why}。这项设置要写在当前项目的 .vscode/settings.json，写进用户级设置会串到其它项目。`,
      '选择语言文件目录',
      '运行初始化配置引导',
      '诊断当前配置',
    )
    if (choice === '选择语言文件目录')
      await pickAndWriteLocalesPaths(root)
    else if (choice === '运行初始化配置引导')
      await commands.executeCommand(Commands.setup_wizard)
    else if (choice === '诊断当前配置')
      await diagnose(engine, root, localePath)
    return true
  }

  const choice = await window.showWarningMessage(
    `语言文件目录里有 ${health.jsonNames.length} 个 JSON，但插件没加载到任何语言文件：多半是文件名不符合 pathMatcher，或 dirStructure / namespace / languageTagSystem 判错。`,
    '逐个选取语言文件',
    '手动指定语言标识',
    '诊断当前配置',
  )
  if (choice === '逐个选取语言文件')
    await selectLocaleFiles(root, localePath)
  else if (choice === '手动指定语言标识')
    await includeManually(engine, root, localePath, scan)
  else if (choice === '诊断当前配置')
    await diagnose(engine, root, localePath)
  return true
}

// #endregion

/**
 * 优先用项目自己的 pathMatcher（Global.getPathMatchers 已经把自定义配置、
 * 框架规则、目录结构算进去了），再补一组通用规则兜底。
 */
function getMatchers(): LocaleMatcher[] {
  let custom: LocaleMatcher[] = []
  try {
    // getPathMatchers 要的是已判定出的结构，auto 时按最常见的「文件式」取规则
    custom = Global.getPathMatchers(Global.dirStructure === 'dir' ? 'dir' : 'file') || []
  }
  catch {
    // 插件还没初始化完时用通用规则
  }
  const all = [...custom]
  for (const m of defaultLocaleMatchers()) {
    if (!all.some(x => x.matcher === m.matcher))
      all.push(m)
  }
  return all
}

/**
 * 项目里真实存在的语言文件 → 语言标识集合。
 * 两侧数据合并：
 *   - Global.loader.files：loader 已经读进来的文件，locale 就是翻译链路用的那个
 *   - 目录扫描：languageTagSystem=legacy 丢掉 chs/can、pathMatcher 没匹配上时，
 *     loader 里看不到，但磁盘上确实有这个文件，也要能列出来提前绑定
 */
export function collectProjectLocales(root: string, localePath?: string): ProjectScan {
  const dirs = resolveDirs(root, localePath)
  const matchers = getMatchers()
  const scanned = scanLocaleFiles(dirs, { matchers })
  const scannedByPath = new Map(scanned.map(f => [f.filepath.toLowerCase(), f]))
  const localeMap = new Map<string, ProjectLocale>()
  const usedPaths = new Set<string>()
  const unrecognized: ScannedFile[] = []
  let loaderCount = 0
  let scannedCount = 0

  const upsert = (locale: string, file: ScannedFile, fromLoader: boolean) => {
    const key = normalizeKey(locale)
    let item = localeMap.get(key)
    if (!item) {
      item = { locale, files: [], fromLoader: false, keyCount: 0 }
      localeMap.set(key, item)
    }
    if (!item.files.some(f => f.filepath.toLowerCase() === file.filepath.toLowerCase()))
      item.files.push(file)
    item.fromLoader = item.fromLoader || fromLoader
    item.keyCount = (item.keyCount || 0) + (file.keyCount || 0)
    usedPaths.add(file.filepath.toLowerCase())
  }

  try {
    const loaderFiles = Global.loader?.files || []
    for (const f of loaderFiles) {
      if (!f?.filepath || !f.locale)
        continue
      loaderCount += 1
      const extra = scannedByPath.get(f.filepath.toLowerCase())
      upsert(f.locale, {
        filepath: f.filepath,
        relativePath: path.relative(root, f.filepath).replace(/\\/g, '/'),
        locale: f.locale,
        matcher: f.matcher || extra?.matcher,
        namespace: f.namespace || extra?.namespace,
        keyCount: extra?.keyCount ?? countLocaleKeys(f.filepath),
        recognized: true,
      }, true)
    }
  }
  catch (e) {
    Log.warn(`[translate-locales] 读取 loader 语言文件失败：${(e as Error).message}`)
  }

  for (const f of scanned) {
    if (usedPaths.has(f.filepath.toLowerCase()))
      continue
    if (f.recognized && f.locale) {
      upsert(f.locale, f, false)
      scannedCount += 1
    }
    else if (!f.recognized) {
      unrecognized.push(f)
    }
  }

  return {
    locales: [...localeMap.values()].sort((a, b) => a.locale.localeCompare(b.locale)),
    unrecognized,
    dirs,
    loaderCount,
    scannedCount,
    matchers,
  }
}

/** 兼容旧调用：只要语言标识列表 */
export function collectLocaleFiles(root: string, localePath?: string): string[] {
  return collectProjectLocales(root, localePath).locales.map(l => l.locale)
}

/** 写入一条绑定，保留配置里已有的其它语言/引擎设置 */
async function writeBinding(engine: string, locale: string, code: string): Promise<void> {
  const raw = Config.translateLocaleMapRaw
  const scoped = (raw[engine] && typeof raw[engine] === 'object' && !Array.isArray(raw[engine]))
    ? raw[engine] as Record<string, string>
    : {}
  const next = {
    ...raw,
    [engine]: {
      ...scoped,
      [locale]: code,
    },
  }
  await Config.updateConfig('translate.localeMap', next, false)
}

/**
 * 把「能按别名自动解析」的语言一次性写成显式映射。
 * 显式写进 .vscode/settings.json 有两个好处：配置可见可改，且不受引擎清单变动影响。
 */
export async function applyRecommendedLocaleMap(
  engine: string,
  root: string,
  localePath?: string,
): Promise<ApplyResult> {
  const scan = collectProjectLocales(root, localePath)
  const unresolved: string[] = []
  let written = 0

  // 没声明语言清单的引擎（openai 等）语言码原样透传，不需要也不应该写映射
  if (Config.getTranslateEngineLocales(engine).length) {
    for (const { locale } of scan.locales) {
      const status = Config.getTranslateLocaleStatus(engine, locale)
      if (status.explicit)
        continue
      if (!status.resolved) {
        unresolved.push(locale)
        continue
      }
      await writeBinding(engine, locale, status.resolved)
      written += 1
    }
  }

  const fixedTagSystem = await ensureLongLocaleSupport(scan.locales.map(l => l.locale))

  return { written, unresolved, fixedTagSystem }
}

/** legacy 语言码系统只认 2 字母主码，chs / can / cht 会被判无效、文件不进 loader */
export async function ensureLongLocaleSupport(locales: string[]): Promise<boolean> {
  const tagSystem = workspace.getConfiguration('i18n-ally').get<string>('languageTagSystem') || 'bcp47'
  const hasLongCode = locales.some(l => l.split(/[-_]/)[0].length > 2)
  if (tagSystem !== 'legacy' || !hasLongCode)
    return false
  await Config.updateConfig('languageTagSystem', 'none', false)
  return true
}

function statusText(engine: string, locale: string): string {
  const supported = Config.getTranslateEngineLocales(engine)
  if (!supported.length)
    return '该引擎未声明语言清单，语言码原样传给接口'
  const status = Config.getTranslateLocaleStatus(engine, locale)
  if (!status.supported)
    return '⚠ 无法解析，翻译时会被跳过'
  const name = supported.find(l => l.code === status.resolved)?.name || status.resolved
  if (status.source === 'explicit')
    return `→ ${status.resolved}（${name}） · 已手动绑定`
  return `→ ${status.resolved}（${name}） · 自动匹配`
}

function sourceText(result: EngineLocaleListResult): string {
  if (result.source === 'remote')
    return `接口实时读取（本次 ${result.fetched} 条，已合并内置别名）`
  if (result.error)
    return `内置声明（实时读取失败：${result.error}）`
  return '内置声明'
}

/** 读取引擎清单，带进度提示；失败会退回内置声明并由 sourceText 说明原因 */
async function loadEngineLocales(engine: string, force = false): Promise<EngineLocaleListResult> {
  return window.withProgress({
    location: ProgressLocation.Notification,
    title: `正在读取「${engineLabel(engine)}」支持的语言…`,
  }, () => getEngineSupportedLocales(engine, force))
}

/** 列出引擎支持的全部语言（真实清单，可搜索） */
async function showSupportedLanguages(engine: string): Promise<void> {
  const result = await loadEngineLocales(engine)
  const locales = result.locales

  if (!locales.length) {
    window.showInformationMessage(`${engineLabel(engine)}：${result.note || '该引擎没有语言码清单，语言标识会原样传给接口。'}`)
    return
  }

  const items: Pick[] = locales.map(l => ({
    label: l.name,
    description: l.code,
    detail: [
      l.sourceOnly ? '仅可作源语言' : '',
      l.note || '',
      (l.aliases || []).length ? `别名：${(l.aliases || []).join(' / ')}` : '',
    ].filter(Boolean).join(' · '),
    value: l.code,
  }))

  const picked = await window.showQuickPick(items, {
    title: `${engineLabel(engine)} 支持的全部语言（${locales.length} 种 · ${sourceText(result)}）`,
    placeHolder: '可输入语言名、语言码或别名搜索，此项仅用于查看',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (picked)
    window.showInformationMessage(`${picked.label} → ${picked.value}`)
}

async function refreshEngineLocales(engine: string): Promise<void> {
  const result = await loadEngineLocales(engine, true)
  const parts = [
    `${engineLabel(engine)}：${result.locales.length} 种语言`,
    sourceText(result),
  ]
  if (result.error)
    parts.push('已保留内置清单，不影响翻译')
  window.showInformationMessage(parts.join('；'))
  Log.info(`[translate-locales] ${engine} 语言清单：${result.locales.map(l => l.code).join(', ')}`)
}

/** 选一个引擎语言码；没有清单的引擎允许手填 */
async function pickEngineCode(
  engine: string,
  target: string,
  result: EngineLocaleListResult,
): Promise<string | undefined> {
  if (!result.locales.length) {
    const status = Config.getTranslateLocaleStatus(engine, target)
    return window.showInputBox({
      title: `把「${target}」绑定到哪个翻译语言？`,
      prompt: result.note || '该引擎没有内置语言清单，请直接填写它的 API 语言码',
      placeHolder: '例如 zh-TW',
      value: status.explicit || '',
      validateInput: v => (v.trim() ? undefined : '不能为空'),
    }).then(code => code?.trim())
  }

  if (result.error)
    window.showWarningMessage(`实时读取语言清单失败（${result.error}），已退回内置声明`)

  const status = Config.getTranslateLocaleStatus(engine, target)
  const items: Pick[] = result.locales
    .filter(l => !l.sourceOnly)
    .map((l: EngineLocale) => ({
      label: l.name,
      description: l.code,
      detail: [l.note, l.aliases?.length ? `别名：${l.aliases.join(' / ')}` : ''].filter(Boolean).join(' · '),
      picked: l.code === status.resolved,
      value: l.code,
    }))

  const code = await window.showQuickPick(items, {
    title: `把「${target}」绑定到哪个翻译语言？（${engineLabel(engine)} · ${sourceText(result)}）`,
    placeHolder: '可输入中文名、语言码或别名搜索',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  return code?.value
}

async function finishBinding(engine: string, target: string, code?: string): Promise<void> {
  if (!code)
    return
  await writeBinding(engine, target, code)
  window.showInformationMessage(`已写入工作区设置：${target} → ${code}（${engineLabel(engine)}）`)
}

/** 选择一个项目语言文件（真实扫描结果），再把它绑到引擎语言码 */
async function bindOne(engine: string, root: string, localePath?: string): Promise<void> {
  const scan = collectProjectLocales(root, localePath)
  if (await guideMissingLocaleFiles(root, localePath, scan))
    return
  if (!scan.locales.length) {
    window.showWarningMessage('没找到语言文件，请先运行「初始化配置引导」确认语言文件目录')
    return
  }

  const items: Pick[] = scan.locales.map((l) => {
    const files = l.files.map(f => f.relativePath).join('、')
    return {
      label: `$(file) ${l.locale}`,
      description: statusText(engine, l.locale),
      detail: `${files || '（loader）'} · ${l.keyCount ? `${l.keyCount} 条词条` : '未统计'} · 来源：${l.fromLoader ? 'loader' : '目录扫描'}${l.files.length > 1 ? ` · ${l.files.length} 个文件` : ''}`,
      value: l.locale,
    }
  })
  if (scan.unrecognized.length) {
    items.push({
      label: '$(add) 手动纳入目录里的其它文件',
      description: `${scan.unrecognized.length} 个未被识别的文件（如 commWord.json）`,
      detail: '被排除只是不主动扫描，明确涉及的文件仍可在这里纳入考虑范围',
      value: MANUAL_FILE,
    })
  }

  const target = await window.showQuickPick(items, {
    title: `翻译语言映射 · 选择项目语言文件（${engineLabel(engine)} · ${scan.locales.length} 种语言）`,
    placeHolder: '选一个语言文件/语言标识，再指定它对应的翻译语言',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!target)
    return
  if (target.value === MANUAL_FILE) {
    await includeManually(engine, root, localePath, scan)
    return
  }

  const result = await loadEngineLocales(engine)
  await finishBinding(engine, target.value, await pickEngineCode(engine, target.value, result))
}

/**
 * 目录里未被识别成语言文件的 json（commWord.json 等）默认不参与扫描对比，
 * 但如果新接口/新需求明确涉及，仍然要能纳入：这里让用户选文件、指定语言标识、绑定语言码。
 */
async function includeManually(engine: string, root: string, localePath?: string, scan?: ProjectScan): Promise<void> {
  const files = (scan || collectProjectLocales(root, localePath)).unrecognized
  if (!files.length) {
    window.showInformationMessage('目录里没有被排除的文件')
    return
  }

  const items: Pick[] = files.map(f => ({
    label: `$(file) ${f.relativePath}`,
    description: f.keyCount ? `${f.keyCount} 条数据` : '未统计',
    detail: f.filepath,
    value: f.filepath,
  }))
  const picked = await window.showQuickPick(items, {
    title: '手动纳入目录里的其它文件',
    placeHolder: '选一个文件，给它指定语言标识并绑定翻译语言',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!picked)
    return

  const basename = picked.value.split(/[\\/]/).pop() || picked.value
  const suggested = basename.replace(/\.[^.]+$/, '')
  const locale = await window.showInputBox({
    title: '这个文件的语言标识是什么？',
    prompt: '会作为 translate.localeMap 的 key；填项目里实际使用的语言码',
    value: suggested,
    validateInput: v => (v.trim() ? undefined : '不能为空'),
  })
  if (!locale)
    return

  const result = await loadEngineLocales(engine)
  const code = await pickEngineCode(engine, locale.trim(), result)
  await finishBinding(engine, locale.trim(), code)
  // 白名单启用时，「纳入」必须真的让 loader 读到这个文件，否则只是加了一条用不上的映射
  const whitelisted = await addToLocaleFiles(root, [picked.value])
  if (whitelisted) {
    try {
      await Global.loader?.reloadFromDisk()
      CurrentFile.invalidate()
    }
    catch (e) {
      Log.warn(`[translate-locales] 纳入文件后刷新失败：${(e as Error).message}`)
    }
  }
  if (code) {
    window.showInformationMessage(
      whitelisted
        ? `绑定已写入，该文件也已加入本项目 localeFiles 白名单；语言码会取文件名解析结果，若要改成 ${locale.trim()} 请检查 pathMatcher。`
        : '绑定已写入。注意：该文件若不在 loader 的语言文件列表里，翻译时不会自动生成目标文件；'
          + '需要插件加载它时请检查 localesPaths / pathMatcher，或用「逐个选取语言文件」建立白名单。',
    )
  }
}

async function diagnose(engine: string, root: string, localePath?: string): Promise<void> {
  const scan = collectProjectLocales(root, localePath)
  const result = await getEngineSupportedLocales(engine)
  const rows = scan.locales.map((l) => {
    const files = l.files.map(f => f.relativePath).join('、')
    return `  ${l.locale.padEnd(16)} ${statusText(engine, l.locale)}\n      文件：${files || '（loader）'} · 词条 ${l.keyCount ?? '—'} · ${l.fromLoader ? 'loader 已加载' : '仅目录扫描'}`
  })
  const bad = scan.locales.filter(l => !Config.getTranslateLocaleStatus(engine, l.locale).supported)
  const tagSystem = workspace.getConfiguration('i18n-ally').get<string>('languageTagSystem') || 'bcp47'
  const hasLongCode = scan.locales.some(l => l.locale.split(/[-_]/)[0].length > 2)
  const source = Config.sourceLanguage
  const sourceFound = scan.locales.some(l => Config.isSameLocale(l.locale, source))
  const suspicious = findSuspiciousLocales(scan)
  const whitelist = Config.localeFiles
  const health = inspectLocaleDirs(root, localePath)
  const { issue } = detectLocaleIssue(root, localePath, scan)
  const missingNote = health.missing.length
    ? `  ⚠ 不存在：${health.missing.map(d => path.relative(root, d).replace(/\\/g, '/')).join('、')}`
    : ''
  const jsonNote = health.jsonNames.length
    ? `${health.jsonNames.length} 个（${health.jsonNames.slice(0, 8).join('、')}${health.jsonNames.length > 8 ? '…' : ''}）`
    : '0 个'
  const issueNote = issue === 'no-path'
    ? '⚠ 语言文件目录没配或不存在'
    : issue === 'recognition'
      ? '⚠ 目录里有 JSON 但 loader 一个都没加载 → 检查 pathMatcher / dirStructure / namespace / languageTagSystem'
      : '正常'

  const lines = [
    `翻译引擎：${engineLabel(engine)}（${engine}）`,
    `映射配置来源：${inspectLocaleMapOrigin().label}`,
    `引擎语言清单：${result.locales.length} 种 · ${sourceText(result)}`,
    `语言文件目录：${health.configured.join(', ') || '（未配置）'}${missingNote}`,
    `目录根下 JSON：${jsonNote}`,
    `识别判定：${issueNote}`,
    `扫描规则：${scan.matchers.map(m => m.matcher).join(' | ')}`,
    `语言文件：loader 已加载 ${scan.loaderCount} 个，目录补充 ${scan.scannedCount} 个，未识别 ${scan.unrecognized.length} 个`,
    `语言文件白名单：${whitelist.length ? `${whitelist.length} 个（${whitelist.join('、')}）` : '未配置，按 pathMatcher 自动识别'}`,
    suspicious.length ? `  ⚠ 可疑语言：${suspicious.join('、')}（多半是 commWord.json 之类数据文件被误认，建议逐个选取语言文件）` : '',
    `语言码系统：${tagSystem}${tagSystem === 'legacy' && hasLongCode ? '  ⚠ 会丢弃 chs/can 这类三字母语言码' : ''}`,
    `源语言：${source}${sourceFound ? '' : '  ⚠ 项目语言文件里没有这个标识，翻译时会取不到源文'}`,
    '',
    ...rows,
  ]
  if (scan.unrecognized.length)
    lines.push('', `未识别文件（可手动纳入）：${scan.unrecognized.map(f => f.relativePath).join('、')}`)

  Log.info(`[translate-locales] 诊断：\n${lines.join('\n')}`)

  const actions: string[] = []
  if (issue === 'no-path')
    actions.push('选择语言文件目录')
  if (suspicious.length || issue === 'recognition')
    actions.push('逐个选取语言文件')
  if (tagSystem === 'legacy' && hasLongCode)
    actions.push('修复语言码系统')
  if (bad.length)
    actions.push('去绑定未识别的语言')
  if (scan.unrecognized.length)
    actions.push('手动纳入其它文件')
  actions.push('新建语言文件', '打开本项目设置')

  const choice = await window.showInformationMessage(
    [
      `共 ${scan.locales.length} 种语言，${bad.length} 个无法解析${bad.length ? `：${bad.map(l => l.locale).join('、')}` : ''}。`,
      suspicious.length ? `⚠ 检测到 ${suspicious.join('、')} 不像语言码，多半是数据文件被 pathMatcher 误认成语言。` : '',
      issue === 'no-path' ? '语言文件目录没配或不存在，插件读不到任何翻译文件。' : '',
      issue === 'recognition' ? `目录里有 ${health.jsonNames.length} 个 JSON，但 loader 一个都没加载，多半是文件名 / pathMatcher 没配上。` : '',
      `另有 ${scan.unrecognized.length} 个文件未识别（默认排除，可手动纳入）。`,
      tagSystem === 'legacy' && hasLongCode ? '当前 languageTagSystem=legacy 会丢弃三字母语言码。' : '',
      sourceFound ? '' : `源语言 ${source} 在项目里找不到对应文件，翻译会取不到源文。`,
      '完整清单已输出到 i18n Ally 日志。',
    ].filter(Boolean).join(' '),
    ...actions,
  )

  if (choice === '选择语言文件目录') {
    await pickAndWriteLocalesPaths(root)
  }
  else if (choice === '逐个选取语言文件') {
    await selectLocaleFiles(root, localePath)
  }
  else if (choice === '修复语言码系统') {
    await Config.updateConfig('languageTagSystem', 'none', false)
    window.showInformationMessage('已把 languageTagSystem 改为 none（工作区设置），重新加载窗口后生效')
  }
  else if (choice === '去绑定未识别的语言') {
    await bindOne(engine, root, localePath)
  }
  else if (choice === '手动纳入其它文件') {
    await includeManually(engine, root, localePath, scan)
  }
  else if (choice === '新建语言文件') {
    await createLocaleFile(engine, root, localePath)
  }
  else if (choice === '打开本项目设置') {
    await openWorkspaceSettings()
  }
}

// #region 从引擎语言清单直接创建项目语言文件

interface LocalePick extends Pick {
  locale: EngineLocale
}

interface SourcePick extends Pick {
  source: ProjectLocale
}

interface CreatePlan {
  sourcePath: string
  targetPath: string
  relativePath: string
  keyCount: number
}

/** 从引擎真实语言清单里选一门语言，用来新建项目语言文件 */
async function pickLanguageToCreate(
  engine: string,
  result: EngineLocaleListResult,
  scan: ProjectScan,
): Promise<EngineLocale | undefined> {
  if (!result.locales.length) {
    const code = await window.showInputBox({
      title: `${engineLabel(engine)} 未声明语言清单`,
      prompt: '请直接填写该引擎的 API 语言码，它同时作为新语言文件的语言标识',
      placeHolder: '例如 fr',
      validateInput: v => (v.trim() ? undefined : '不能为空'),
    })
    return code?.trim() ? { code: code.trim(), name: code.trim() } : undefined
  }

  if (result.error)
    window.showWarningMessage(`实时读取语言清单失败（${result.error}），已退回内置声明`)

  const targets = result.locales.filter(l => !l.sourceOnly)
  const items: LocalePick[] = targets.map((l) => {
    const owned = scan.locales
      .filter((p) => {
        const status = Config.getTranslateLocaleStatus(engine, p.locale)
        return status.resolved === l.code || Config.isSameLocale(p.locale, l.code)
      })
      .map(p => p.locale)
    return {
      label: `${owned.length ? '$(check) ' : ''}${l.name}`,
      description: l.code,
      detail: [
        owned.length ? `项目已有：${owned.join('、')}（不建议重复创建）` : '项目中尚无对应语言文件',
        l.note,
        l.aliases?.length ? `别名：${l.aliases.join(' / ')}` : '',
      ].filter(Boolean).join(' · '),
      value: l.code,
      locale: l,
    }
  })

  const picked = await window.showQuickPick(items, {
    title: `新建语言文件 · 选择 ${engineLabel(engine)} 支持的语言（${targets.length} 种 · ${sourceText(result)}）`,
    placeHolder: '可输入中文名、语言码或别名搜索；选中的语言会生成对应的项目语言文件',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  return picked?.locale
}

/**
 * 翻译的源文件：默认就是项目里「当前默认显示 / 源语言」对应的那个语言文件。
 * 两者不一致、或该语言在项目中不存在对应文件时，列出来让用户确认，
 * 并且用「选中语言的真实标识」而不是 Config.sourceLanguage 去取源文，
 * 避免 sourceLanguage=zh-cn 而文件叫 chs.json 时一条都翻不出来。
 */
async function pickSourceLocale(scan: ProjectScan, quiet = false): Promise<ProjectLocale | undefined> {
  const candidates = scan.locales.filter(l => l.files.length)
  if (!candidates.length)
    return undefined

  const source = Config.sourceLanguage
  const display = Config.displayLanguage
  const bySource = candidates.find(l => Config.isSameLocale(l.locale, source))
  const byDisplay = candidates.find(l => Config.isSameLocale(l.locale, display))
  // sourceLanguage / displayLanguage 都对不上项目文件时（Vue.Web 的 zh-cn / ko
  // 对 chs/can/en），词条最全的那个通常才是真正的源语言，别默认拿字母序第一个
  const byFullest = [...candidates].sort((a, b) => (b.keyCount || 0) - (a.keyCount || 0))[0]
  const preferred = bySource || byDisplay || byFullest

  // 源语言 = 默认显示语言、且项目里确实有这个文件时无需再问一次
  if (candidates.length === 1 || (quiet && bySource))
    return preferred

  const items: SourcePick[] = candidates.map(l => ({
    label: `${l.locale === preferred.locale ? '$(star) ' : ''}${l.locale}`,
    description: [
      Config.isSameLocale(l.locale, source) ? '当前源语言' : '',
      Config.isSameLocale(l.locale, display) ? '当前默认显示语言' : '',
      !bySource && !byDisplay && l === byFullest ? '词条最多，疑似源语言' : '',
      `${l.files.length} 个文件`,
    ].filter(Boolean).join(' · '),
    detail: `${l.files.map(f => f.relativePath).join('、')} · ${l.keyCount ?? '—'} 条词条 · 翻译时从这里取源文`,
    picked: l.locale === preferred.locale,
    value: l.locale,
    source: l,
  }))

  const picked = await window.showQuickPick(items, {
    title: '以哪个语言文件为模板 / 翻译源？',
    placeHolder: '默认选中当前默认显示（源）语言，新文件会复制它的全部 key、译文留空',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  return picked?.source
}

/** 按项目原有目录结构与 pathMatcher，为每个源文件算出对应的新文件路径 */
function buildCreatePlans(scan: ProjectScan, source: ProjectLocale, targetLocale: string): CreatePlan[] {
  const root = Global.rootpath
  const exts = Global.enabledParserExts
  const plans: CreatePlan[] = []
  const seen = new Set<string>()

  for (const file of source.files) {
    const baseDir = scan.dirs
      .filter(d => file.filepath.toLowerCase().startsWith(`${d.toLowerCase()}${path.sep}`))
      .sort((a, b) => b.length - a.length)[0] || path.dirname(file.filepath)

    let targetPath = deriveLocaleFilePath(
      file.filepath, baseDir, source.locale, targetLocale, file.matcher, exts,
    )
    if (!isWritableLocaleExt(path.extname(targetPath)))
      targetPath = targetPath.replace(/\.[^.]+$/, '.json')

    const key = targetPath.toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    plans.push({
      sourcePath: file.filepath,
      targetPath,
      relativePath: path.relative(root, targetPath).replace(/\\/g, '/'),
      keyCount: file.keyCount || 0,
    })
  }
  return plans
}

async function confirmCreatePaths(plans: CreatePlan[], root: string): Promise<CreatePlan[] | undefined> {
  if (plans.length === 1) {
    const input = await window.showInputBox({
      title: '确认新语言文件路径',
      prompt: '相对工作区根目录，可自行修改；扩展名决定文件格式，不会覆盖已有文件',
      value: plans[0].relativePath,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const value = v.trim()
        if (!value)
          return '不能为空'
        if (path.isAbsolute(value) || value.includes('..'))
          return '请填写工作区内的相对路径'
        if (!isWritableLocaleExt(path.extname(value)))
          return '目前支持 .json / .json5 / .yaml / .yml'
        if (fs.existsSync(path.join(root, value)))
          return '该文件已存在，请换一个名字（不会覆盖已有语言文件）'
        return undefined
      },
    })
    if (!input)
      return
    const relativePath = input.trim().replace(/\\/g, '/')
    return [{ ...plans[0], relativePath, targetPath: path.join(root, relativePath) }]
  }

  const OK = '__create_these__'
  const items: Pick[] = [
    {
      label: `$(check) 创建这 ${plans.length} 个语言文件`,
      description: plans.map(p => p.relativePath).join('、'),
      detail: '多命名空间项目：源语言有几个文件，新语言就对应生成几个文件',
      value: OK,
    },
    ...plans.map(p => ({
      label: `$(file) ${p.relativePath}`,
      description: `模板：${path.basename(p.sourcePath)} · ${p.keyCount} 条 key`,
      value: p.relativePath,
    })),
    { label: '$(x) 取消', value: '__cancel__' },
  ]
  const picked = await window.showQuickPick(items, {
    title: `即将创建 ${plans.length} 个语言文件`,
    placeHolder: '确认后写入；已存在的文件不会被覆盖',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  return picked?.value === OK ? plans : undefined
}

async function pickCreateMode(sourceLocale: string, keyCount: number): Promise<'skeleton' | 'empty' | undefined> {
  const items: Pick[] = [
    {
      label: '$(files) 复制源语言全部 key（译文留空）',
      description: '推荐',
      detail: `以 ${sourceLocale} 的约 ${keyCount} 条 key 为模板；之后翻译会逐条从该语言取源文`,
      value: 'skeleton',
    },
    {
      label: '$(file) 只创建空文件 {}',
      detail: '文件先占位成为目标语言，翻译时插件自动补齐缺失的 key',
      value: 'empty',
    },
  ]
  const picked = await window.showQuickPick(items, {
    title: '新语言文件的初始内容',
    placeHolder: '两种都能被「翻译全部缺失」识别并填充',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  return picked?.value as 'skeleton' | 'empty' | undefined
}

async function writeNewLocaleFile(plan: CreatePlan, mode: 'skeleton' | 'empty'): Promise<void> {
  let skeleton: Record<string, any> = {}
  let sourceRaw = ''

  if (mode === 'skeleton') {
    try {
      sourceRaw = await File.read(plan.sourcePath)
      const text = sourceRaw.replace(/^\uFEFF/, '')
      const sourceExt = path.extname(plan.sourcePath)
      const sourceParser = Global.getMatchedParser(sourceExt)
      // js/ts 解析器要走 loader.js 才能拿到对象，它的 parse() 是空实现
      const data = /\.(js|ts)$/i.test(sourceExt) && sourceParser
        ? await sourceParser.load(plan.sourcePath)
        : sourceParser ? await sourceParser.parse(text) : JSON.parse(text)
      skeleton = buildEmptySkeleton(data)
    }
    catch (e) {
      Log.warn(`[translate-locales] 读取源语言文件失败，改为创建空文件：${(e as Error).message}`)
      skeleton = {}
    }
  }

  const ext = path.extname(plan.targetPath)
  const parser = Global.getMatchedParser(ext)
  if (parser && !parser.readonly) {
    await parser.save(plan.targetPath, skeleton, false, undefined)
    if (fs.existsSync(plan.targetPath))
      return
  }

  // 兜底：js/ts 等只读解析器不落盘时，按源文件缩进直接写 JSON 语法（json5/yaml 也兼容）
  const indent = detectIndent(sourceRaw)
  const spaces = typeof indent === 'number' ? ' '.repeat(indent) : indent
  await File.write(plan.targetPath, `${JSON.stringify(skeleton, null, spaces)}\n`)
}

/** 只翻译刚创建的这门语言，源语言取用户上一步选定的真实语言标识 */
async function translateNewLocale(locale: string, sourceLocale: string): Promise<void> {
  const loader = CurrentFile.loader
  const coverage = loader.getCoverage(locale)
  if (!coverage) {
    window.showWarningMessage(`新语言 ${locale} 还没被 loader 识别，请检查 pathMatcher 或重启扩展宿主后再翻译`)
    return
  }

  const keys = [...coverage.missingKeys, ...coverage.emptyKeys]
  const nodes: AccaptableTranslateItem[] = []
  for (const keypath of keys) {
    if (loader.getNodeByKey(keypath)?.getValue(sourceLocale))
      nodes.push({ locale, keypath, type: undefined })
  }
  if (!nodes.length) {
    window.showInformationMessage(`没有待翻译的文案（源语言 ${sourceLocale} 中无对应原文）`)
    return
  }

  window.showInformationMessage(`开始翻译 ${nodes.length} 条文案，源语言：${sourceLocale}`)
  await Translator.translateNodes(loader, nodes, sourceLocale, [locale])
}

/**
 * 从「翻译引擎支持的某个语言」直接创建项目语言文件：
 * 下拉选语言 → 建议语言标识 → 以当前默认显示/源语言文件为模板 → 写盘 + 绑定 + 刷新。
 */
export async function createLocaleFile(engine?: string, root?: string, localePath?: string): Promise<void> {
  const theEngine = engine || Config.translateEngines[0] || 'google'
  const theRoot = root || Global.rootpath
  const thePath = localePath || Global.localesPaths?.[0]
  const scan = collectProjectLocales(theRoot, thePath)

  if (await guideMissingLocaleFiles(theRoot, thePath, scan))
    return
  if (!scan.locales.length) {
    const action = '运行初始化配置引导'
    const choice = await window.showWarningMessage(
      '没有扫描到语言文件，请先确认语言文件目录（localesPaths）与 pathMatcher。',
      action,
    )
    if (choice === action)
      await commands.executeCommand(Commands.setup_wizard)
    return
  }

  const result = await loadEngineLocales(theEngine)
  const target = await pickLanguageToCreate(theEngine, result, scan)
  if (!target)
    return

  const existing = scan.locales.map(l => l.locale)
  const locale = await window.showInputBox({
    title: `新语言文件的语言标识（${target.name} → ${target.code}）`,
    prompt: '同时作为文件名与 translate.localeMap 的 key；项目里已有的语言会自动排除',
    value: suggestLocaleName(target.code, target.aliases, existing),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const value = v.trim()
      if (!value)
        return '不能为空'
      if (!/^[a-zA-Z][\w-]*$/.test(value))
        return '只能包含字母、数字、连字符或下划线，且以字母开头'
      if (existing.some(l => Config.isSameLocale(l, value)))
        return '项目里已经存在这个语言标识，请换一个'
      return undefined
    },
  })
  if (!locale)
    return
  const newLocale = locale.trim()

  const source = await pickSourceLocale(
    scan,
    Config.isSameLocale(Config.sourceLanguage, Config.displayLanguage),
  )
  if (!source) {
    window.showWarningMessage('找不到可作为模板的源语言文件')
    return
  }

  const plans = buildCreatePlans(scan, source, newLocale)
  if (!plans.length) {
    window.showWarningMessage('无法从源语言文件推导新文件路径')
    return
  }
  const existingFiles = plans.filter(p => fs.existsSync(p.targetPath))
  if (existingFiles.length) {
    window.showWarningMessage(`以下文件已存在，未做任何改动：${existingFiles.map(p => p.relativePath).join('、')}`)
    return
  }

  const confirmed = await confirmCreatePaths(plans, theRoot)
  if (!confirmed)
    return
  const mode = await pickCreateMode(source.locale, confirmed.reduce((n, p) => n + p.keyCount, 0))
  if (!mode)
    return

  try {
    for (const plan of confirmed)
      await writeNewLocaleFile(plan, mode)
  }
  catch (e) {
    window.showErrorMessage(`创建语言文件失败：${(e as Error).message}`)
    return
  }

  await writeBinding(theEngine, newLocale, target.code)
  const fixedTagSystem = await ensureLongLocaleSupport([...existing, newLocale])
  // 项目启用了 localeFiles 白名单时，新文件不在名单里就不会被 loader 读到，
  // 紧接着的「立即翻译该文件」会误报「还没被 loader 识别」。
  const whitelisted = await addToLocaleFiles(theRoot, confirmed.map(p => p.targetPath))

  try {
    await Global.loader?.reloadFromDisk()
    CurrentFile.invalidate()
  }
  catch (e) {
    Log.warn(`[translate-locales] 新语言文件已写入，主动刷新失败（文件监听仍会兜底）：${(e as Error).message}`)
  }

  const parts = [
    `已创建 ${confirmed.length} 个语言文件：${confirmed.map(p => p.relativePath).join('、')}`,
    `绑定 ${newLocale} → ${target.code}（${engineLabel(theEngine)}）已写入工作区设置`,
    mode === 'skeleton'
      ? `以 ${source.locale} 的全部 key 为模板，译文留空`
      : '空文件，翻译时自动补 key',
    fixedTagSystem ? 'languageTagSystem 已改为 none（重新加载窗口后完全生效）' : '',
    whitelisted ? '新文件已加入 localeFiles 白名单' : '',
  ].filter(Boolean).join('；')
  Log.info(`[translate-locales] ${parts}`)

  const actions = ['立即翻译该文件', '打开语言文件']
  if (!Config.isSameLocale(Config.sourceLanguage, source.locale))
    actions.push(`把源语言设为 ${source.locale}`)

  const choice = await window.showInformationMessage(parts, ...actions)
  if (choice === '立即翻译该文件') {
    await translateNewLocale(newLocale, source.locale)
  }
  else if (choice === '打开语言文件') {
    const doc = await workspace.openTextDocument(Uri.file(confirmed[0].targetPath))
    await window.showTextDocument(doc)
  }
  else if (choice?.startsWith('把源语言设为 ')) {
    await Config.updateConfig('sourceLanguage', source.locale, false)
    window.showInformationMessage(`已把源语言设为 ${source.locale}，` + '「翻译全部缺失」也会从这个语言取源文')
  }
}

// #endregion

async function run(): Promise<void> {
  const engine = Config.translateEngines[0] || 'google'
  const root = Global.rootpath
  const localePath = Global.localesPaths?.[0]
  const scan = collectProjectLocales(root, localePath)
  const supportedCount = Config.getTranslateEngineLocales(engine).length
  const { issue } = detectLocaleIssue(root, localePath, scan)
  const origin = inspectLocaleMapOrigin()
  const suspicious = findSuspiciousLocales(scan)
  const whitelist = Config.localeFiles

  // 连语言文件目录都没配（或配的目录全都不存在）时，先解决这个再谈映射
  if (issue === 'no-path') {
    await guideMissingLocaleFiles(root, localePath, scan)
    return
  }

  const items: Pick[] = []
  if (suspicious.length) {
    items.push({
      label: `$(warning) 排除误识别的文件：${suspicious.join('、')}`,
      description: '这些不是语言码，多半是 commWord.json 之类数据文件被 pathMatcher 当成了语言',
      detail: '逐个勾选真正的语言文件，写入本项目 .vscode/settings.json 的 localeFiles 白名单',
      value: SELECT_FILES,
    })
  }
  if (issue === 'recognition') {
    items.push({
      label: '$(warning) 修复语言文件识别',
      description: '目录里有 JSON，但插件一个语言文件都没加载 → 多半是文件名 / pathMatcher 没配上',
      detail: '列出目录里的文件供逐个勾选，把白名单 / dirStructure / namespace / 语言码系统写入本项目 .vscode/settings.json',
      value: FIX_SCAN,
    })
  }
  if (origin.needsMigration) {
    items.push({
      label: '$(arrow-down) 把用户级映射迁到本项目',
      description: '检测到映射写在用户 settings.json 里，会串到其它项目',
      detail: '复制进当前项目 .vscode/settings.json；用户级那份保留不动（其它项目可能还在用）',
      value: MIGRATE,
    })
  }
  if (!suspicious.length) {
    items.push({
      label: '$(checklist) 逐个选取语言文件',
      description: whitelist.length
        ? `当前白名单 ${whitelist.length} 个文件`
        : '当前按 pathMatcher 自动识别，可能把 commWord.json 之类数据文件误当语言',
      detail: '勾选的才作为语言文件加载；结果写入本项目 .vscode/settings.json 的 localeFiles 白名单',
      value: SELECT_FILES,
    })
  }
  items.push(
    {
      label: '$(link) 绑定项目语言文件',
      description: `扫到 ${scan.locales.length} 种语言 / ${scan.loaderCount + scan.scannedCount} 个文件 → 指定翻译语言`,
      detail: `loader 已加载 ${scan.loaderCount} 个、目录补充 ${scan.scannedCount} 个；未被识别 ${scan.unrecognized.length} 个`,
      value: BIND,
    },
    {
      label: '$(new-file) 从引擎语言清单创建语言文件',
      description: `选一门引擎支持的语言，直接生成对应的 .json（当前项目 ${scan.locales.length} 种语言）`,
      detail: '以当前默认显示 / 源语言文件为模板复制全部 key、译文留空，创建后可立即翻译',
      value: CREATE,
    },
    {
      label: '$(list-unordered) 查看引擎支持的全部语言',
      description: `内置 ${supportedCount} 种，点开时尝试从引擎接口实时读取`,
      detail: '清单由引擎自身提供（百度为内置声明，DeepL/LibreTranslate/Google Cloud 可实时读取）',
      value: LIST,
    },
    {
      label: '$(sync) 强制刷新引擎语言清单',
      description: '重新请求 /languages，结果会同步给别名解析与翻译前校验',
      value: REFRESH,
    },
    {
      label: '$(check) 一键写入推荐绑定',
      description: '把能自动匹配的语言写成显式映射，配置可见可改',
      value: APPLY,
    },
    {
      label: '$(warning) 诊断当前配置',
      description: '列出每个语言文件的来源、词条数、解析状态与语言码系统风险',
      value: DIAGNOSE,
    },
    {
      label: '$(add) 手动纳入被排除的文件',
      description: `${scan.unrecognized.length} 个文件未识别为语言文件`,
      detail: '默认不主动扫描对比；若新改动明确涉及，可在这里纳入考虑范围',
      value: MANUAL,
    },
    {
      label: '$(settings-gear) 打开本项目的 settings.json',
      description: `当前映射来源：${origin.label}`,
      detail: '映射 / localesPaths / pathMatcher 都按项目保存，不污染用户级设置',
      value: OPEN_SETTINGS,
    },
  )

  const picked = await window.showQuickPick(items, {
    title: `翻译语言映射 · ${engineLabel(engine)} · ${origin.label}`,
    placeHolder: '把引擎的可用语言与项目里真实存在的语言文件对应起来，避免翻译被静默跳过',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!picked)
    return

  switch (picked.value) {
    case FIX_SCAN:
      await guideMissingLocaleFiles(root, localePath, scan)
      break
    case SELECT_FILES:
      await selectLocaleFiles(root, localePath)
      break
    case MIGRATE:
      await migrateUserLocaleMap(origin)
      break
    case OPEN_SETTINGS:
      await openWorkspaceSettings()
      break
    case BIND:
      await bindOne(engine, root, localePath)
      break
    case CREATE:
      await createLocaleFile(engine, root, localePath)
      break
    case LIST:
      await showSupportedLanguages(engine)
      break
    case REFRESH:
      await refreshEngineLocales(engine)
      break
    case APPLY: {
      const result = await applyRecommendedLocaleMap(engine, root, localePath)
      const parts = [`已写入 ${result.written} 条映射`]
      if (result.fixedTagSystem)
        parts.push('languageTagSystem 已改为 none')
      if (result.unresolved.length)
        parts.push(`未识别：${result.unresolved.join('、')}（需手动绑定）`)
      window.showInformationMessage(parts.join('；'))
      break
    }
    case DIAGNOSE:
      await diagnose(engine, root, localePath)
      break
    case MANUAL:
      await includeManually(engine, root, localePath, scan)
      break
  }
}

const m: ExtensionModule = () => {
  return [
    commands.registerCommand(Commands.config_translate_locales, () => run()),
    commands.registerCommand(Commands.open_workspace_settings, () => openWorkspaceSettings()),
    commands.registerCommand(Commands.select_locale_files, () => selectLocaleFiles(Global.rootpath, Global.localesPaths?.[0])),
    commands.registerCommand(Commands.create_locale_file, () => createLocaleFile()),
  ]
}

export default m
