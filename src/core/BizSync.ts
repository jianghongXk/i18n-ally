import axios from 'axios'
import { TextDocument, Uri, WorkspaceEdit, window, workspace } from 'vscode'
import { Analyst, Config, CurrentFile, KeyDetector, LocaleLoader } from '~/core'
import { Log } from '~/utils'
import { runLocaleSync } from './SyncScript'
import { decryptField, encryptEcb, encryptField } from '~/utils/aesEcb'

const KEY_RE = /\$t\(\s*['"]([^'"]+)['"]/g
const CONCURRENCY = 3
const TIMEOUT = 10_000
const LOCAL_STATE = ['.vscePackage', '.dev-state.json']
const AUTH_KEY = 'backendAuth'
const LEGACY_AUTH_KEY = '__backendAuth'

interface Auth {
  header: string
  token: string
  expiresAt?: number
}

const authHeaders = (auth: Auth): Record<string, string> =>
  auth.token ? { [auth.header || 'Authorization']: auth.token } : {}

interface SyncCfg {
  enabled: boolean
  baseUrl: string
  type: string
  tokenHeader: string
  token: string
  syncEndpoint: string
  translateAfterSync: boolean
}

interface LocalCreds {
  username?: string
  password?: string
  clientId?: string
}

let authCache: { auth: Auth, expiresAt: number } | null = null

/** 从本地状态文件读取账号密码（该文件已在 .gitignore 中，不会上传） */
async function readLocalCreds(): Promise<LocalCreds | null> {
  const root = workspace.workspaceFolders?.[0]?.uri
  if (!root)
    return null
  try {
    const uri = Uri.joinPath(root, ...LOCAL_STATE)
    const raw = await workspace.fs.readFile(uri)
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
    const creds = parsed?.[AUTH_KEY] ?? parsed?.[LEGACY_AUTH_KEY]
    if (creds?.username && creds?.password)
      return creds as LocalCreds
  }
  catch {
    // 文件不存在或格式不对都忽略
  }
  return null
}

async function login(base: string, creds: LocalCreds): Promise<Auth | null> {
  if (!creds.username || !creds.password) {
    Log.warn('[sync] 本地凭据缺少 username 或 password')
    return null
  }
  try {
    const res = await axios.post(`${base}/users/login`, {
      clientId: creds.clientId || 'pc_web',
      grantType: 'password',
      username: decryptField(creds.username),
      password: encryptField(creds.password),
    }, { timeout: TIMEOUT })

    const { ok, data, msg } = unwrap<{ accessToken?: string, tokenHeader?: string, expiresIn?: string }>(res.data)
    if (!ok || !data?.accessToken) {
      Log.warn(`[sync] 登录失败: ${msg || '未返回 accessToken'}`)
      return null
    }
    const expiresIn = Number(data.expiresIn ?? 0)
    Log.info(`[sync] 已用本地账号登录，token 有效期 ${expiresIn || '未知'} 秒`)
    return {
      header: data.tokenHeader || 'Authorization',
      token: data.accessToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    }
  }
  catch (e) {
    Log.warn(`[sync] 登录请求失败: ${(e as Error).message}`)
    return null
  }
}

/** 把（已加密的）凭据写回本地状态文件，保留其它字段 */
async function saveCreds(creds: LocalCreds): Promise<boolean> {
  const root = workspace.workspaceFolders?.[0]?.uri
  if (!root)
    return false
  try {
    const fileUri = Uri.joinPath(root, ...LOCAL_STATE)
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(Buffer.from(await workspace.fs.readFile(fileUri)).toString('utf8'))
    }
    catch {
      json = {}
    }
    json[AUTH_KEY] = creds
    delete json[LEGACY_AUTH_KEY]
    await workspace.fs.createDirectory(Uri.joinPath(root, LOCAL_STATE[0]))
    await workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(json, null, 2), 'utf8'))
    return true
  }
  catch (e) {
    Log.warn(`[sync] 保存凭据失败: ${(e as Error).message}`)
    return false
  }
}

/** 没有本地凭据时，弹输入框让用户填一次，加密后落盘 */
export async function promptAndSaveCreds(): Promise<LocalCreds | null> {
  const username = await window.showInputBox({
    title: 'i18n 后端账号',
    prompt: '登录用户名（仅保存在本地 .vscePackage/.dev-state.json，不会提交）',
    ignoreFocusOut: true,
  })
  if (!username?.trim())
    return null

  const password = await window.showInputBox({
    title: 'i18n 后端账号',
    prompt: `用户 ${username.trim()} 的密码`,
    password: true,
    ignoreFocusOut: true,
  })
  if (!password)
    return null

  const creds: LocalCreds = {
    username: `enc:${encryptEcb(username.trim())}`,
    password: `enc:${encryptEcb(password)}`,
  }

  if (await saveCreds(creds))
    window.showInformationMessage('i18n: 后端账号已加密保存到本地')

  authCache = null
  return creds
}

/** 优先用配置里的 token；没有则用本地账号密码换一个新的 */
async function resolveAuth(base: string, cfg: SyncCfg): Promise<Auth | null> {
  if (cfg.token)
    return { header: cfg.tokenHeader, token: cfg.token }

  if (authCache && (!authCache.expiresAt || authCache.expiresAt - 60_000 > Date.now()))
    return authCache.auth

  let creds = await readLocalCreds()
  if (!creds) {
    // 首次使用：让用户填一次，之后就一直用本地加密凭据
    creds = await promptAndSaveCreds()
    if (!creds)
      return null
  }

  const auth = await login(base, creds)
  if (auth)
    authCache = { auth, expiresAt: auth.expiresAt ?? Date.now() + 10 * 60_000 }
  return auth
}


interface SyncResult {
  created: number
  existed: number
  linked: number
  alreadyLinked: number
  failed: number
}

/**
 * 把本页面用到的所有 i18n key 同步到后端（等价于管理页的「新增前端」）。
 *
 * 流程与前端 i18nCode.vue 的 addStatus=1 分支一致：
 *   1. 以中文描述新增编码  POST /i18n/code { description }
 *   2. 新增失败说明已存在，用描述反查 id  GET /i18n/code/desc?desc=
 *   3. 关联业务类型        POST /i18n/type { i18nId, businessId, type }
 *
 * 一次同步以「中文描述」为单位去重：多个 key 复用同一句中文时只提交一次。
 */
export async function syncKeysToBackend(
  documents: (TextDocument | undefined)[],
  options?: { throwOnAuthError?: boolean },
): Promise<SyncResult | null> {
  const cfg = Config.syncBackend
  // 没配后端（未开启 / 未填 baseUrl）时不中断：跳过推送和全局替换脚本，直接把缺失词条翻译掉
  const canPush = cfg.enabled && !!cfg.baseUrl
  if (!canPush)
    Log.info(`[sync] 未配置后端（enabled=${cfg.enabled}, baseUrl=${cfg.baseUrl || '空'}），跳过推送，直接走翻译流程`)

  // 1) 扫描文档里所有 $t('key')
  const keys = new Set<string>()
  for (const doc of documents) {
    if (!doc)
      continue
    const text = doc.getText()
    for (const m of text.matchAll(KEY_RE))
      keys.add(m[1])
  }
  if (!keys.size)
    return null

  // 2) key -> 源语言文案（同步按文案去重）
  const loader = CurrentFile.loader
  const source = Config.sourceLanguage
  const descriptions = new Map<string, string[]>()
  for (const key of keys) {
    let value: unknown
    try {
      value = loader.getValueByKey(key, source)
    }
    catch {
      value = undefined
    }
    if (typeof value !== 'string' || !value.trim()) {
      Log.warn(`[sync] key "${key}" 在 ${source} 中无文案，跳过`)
      continue
    }
    const list = descriptions.get(value) ?? []
    list.push(key)
    descriptions.set(value, list)
  }

  if (!descriptions.size)
    return { created: 0, existed: 0, linked: 0, alreadyLinked: 0, failed: 0 }

  const base = cfg.baseUrl.replace(/\/+$/, '')
  const descs = [...descriptions.keys()]
  const result: SyncResult = { created: 0, existed: 0, linked: 0, alreadyLinked: 0, failed: 0 }
  const resolvedIds = new Map<string, string>()
  const status = canPush
    ? window.setStatusBarMessage(`$(sync~spin) i18n: 同步 ${descs.length} 条到后端…`)
    : undefined

  // —— 第一步：推送到后端（失败不影响后续回填）——
  if (canPush) {
    const auth = await resolveAuth(base, cfg)
    if (!auth) {
      Log.warn('[sync] 未取得鉴权信息，跳过推送，但仍会回填本地译文')
    }
    else {
      Log.info(`[sync] 即将同步 ${descs.length} 条词条（覆盖 ${keys.size} 个 key）到 ${base}`)
      try {
        for (let i = 0; i < descs.length; i += CONCURRENCY) {
          const chunk = descs.slice(i, i + CONCURRENCY)
          await Promise.all(chunk.map(async (desc) => {
            try {
              const id = await addCode(base, desc, auth)
              if (id)
                result.created++
              else
                result.existed++

              const finalId = id ?? await findCodeId(base, desc, auth)
              if (!finalId) {
                result.failed++
                Log.warn(`[sync] 无法获取 ${desc} 的编码 id，跳过关联`)
                return
              }

              resolvedIds.set(desc, String(finalId))

              const newlyLinked = await addType(base, finalId, cfg.type, auth)
              if (newlyLinked)
                result.linked++
              else
                result.alreadyLinked++
            }
            catch (e) {
              if (e instanceof AuthError)
                throw e
              result.failed++
              Log.warn(`[sync] ${desc} 同步失败: ${(e as Error).message}`)
            }
          }))
        }
      }
      catch (e) {
        if (e instanceof AuthError) {
          authCache = null
          Log.error(`[sync] 鉴权失败，推送中止: ${e.message}`)
          window.showWarningMessage(`i18n: 推送中止（${e.message}），已跳过推送，继续回填本地译文`)
        }
        else {
          throw e
        }
      }
    }
  }

  status?.dispose()

  // —— 第二步：把源码里的临时 key（slug / random）换成后端返回的数字 id ——
  // 提取时还没推后端，生成的是临时 key；推完不换回来，代码里就永远是随机串。
  let renamed = 0
  if (canPush && resolvedIds.size)
    renamed = await rewriteKeysToBackendIds(descriptions, resolvedIds)

  // —— 第三步：刷新本地词条（只有真的推过后端才需要）——
  // runLocaleSync 走的是 dev server 的 syncAndUpdateLocales.py，会按后端数据全量覆盖
  // 语言文件；没配后端时既没数据源也没必要跑这个全局脚本，直接跳过。
  if (canPush && descs.length)
    await runLocaleSync()

  // 第四步：把其它语言里缺失/空值的词条翻译掉（复用「翻译全部」命令）
  // 没后端时这是唯一有意义的动作，所以不受 translateAfterSync 开关约束
  if (descs.length && (canPush ? cfg.translateAfterSync : true)) {
    try {
      const { TranslateAllMissing } = await import('~/commands/manipulations/translateAllMissing')
      await TranslateAllMissing()
    }
    catch (e) {
      Log.warn(`[sync] 自动翻译失败: ${(e as Error).message}`)
    }
  }

  if (!canPush) {
    Log.info(`[sync] 未配置后端，已跳过推送与本地词条刷新，直接翻译（覆盖 ${keys.size} 个 key）`)
    window.showInformationMessage('i18n: 未配置后端地址，已跳过推送，直接翻译缺失词条')
    return result
  }

  Log.info(`[sync] 完成：新增 ${result.created}，已存在 ${result.existed}，新关联 ${result.linked}，已关联 ${result.alreadyLinked}，失败 ${result.failed}`)
  window.showInformationMessage(
    `i18n: 后端同步完成（新增 ${result.created} / 已存在 ${result.existed} / 新关联 ${result.linked} / 已关联 ${result.alreadyLinked} / 失败 ${result.failed}${renamed ? ` / key 已替换 ${renamed}` : ''}）`,
  )
  return result
}

/**
 * 把源码里的临时 key 换成后端返回的数字 id。
 *
 * 提取阶段拿不到后端 id，只能先生成 slug / random key；推完不换回来，代码里就永远是
 * 随机串，和后端的数字编码对不上，后续同步、翻译、清理全部错位。
 */
async function rewriteKeysToBackendIds(
  descriptions: Map<string, string[]>,
  resolvedIds: Map<string, string>,
): Promise<number> {
  const pairs: [string, string][] = []
  for (const [desc, id] of resolvedIds) {
    for (const key of descriptions.get(desc) ?? []) {
      if (key !== id)
        pairs.push([key, id])
    }
  }
  if (!pairs.length)
    return 0

  Log.info(`[sync] ${pairs.length} 个临时 key 需要换成后端 id`)

  let byKey: Map<string, any[]>
  try {
    // 强制重扫：刚提取完，缓存里的位置可能已经不准
    const report = await Analyst.analyzeUsage(false)
    const all = [...report.active, ...report.idle, ...report.missing]
    byKey = new Map(all.map(u => [u.keypath, u.occurrences as any[]]))
  }
  catch (e) {
    Log.warn(`[sync] 扫描 key 引用失败，跳过 key 替换: ${(e as Error).message}`)
    return 0
  }

  const edit = new WorkspaceEdit()
  let replacements = 0
  for (const [oldKey, newKey] of pairs) {
    for (const occurrence of byKey.get(oldKey) ?? []) {
      try {
        const location = await Analyst.getLocationOf(occurrence)
        edit.replace(location.uri, location.range, newKey)
        replacements++
      }
      catch {
        // 单个位置失败不影响其它
      }
    }
  }

  let renamed = 0
  if (replacements) {
    const ok = await workspace.applyEdit(edit)
    if (ok) {
      renamed = pairs.length
      Log.info(`[sync] 源码 key 已替换 ${replacements} 处`)
    }
    else {
      Log.warn('[sync] 源码 key 替换失败（applyEdit 返回 false）')
    }
  }

  // 语言文件里的词条跟着改名；放在改源码之后，避免 watcher 读到半截状态
  const localeLoaders = CurrentFile.loader.loaders
    .filter(l => l instanceof LocaleLoader) as LocaleLoader[]
  for (const [oldKey, newKey] of pairs) {
    for (const localeLoader of localeLoaders) {
      try {
        await localeLoader.renameKeyInLocales(oldKey, newKey)
      }
      catch (e) {
        Log.warn(`[sync] 语言文件改名失败 ${oldKey} -> ${newKey}: ${(e as Error).message}`)
      }
    }
  }

  KeyDetector.purgeAllCache()
  CurrentFile.invalidate()
  return renamed
}

export class AuthError extends Error {}
/** 后端统一响应包装：{ code: '0' 表示成功, msg, data } */
interface Envelope<T> {
  code?: string | number
  msg?: string
  data?: T
}

/** 拆包装：成功返回 data，业务失败或无包装时按情况返回 */
function unwrap<T>(body: unknown): { ok: boolean, data?: T, msg?: string, code?: string } {
  if (body && typeof body === 'object' && 'code' in (body as Record<string, unknown>)) {
    const env = body as Envelope<T>
    return { ok: String(env.code) === '0', data: env.data, msg: env.msg, code: String(env.code) }
  }
  // 没有包装体（例如直接返回数字）
  return { ok: true, data: body as T }
}

/** 新增编码，返回新 id；已存在或失败返回 null */
async function addCode(base: string, description: string, auth: Auth): Promise<number | null> {
  try {
    const res = await axios.post(`${base}/i18n/code`, { lang: Config.sourceLanguage, description }, { timeout: TIMEOUT, headers: authHeaders(auth) })
    const { ok, data, code, msg } = unwrap<number>(res.data)
    if (code === '401')
      throw new AuthError(msg || '登录状态已过期')
    if (!ok || typeof data !== 'number') {
      // 常见原因是描述已存在，把它记下来方便排查
      Log.info(`[sync] 新增 ${description} 未成功（code=${code ?? '-'} msg=${msg ?? '-'}），按已存在处理`)
      return null
    }
    return data
  }
  catch (e) {
    // AuthError 必须继续向上抛，否则会把登录失效当成已存在
    if (e instanceof AuthError)
      throw e
    Log.warn(`[sync] 新增 ${description} 请求失败: ${(e as Error).message}`)
    return null
  }
}

async function findCodeId(base: string, desc: string, auth: Auth): Promise<number | null> {
  try {
    const res = await axios.get(`${base}/i18n/code/desc`, { params: { desc }, timeout: TIMEOUT, headers: authHeaders(auth) })
    const { ok, data } = unwrap<{ id?: number }>(res.data)
    if (!ok || typeof data?.id !== 'number') {
      Log.warn(`[sync] 反查 "${desc}" 未拿到 id`)
      return null
    }
    return data.id
  }
  catch (e) {
    Log.warn(`[sync] 查询描述 "${desc}" 失败: ${(e as Error).message}`)
    return null
  }
}

async function addType(base: string, id: number, type: string, auth: Auth): Promise<boolean> {
  const res = await axios.post(`${base}/i18n/type`, { i18nId: id, businessId: id, type }, { timeout: TIMEOUT, headers: authHeaders(auth) })
  const { ok, msg, code } = unwrap(res.data)
  if (ok)
    return true
  // 已经关联过：幂等场景，不算失败
  if ((msg ?? '').includes('已存在'))
    return false
  throw new Error(msg || `关联失败（code=${code ?? '-'}）`)
}

/**
 * 启动时检查：开了后端同步但没有本地凭据，就直接要求输入一次。
 * 这样不用等到第一次提取才被打断。
 */
export async function ensureBackendAuthConfigured(): Promise<void> {
  const cfg = Config.syncBackend
  // 没填 baseUrl 时后端根本用不上，别在启动阶段弹账号框打断用户
  if (!cfg.enabled || !cfg.baseUrl || cfg.token)
    return
  if (await readLocalCreds())
    return
  Log.info('[sync] 尚未配置后端账号，等待用户输入')
  await promptAndSaveCreds()
}
