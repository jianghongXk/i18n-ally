import fs from 'fs'
import path from 'path'
import fg from 'fast-glob'
import JSON5 from 'json5'
import { commands, window, workspace } from 'vscode'
import type { QuickPickItem } from 'vscode'
import type { ExtensionContext } from 'vscode'
import { Commands } from './commands'
import { ConfigLocalesGuide } from './configLocalePaths'
import { ExtensionModule } from '~/modules'
import { Config } from '~/core'
import { promptAndSaveCreds } from '~/core/BizSync'
import { Log } from '~/utils'

const BAIDU_APPLY_URL = 'https://fanyi-api.baidu.com/manage/developer'

interface Pick extends QuickPickItem {
  value: string
}

interface LocaleDirCandidate {
  dir: string
  count: number
  byName: boolean
}

const LANGUAGES: Pick[] = [
  { label: '简体中文', description: 'zh-CN', value: 'zh-CN' },
  { label: 'English', description: 'en', value: 'en' },
  { label: '日本語', description: 'ja', value: 'ja' },
  { label: '한국어', description: 'ko', value: 'ko' },
  { label: 'Deutsch', description: 'de', value: 'de' },
  { label: 'Русский', description: 'ru', value: 'ru' },
  { label: 'Français', description: 'fr', value: 'fr' },
  { label: 'Español', description: 'es', value: 'es' },
  { label: 'Português', description: 'pt-BR', value: 'pt-BR' },
  { label: '繁體中文', description: 'zh-TW', value: 'zh-TW' },
]

/**
 * 推荐配置：取自 hite-cloud-ems-ui/.vscode/settings.json 里成体系的 i18n-ally 设置。
 * 适合 Vue + Element Plus + 数字 key 的项目；其它技术栈可以只写基础项。
 */
const RECOMMENDED: Record<string, any> = {
  'extract.autoDetect': true,
  'extract.ignoredRegex': [
    '^[^\\w\\u4e00-\\u9fff]+$',
    '^/$',
    '^[a-zA-Z]+$',
    '^[\\d.]+$',
    'rgba\\(.*?\\)',
    '^\\(.+\\)$',
    '^（.+）$',
    '}\\s*[A-Za-z]{1,3}$',
    '.*?\\.svg',
  ],
  'extract.ignored': ['YYYY-MM-DD HH:mm:ss'],
  'extract.parsers.html': {
    attributes: [
      'text',
      'title',
      'alt',
      'range-separator',
      'placeholder',
      'label',
      'aria-label',
      'start-placeholder',
      'end-placeholder',
      'name',
      'content',
      'subTitle',
    ],
    ignoredTags: ['script', 'style'],
    vBind: true,
    inlineText: true,
  },
  pathMatcher: '{locale}.json',
  'review.enabled': true,
  localeCountryMap: { 'zh-cn': '简体中文', en: 'English' },
}

const ENGINES: Pick[] = [
  { label: '$(globe) 百度翻译', description: '国内直连，需要 APPID + 密钥', value: 'baidu' },
  { label: '$(globe) Google 翻译', description: '不需要密钥，国内网络可能不通', value: 'google' },
  { label: '$(globe) DeepL', description: '需要 API Key，质量较好', value: 'deepl' },
  { label: '$(globe) OpenAI', description: '需要 API Key', value: 'openai' },
  { label: '$(circle-slash) 暂不配置', description: '以后可以在设置里补', value: '' },
]

/** 扫出可能存放语言文件的目录（相对 root），按 json 数量降序 */
async function detectLocaleDirs(root: string): Promise<LocaleDirCandidate[]> {
  let files: string[]
  try {
    files = await fg('**/*.json', {
      cwd: root,
      deep: 6,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/.git/**',
        '**/coverage/**',
        '**/test/**',
        '**/tests/**',
        '**/__snapshots__/**',
        '**/reports/**',
        '**/.next/**',
        '**/.nuxt/**',
      ],
    })
  }
  catch (e) {
    Log.warn(`[setup] 扫描语言目录失败: ${(e as Error).message}`)
    return []
  }

  // 先按目录聚合，再判断是不是语言目录：
  //   ① 目录名像 locales/i18n/lang —— 直接算候选
  //   ② 目录名不像，但里面全是「语言码形态」的 json（chs.json / can.json / en.json）—— 也算候选
  //      （语言文件放 src/assets、src/lang 甚至 src/config 的都见过，不能只认目录名）
  const byDir = new Map<string, string[]>()
  for (const file of files) {
    const dir = path.posix.dirname(file).replace(/^\.\//, '')
    const list = byDir.get(dir) ?? []
    list.push(path.posix.basename(file))
    byDir.set(dir, list)
  }

  const NAME_RE = /(^|\/)(locales?|i18n|langs?|languages?|messages)(\/|$)/i
  // 语言码形态：2-3 位语言 + 最多两段子标签（chs / en / zh-CN / zh-Hans-CN / pt-br）
  // 用 {2,3} 卡住 language，避免把 logo.json / config.json 这类也当成语言文件
  const LOCALE_FILE_RE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8}){0,2}\.json$/i
  const SKIP_NAMES = new Set(['index', 'package', 'package-lock', 'tsconfig', 'jsconfig', 'data', 'config', 'settings', 'manifest', 'app', 'env', 'schema', 'mock', 'mocks'])

  const candidates: LocaleDirCandidate[] = []
  for (const [dir, names] of byDir) {
    const byName = NAME_RE.test(`${dir}/`)
    const localeFiles = names.filter((n) => {
      const base = path.posix.basename(n, '.json').toLowerCase()
      return LOCALE_FILE_RE.test(n) && !SKIP_NAMES.has(base)
    })
    if (!byName && localeFiles.length < 2)
      continue
    candidates.push({ dir, count: names.length, byName })
  }

  return candidates
    .sort((a, b) => Number(b.byName) - Number(a.byName) || b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, 8)
}

/** 目录合法性校验：存在、是目录、里面确实有 json */
function validateLocalePath(root: string, input: string): string | undefined {
  const value = input.trim()
  if (!value)
    return '不能为空'
  const abs = path.isAbsolute(value) ? value : path.join(root, value)
  if (!fs.existsSync(abs))
    return `找不到目录：${abs}`
  if (!fs.statSync(abs).isDirectory())
    return '这不是一个目录'
  let files: string[] = []
  try {
    files = fs.readdirSync(abs)
  }
  catch {
    return '目录无法读取'
  }
  if (!files.some(f => f.endsWith('.json')))
    return '该目录下没有 .json 文件'
  return undefined
}

function toRelative(root: string, dir: string): string {
  return (path.isAbsolute(dir) ? path.relative(root, dir) : dir).replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 按 tsconfig/jsconfig 的 paths 把 src 下的路径转成别名，失败退回 @/ */
function toAlias(root: string, relNoExt: string): string {
  for (const file of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const abs = path.join(root, file)
    if (!fs.existsSync(abs))
      continue
    try {
      const json = JSON5.parse(fs.readFileSync(abs, 'utf8'))
      const paths = json?.compilerOptions?.paths ?? {}
      for (const [alias, targets] of Object.entries(paths)) {
        const target = Array.isArray(targets) ? targets[0] : undefined
        if (!alias.includes('*') || typeof target !== 'string')
          continue
        const aliasPrefix = alias.split('*')[0]
        const base = String(target).split('*')[0].replace(/^\.\//, '').replace(/\/$/, '')
        if (base && relNoExt.startsWith(`${base}/`))
          return aliasPrefix + relNoExt.slice(base.length + 1)
      }
    }
    catch {
      // tsconfig 解析失败就试下一个
    }
  }
  return `@/${relNoExt.replace(/^src\//, '')}`
}

/**
 * 探测项目里 `$t` 的导入位置，生成默认的自动 import 语句。
 * 命中条件：文件存在且里面对外导出了 `$t`（export function $t / export const $t）。
 */
function detectAutoImport(root: string): string | undefined {
  const candidates = [
    'src/utils/i18nUtils.ts',
    'src/utils/i18n.ts',
    'src/utils/i18n/index.ts',
    'src/i18n/utils.ts',
    'src/i18n/index.ts',
  ]

  for (const file of candidates) {
    const abs = path.join(root, file)
    if (!fs.existsSync(abs))
      continue
    let content = ''
    try {
      content = fs.readFileSync(abs, 'utf8')
    }
    catch {
      continue
    }
    if (!/export\s+(?:async\s+)?(?:function|const)\s+\$t\b/.test(content))
      continue
    const relNoExt = file.replace(/\.(ts|js)$/, '').replace(/\/index$/, '')
    return `import { $t } from '${toAlias(root, relNoExt)}'`
  }
  return undefined
}

/** 第三步：提取时自动插入的 import 语句 */
async function askAutoImport(root: string): Promise<string | undefined> {
  const detected = detectAutoImport(root)
  const current = Config.extractAutoImportStatement || detected || ''

  const input = await window.showInputBox({
    title: '步骤 3/8 · 自动 import 语句',
    prompt: '提取文本后，若脚本文件用了 $t 却没有 import，会自动插入这条语句。留空回车表示不插入；只对 ts/js/tsx/jsx 生效。',
    placeHolder: `import { $t } from '@/utils/i18nUtils'${detected ? '' : '（没探测到，可自行填写）'}`,
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const text = v.trim()
      if (!text)
        return undefined
      if (!/^(import|const|let|var)\b/.test(text))
        return '看起来不是一条 import 语句；不需要可以留空'
      if (!/\$t\b/.test(text))
        return '这条语句里没有 $t，确认一下要导入的函数名'
      return undefined
    },
  })

  return input === undefined ? undefined : input.trim()
}

/** 第一步：确认项目根路径（i18n-ally 以 VS Code 打开的文件夹为根，无法自定义） */
async function pickRoot(): Promise<string | undefined> {
  const folders = workspace.workspaceFolders
  if (!folders?.length) {
    window.showWarningMessage('请先用 VS Code 打开项目文件夹，再运行初始化引导')
    return
  }

  const picks: Pick[] = folders.map(f => ({
    label: `$(folder) ${f.name}`,
    description: f.uri.fsPath,
    value: f.uri.fsPath,
  }))

  const picked = await window.showQuickPick(picks, {
    title: '步骤 1/8 · 项目根路径',
    placeHolder: '插件以 VS Code 打开的文件夹作为项目根路径，层级不对请重新打开文件夹',
    ignoreFocusOut: true,
  })
  return picked?.value
}

/** 第二步：确认语言文件所在目录 */
async function pickLocalePath(root: string): Promise<string | undefined> {
  const candidates = await detectLocaleDirs(root)
  const configured = Config._localesPaths?.[0]

  const picks: Pick[] = candidates.map(c => ({
    label: `$(folder) ${c.dir}`,
    description: `${c.count} 个 json 文件${c.byName ? '' : ' · 按文件命名推断'}`,
    picked: configured ? c.dir === toRelative(root, configured) : c.dir === candidates[0].dir,
    value: c.dir,
  }))

  picks.push({ label: '$(edit) 手动输入路径…', value: '__manual__' })
  picks.push({ label: '$(folder-opened) 浏览选择目录…', value: '__browse__' })

  const picked = await window.showQuickPick(picks, {
    title: '步骤 2/8 · 语言文件所在位置',
    placeHolder: candidates.length
      ? `检测到 ${candidates.length} 个候选目录，例如 ${candidates[0].dir}`
      : '没检测到明显的语言目录，可以手动输入或浏览',
    ignoreFocusOut: true,
  })
  if (!picked)
    return

  if (picked.value === '__browse__') {
    const dirs = await ConfigLocalesGuide.pickDir()
    return dirs[0]
  }

  if (picked.value === '__manual__') {
    const input = await window.showInputBox({
      title: '步骤 2/8 · 语言文件所在位置',
      prompt: `相对项目根路径（${root}），也可以填绝对路径`,
      placeHolder: 'src/locales/files',
      value: candidates[0]?.dir ?? 'src/locales',
      ignoreFocusOut: true,
      validateInput: v => validateLocalePath(root, v),
    })
    return input?.trim()
  }

  return picked.value
}

/** 第三步：主语言（同时作为界面显示语言与源语言） */
async function pickLanguage(root: string, localePath: string): Promise<string | undefined> {
  // 以目录里真实存在的 json 文件名作为提示，找不到就退回当前配置
  const abs = path.isAbsolute(localePath) ? localePath : path.join(root, localePath)
  let detected: string[] = []
  try {
    detected = fs.readdirSync(abs).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'))
  }
  catch {
    detected = []
  }
  const explicit = workspace.getConfiguration('i18n-ally').get<string>('sourceLanguage')
  const current = explicit || (detected.some(d => /^zh[-_]?cn$/i.test(d)) ? 'zh-CN' : Config.sourceLanguage)

  // 目录里真实存在的语言码优先，再补标准语言表 —— 有的项目用 chs / can / zh-hans 这类非标准写法，
  // 只列内置语言表会让人选不到自己的。
  const picks: Pick[] = []
  const seen = new Set<string>()
  for (const lang of detected) {
    if (seen.has(lang.toLowerCase()))
      continue
    seen.add(lang.toLowerCase())
    picks.push({
      label: `$(file) ${lang}`,
      description: '语言文件里已有',
      picked: lang.toLowerCase() === current.toLowerCase(),
      value: lang,
    })
  }
  for (const l of LANGUAGES) {
    if (seen.has(l.value.toLowerCase()))
      continue
    picks.push({ ...l, picked: l.value.toLowerCase() === current.toLowerCase() })
  }
  picks.push({ label: '$(edit) 手动输入语言标识…', value: '__manual__' })

  const picked = await window.showQuickPick(picks, {
    title: '步骤 4/8 · 项目主语言',
    placeHolder: detected.length
      ? `key 对应的原文语言，同时作为插件界面/注解语言（目录里有：${detected.join(', ')}）`
      : 'key 对应的原文语言，同时作为插件界面/注解语言',
    ignoreFocusOut: true,
  })
  if (!picked)
    return

  if (picked.value !== '__manual__')
    return picked.value

  const manual = await window.showInputBox({
    title: '步骤 4/8 · 主语言',
    prompt: '填语言文件的标识，要和文件名一致（例如 chs、can、zh-CN）',
    placeHolder: 'zh-CN',
    value: current,
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : '不能为空'),
  })
  return manual?.trim()
}

/** 第四步：翻译引擎 */
async function pickEngine(): Promise<string | undefined> {
  const explicit = workspace.getConfiguration('i18n-ally').get<string[]>('translate.engines')?.[0]
  const current = explicit || 'baidu'
  const picks = ENGINES.map(e => ({ ...e, picked: e.value === current }))
  const picked = await window.showQuickPick(picks, {
    title: '步骤 5/8 · 翻译引擎',
    placeHolder: '把 key 翻译成其它语言时用哪个服务',
    ignoreFocusOut: true,
  })
  return picked?.value
}

/** 第五步：百度翻译凭据 */
async function askBaiduCreds(): Promise<{ appid?: string, secret?: string } | undefined> {
  const action = await window.showInformationMessage(
    '百度翻译需要「通用文本翻译」的 APPID 和密钥，未申请可以去百度翻译开放平台创建',
    '打开申请页',
    '继续填写',
  )
  if (!action)
    return
  if (action === '打开申请页')
    await commands.executeCommand(Commands.open_url, BAIDU_APPLY_URL)

  const appid = await window.showInputBox({
    title: '步骤 6/8 · 百度翻译 APPID',
    prompt: `在 ${BAIDU_APPLY_URL} 的「管理控制台 → 开发者信息」里查看`,
    placeHolder: '20240101000000000',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim())
        return '不能为空，留空请按 Esc 取消这一步'
      if (!/^\d{10,}$/.test(v.trim()))
        return 'APPID 通常是 10 位以上纯数字，确认一下'
      return undefined
    },
  })
  if (!appid)
    return

  const secret = await window.showInputBox({
    title: '步骤 6/8 · 百度翻译密钥',
    prompt: '密钥会写入用户级设置（不进项目 .vscode/settings.json，避免提交到仓库）',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : '不能为空'),
  })
  if (!secret)
    return

  return { appid: appid.trim(), secret: secret.trim() }
}

/** 第七步：后端同步（可选） */
interface BackendAnswer {
  enabled: boolean
  baseUrl?: string
  type?: string
  askAuth?: boolean
}

async function askBackend(): Promise<BackendAnswer | undefined> {
  const picks: Pick[] = [
    {
      label: '$(circle-slash) 不配置后端',
      description: '只用本地语言文件，提取/翻译都能正常工作',
      value: 'no',
      picked: !Config.syncBackend.enabled,
    },
    {
      label: '$(cloud-upload) 配置后端同步',
      description: '把当前文件用到的 key 推到 i18n 管理服务，并按文案去重关联',
      value: 'yes',
      picked: Config.syncBackend.enabled,
    },
  ]

  const picked = await window.showQuickPick(picks, {
    title: '步骤 7/8 · 后端同步（可选）',
    placeHolder: '跳过也没关系，以后可用「设置后端账号」「同步本文件 key 到后端」两个命令补上',
    ignoreFocusOut: true,
  })
  if (!picked)
    return
  if (picked.value === 'no')
    return { enabled: false }

  const baseUrl = await window.showInputBox({
    title: '步骤 7/8 · 后端地址',
    prompt: 'i18n 管理服务的基础地址（不带接口路径）',
    placeHolder: 'http://127.0.0.1:8862',
    value: Config.syncBackend.baseUrl || '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const text = v.trim()
      if (!text)
        return '不能为空'
      if (!/^https?:\/\//i.test(text))
        return '要以 http:// 或 https:// 开头'
      return undefined
    },
  })
  if (baseUrl === undefined)
    return

  const type = await window.showInputBox({
    title: '步骤 7/8 · 业务类型 type',
    prompt: '对应后端 i18n_type 字典：1 菜单 / 2 字典 / 3 告警 / 4 后端 / 5 前端 / 6 协议字段，前端项目填 5',
    value: Config.syncBackend.type || '5',
    ignoreFocusOut: true,
    validateInput: v => (/^\d+$/.test(v.trim()) ? undefined : '填字典里的数字值'),
  })
  if (type === undefined)
    return

  const auth = await window.showQuickPick([
    { label: '$(key) 现在填账号密码', description: '加密后存到本地 .vscePackage/.dev-state.json，不会提交', value: 'yes' },
    { label: '$(clock) 以后再说', description: '第一次同步时会自动提示输入', value: 'no' },
  ], {
    title: '步骤 7/8 · 后端账号',
    placeHolder: '跳过也可以，第一次同步时会再问一次',
    ignoreFocusOut: true,
  })
  if (!auth)
    return

  return {
    enabled: true,
    baseUrl: baseUrl.trim(),
    type: type.trim(),
    askAuth: auth.value === 'yes',
  }
}

/** 第八步：是否套用推荐配置 */
async function askPreset(): Promise<boolean | undefined> {
  const picks: Pick[] = [
    {
      label: '$(check) 套用推荐配置',
      description: '中文硬编码自动检测、9 条忽略正则、HTML 解析属性、语言文件名规则、评审模式、语言映射',
      value: 'yes',
      picked: true,
    },
    {
      label: '$(circle-slash) 只写基础配置',
      description: '只保留前面几步选的语言文件目录、import 语句、语言、翻译引擎',
      value: 'no',
    },
  ]
  const picked = await window.showQuickPick(picks, {
    title: '步骤 8/8 · 推荐配置',
    placeHolder: '这套配置取自 hite-cloud-ems-ui（Vue + Element Plus + 数字 key）',
    ignoreFocusOut: true,
  })
  return picked ? picked.value === 'yes' : undefined
}

export class SetupWizard {
  static async run(): Promise<void> {
    const root = await pickRoot()
    if (!root)
      return

    const localePath = await pickLocalePath(root)
    if (!localePath)
      return

    const autoImport = await askAutoImport(root)
    if (autoImport === undefined)
      return

    const language = await pickLanguage(root, localePath)
    if (!language)
      return

    const engine = await pickEngine()
    if (engine === undefined)
      return

    let baidu: { appid?: string, secret?: string } | undefined
    if (engine === 'baidu') {
      baidu = await askBaiduCreds()
      if (!baidu)
        return
    }

    const backend = await askBackend()
    if (backend === undefined)
      return

    const preset = await askPreset()
    if (preset === undefined)
      return

    const relPath = toRelative(root, localePath)
    const written: string[] = []

    try {
      await Config.updateConfig('localesPaths', [relPath], false)
      written.push(`语言文件目录 → ${relPath}`)

      await Config.updateConfig('extract.autoImportStatement', autoImport, false)
      written.push(`自动 import → ${autoImport || '（不插入）'}`)

      await Config.updateConfig('displayLanguage', language, false)
      await Config.updateConfig('sourceLanguage', language, false)
      written.push(`主语言 → ${language}`)

      if (engine) {
        await Config.updateConfig('translate.engines', [engine], false)
        written.push(`翻译引擎 → ${engine}`)
      }

      if (baidu?.appid) {
        await Config.updateConfig('translate.baidu.appid', baidu.appid, false)
        written.push('百度 APPID → 已写入工作区设置')
      }
      if (baidu?.secret) {
        await Config.updateConfig('translate.baidu.apiSecret', baidu.secret, true)
        written.push('百度密钥 → 已写入用户设置')
      }

      if (preset) {
        for (const [key, value] of Object.entries(RECOMMENDED))
          await Config.updateConfig(key, value, false)
        written.push(`推荐配置 → 已写入 ${Object.keys(RECOMMENDED).length} 项（${Object.keys(RECOMMENDED).join(', ')}）`)
      }

      await Config.updateConfig('syncBackend.enabled', backend.enabled, false)
      if (backend.enabled) {
        await Config.updateConfig('syncBackend.baseUrl', backend.baseUrl, false)
        await Config.updateConfig('syncBackend.type', backend.type, false)
        written.push(`后端同步 → ${backend.baseUrl}（type=${backend.type}）`)
      }
      else {
        written.push('后端同步 → 未启用')
      }
    }
    catch (e) {
      window.showErrorMessage(`写入配置失败：${(e as Error).message}`)
      Log.error(e)
      return
    }

    Log.info(`[setup] 初始化完成：\n  ${written.join('\n  ')}`)

    // 账号密码单独问（会弹两次输入框），放配置写完之后，失败也不影响已写入的配置
    if (backend.enabled && backend.askAuth) {
      try {
        await promptAndSaveCreds()
      }
      catch (e) {
        Log.warn(`[setup] 保存后端账号失败: ${(e as Error).message}`)
      }
    }

    const result = await window.showInformationMessage(
      `i18n 初始化完成：${relPath} / ${language}${engine ? ` / ${engine}` : ''}${backend.enabled ? ' / 已接后端' : ''}`,
      '查看设置',
      '完成',
    )
    if (result === '查看设置')
      commands.executeCommand('workbench.action.openSettings', 'i18n-ally')
  }
}

const m: ExtensionModule = () => {
  return [
    commands.registerCommand(Commands.setup_wizard, () => SetupWizard.run()),
  ]
}

const PROMPTED_KEY = 'setup-wizard.prompted'

/** 首次激活时如果连语言文件目录都没配，提示一次（只提示一次，用户可随时从命令面板重跑） */
export async function maybePromptSetup(ctx: ExtensionContext): Promise<void> {
  if (!workspace.workspaceFolders?.length)
    return
  if (Config._localesPaths?.length)
    return
  if (ctx.globalState.get<boolean>(PROMPTED_KEY))
    return

  await ctx.globalState.update(PROMPTED_KEY, true)

  const action = await window.showInformationMessage(
    'i18n Ally：这个项目还没配置语言文件位置，要现在初始化一下吗？',
    '开始配置',
    '以后再说',
  )
  if (action === '开始配置')
    await SetupWizard.run()
}

export default m
