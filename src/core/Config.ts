import path from 'path'
import { execSync } from 'child_process'
import { workspace, extensions, ExtensionContext, commands, ConfigurationScope, WorkspaceFolder } from 'vscode'
import { trimEnd, uniq } from 'lodash'
import { TagSystems } from '../tagSystems'
import { EXT_NAMESPACE, EXT_ID, EXT_LEGACY_NAMESPACE, KEY_REG_DEFAULT, KEY_REG_ALL, DEFAULT_LOCALE_COUNTRY_MAP } from '../meta'
import { KeyStyle, DirStructureAuto, SortCompare, TargetPickingStrategy } from '.'
import i18n from '~/i18n'
import { CaseStyles } from '~/utils/changeCase'
import { ExtractionBabelOptions, ExtractionHTMLOptions } from '~/extraction/parsers/options'
import { resolveRefactorTemplate } from '~/utils/resolveRefactorTemplate'
import { resolveProjectLocale } from '~/utils/projectLocale'
// 只引纯数据模块，不经过 ~/translators/index.ts，避免与引擎形成循环依赖
import type { EngineLocale } from '~/translators/locales'
import { getEngineLocales, isEngineLocaleSupported, normalizeEngineLocale, resolveEngineLocale } from '~/translators/locales'

export class Config {
  static readonly reloadConfigs = [
    'disabled',
    'localesPaths',
    'localeFiles',
    'pathMatcher',
    'includeSubfolders',
    'enabledFrameworks',
    'enabledParsers',
    'dirStructure',
    'encoding',
    'namespace',
    'defaultNamespace',
    'disablePathParsing',
    'readonly',
    'languageTagSystem',
    'ignoreFiles',
    'parserOptions',
    'parsers.extendFileExtensions',
  ]

  static readonly refreshConfigs = [
    'sourceLanguage',
    'ignoredLocales',
    'displayLanguage',
    'regex.key',
    'regex.usageMatch',
    'regex.usageMatchAppend',
  ]

  static readonly usageRefreshConfigs = [
    'keysInUse',
    'derivedKeyRules',
  ]

  static ctx: ExtensionContext

  static get root() {
    return workspace.rootPath!
  }

  static get disabled() {
    return Config.getConfig<boolean>('disabled') ?? false
  }

  static get autoDetection() {
    return Config.getConfig<boolean>('autoDetection') ?? true
  }

  // languages
  static get displayLanguage(): string {
    return this.canonicalLocale(this.normalizeLocale(Config.getConfig<string>('displayLanguage') || ''))
  }

  static set displayLanguage(value) {
    this.setConfig('displayLanguage', value, true)
  }

  static get sourceLanguage(): string {
    return this.canonicalLocale(this.normalizeLocale(this.getConfig<string>('sourceLanguage') || '', '') || this.displayLanguage || 'en')
  }

  static set sourceLanguage(value) {
    this.setConfig('sourceLanguage', this.normalizeLocale(value))
  }

  /**
   * 把配置的源语言对齐到项目里真实存在的语言文件。
   * 设置里通常是全局的 `zh-cn`，而各项目的简体中文文件可能叫 `chs.json`，
   * 直接用配置值去 node.locales 取原文会一条都取不到。
   * 调用方把 loader.locales 传进来（为空则原样返回，不做猜测）。
   */
  static alignToProject(locales?: string[] | null): string {
    return this.alignLocale(this.sourceLanguage, locales, [this.displayLanguage])
  }

  /** 把任意语言标识对齐到项目里真实存在的语言文件；locales 为空时原样返回 */
  static alignLocale(locale: string, locales?: string[] | null, prefer: string[] = []): string {
    const list = locales || []
    if (!list.length || !locale)
      return locale
    return resolveProjectLocale(locale, list, prefer).locale
  }

  static get tagSystem() {
    const tag = this.getConfig('languageTagSystem') || 'bcp47'
    return TagSystems[tag]
  }

  static normalizeLocale(locale: string, fallback?: string, strict?: boolean) {
    return this.tagSystem.normalize(locale, fallback, strict)
  }

  /**
   * locale 标识的大小写不敏感比较：`zh-cn` 与 `zh-CN` 视为同一个。
   * 文件名通常是小写（zh-cn.json），而设置里常写成 zh-CN，直接 `===` 会认成两个语言，
   * 表现为「明明有语言文件却提示输入文件路径」。
   */
  static isSameLocale(a?: string | null, b?: string | null): boolean {
    if (!a || !b)
      return false
    return a.toLowerCase() === b.toLowerCase()
  }

  /**
   * 把 locale 规范成「语言小写、地区大写、文字首字母大写」：`zh-cn` → `zh-CN`，`zh-hans-cn` → `zh-Hans-CN`。
   * `bcp-47` 的 normalize 不会改大小写，导致文件名解析出来的 `zh-cn` 与配置里的 `zh-CN` 对不上，
   * 而 `Node.locales` 是按 locale 字符串直接索引的，对不上就取不到值。统一走这里。
   */
  static canonicalLocale(locale: string): string {
    if (!locale)
      return locale
    return locale
      .split(/[-_]/)
      .map((part, index) => {
        if (index === 0)
          return part.toLowerCase()
        if (part.length === 4)
          return part[0].toUpperCase() + part.slice(1).toLowerCase()
        if (part.length === 2 || /^\d{3}$/.test(part))
          return part.toUpperCase()
        return part.toLowerCase()
      })
      .join('-')
  }

  static getBCP47(locale: string) {
    return this.tagSystem.toBCP47(this.tagSystem.normalize(locale))
  }

  static get ignoredLocales(): string[] {
    const ignored = this.getConfig('ignoredLocales')
    if (!ignored)
      return []
    if (ignored && typeof ignored === 'string')
      return [ignored]
    if (Array.isArray(ignored))
      return ignored
    return []
  }

  static set ignoredLocales(value) {
    this.setConfig('ignoredLocales', value, true)
  }

  /**
   * 显式的语言文件白名单（相对工作区根目录）。留空时按 pathMatcher 自动识别。
   * {locale} 会被编译成宽松的 [\w-_]+，把 commWord.json 这类同目录数据文件也吃进来，
   * 白名单让使用者逐个勾选「哪些才是语言文件」，loader 只加载列出的文件。
   */
  static get localeFiles(): string[] {
    const value = this.getConfig<string[] | string>('localeFiles')
    const list = typeof value === 'string'
      ? [value]
      : Array.isArray(value) ? value : []
    return list
      .map(i => String(i).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(Boolean)
  }

  /** 白名单未配置时一律放行，配置后按「相对工作区根的路径」精确匹配（大小写不敏感） */
  static isExplicitLocaleFile(rootpath: string, filepath: string): boolean {
    const allowed = this.localeFiles.map(i => i.toLowerCase())
    if (!allowed.length)
      return true
    const relative = path.relative(rootpath, filepath).replace(/\\/g, '/').toLowerCase()
    return allowed.includes(relative)
  }

  static get _keyStyle(): KeyStyle {
    const style = this.getConfig<KeyStyle>('keystyle') || 'auto'
    if (style === 'auto' && this.disablePathParsing)
      return 'flat'
    return style
  }

  static set _keyStyle(value: KeyStyle) {
    this.setConfig('keystyle', value, false)
  }

  static get annotations(): boolean {
    return this.getConfig<boolean>('annotations') ?? true
  }

  static set annotations(value: boolean) {
    this.setConfig('annotations', value, true)
  }

  static get annotationMaxLength(): number {
    return this.getConfig<number>('annotationMaxLength') || 40
  }

  static set annotationMaxLength(value: number) {
    this.setConfig('annotationMaxLength', value, true)
  }

  static get annotationDelimiter(): string {
    return this.getConfig<string>('annotationDelimiter') || ''
  }

  static get annotationInPlace(): boolean {
    return this.getConfig<boolean>('annotationInPlace') ?? true
  }

  static get namespace(): boolean | undefined {
    return this.getConfig<boolean>('namespace')
  }

  static get defaultNamespace(): string | undefined {
    return this.getConfig<string>('defaultNamespace')
  }

  static get enabledFrameworks(): string[] | undefined {
    let ids = this.getConfig<string | string[]>('enabledFrameworks')
    if (!ids || !ids.length)
      return undefined
    if (typeof ids === 'string')
      ids = [ids]
    return ids
  }

  static get enabledParsers(): string[] | undefined {
    let ids = this.getConfig<string | string[]>('enabledParsers')
    if (!ids || !ids.length)
      return undefined
    if (typeof ids === 'string')
      ids = [ids]
    return ids
  }

  static get _dirStructure(): DirStructureAuto {
    return (this.getConfig('dirStructure')) as (DirStructureAuto) || 'auto'
  }

  static set _dirStructure(value: DirStructureAuto) {
    this.setConfig('dirStructure', value, true)
  }

  static get sortKeys(): boolean {
    return this.getConfig<boolean>('sortKeys') || false
  }

  static get sortCompare(): SortCompare {
    return this.getConfig<SortCompare>('sortCompare') || 'binary'
  }

  static get sortLocale(): string | undefined {
    return this.getConfig<string>('sortLocale')
  }

  static get readonly(): boolean {
    return this.getConfig<boolean>('readonly') || false
  }

  static get includeSubfolders(): boolean {
    return this.getConfig<boolean>('includeSubfolders') || false
  }

  static get fullReloadOnChanged(): boolean {
    return this.getConfig<boolean>('fullReloadOnChanged') || false
  }

  static get preferredDelimiter(): string {
    return this.getConfig<string>('preferredDelimiter') || '-'
  }

  static get _pathMatcher(): string | undefined {
    return this.getConfig('pathMatcher')
  }

  static get regexKey(): string {
    return this.getConfig('regex.key')
      || this.getConfig('keyMatchRegex') // back compatible, deprecated.
      || (Config.disablePathParsing ? KEY_REG_ALL : KEY_REG_DEFAULT)
  }

  static get _regexUsageMatch(): string[] | undefined {
    const config = this.getConfig<string[]>('regex.usageMatch')
    if (config && config.length)
      return config
  }

  static get _regexUsageMatchAppend(): string[] {
    return this.getConfig<string[]>('regex.usageMatchAppend') || []
  }

  static get keepFulfilled(): boolean {
    return this.getConfig<boolean>('keepFulfilled') || false
  }

  static get translateFallbackToKey(): boolean {
    return this.getConfig<boolean>('translate.fallbackToKey') || false
  }

  static get translateSaveAsCandidates(): boolean {
    return this.getConfig<boolean>('translate.saveAsCandidates') || false
  }

  /** 源语言该 key 没文案时，允许拿其它语言文件里已有的文案当翻译原文 */
  static get translateFallbackFromOtherLocales(): boolean {
    return this.getConfig<boolean>('translate.fallbackFromOtherLocales') ?? true
  }

  /** 交叉引用的原文语言优先级；留空按项目语言列表顺序 */
  static get translateFallbackSourceOrder(): string[] {
    const order = this.getConfig<string[]>('translate.fallbackSourceOrder')
    return Array.isArray(order) ? order.filter(i => typeof i === 'string' && i.trim()) : []
  }

  /** 提取完成后自动把新词条翻译到其它语言（复用 translate.engines 的引擎配置） */
  static get translateOnExtract(): boolean {
    return this.getConfig<boolean>('translate.onExtract') ?? false
  }

  static get frameworksRubyRailsScopeRoot(): string {
    return this.getConfig<string>('frameworks.ruby-rails.scopeRoot') || ''
  }

  static get parsersTypescriptTsNodePath(): string {
    const config = this.getConfig<string>('parsers.typescript.tsNodePath')!
    if (config === 'ts-node')
      return config

    return `node "${path.resolve(this.extensionPath!, config)}"`
  }

  static get parsersTypescriptCompilerOption(): any {
    return this.getConfig<any>('parsers.typescript.compilerOptions') || {}
  }

  static get parsersExtendFileExtensions(): any {
    return this.getConfig<any>('parsers.extendFileExtensions') || {}
  }

  static toggleLocaleVisibility(locale: string, visible?: boolean) {
    const ignored = this.ignoredLocales
    if (visible == null)
      visible = !ignored.includes(locale)
    if (!visible) {
      ignored.push(locale)
      this.ignoredLocales = ignored
    }
    else {
      this.ignoredLocales = ignored.filter(i => i !== locale)
    }
  }

  // locales
  static get _localesPaths(): string[] | undefined {
    const paths = this.getConfig('localesPaths')
    let localesPaths: string[]
    if (!paths)
      return
    else if (typeof paths === 'string')
      localesPaths = paths.split(',')
    else
      localesPaths = paths
    if (!localesPaths)
      return
    return localesPaths.map(i => trimEnd(i, '/\\').replace(/\\/g, '/'))
  }

  static set _localesPaths(paths: string[] | undefined) {
    this.setConfig('localesPaths', paths)
  }

  static getLocalesPathsInScope(scope: WorkspaceFolder): string[] | undefined {
    const paths = this.getConfig('localesPaths', scope)

    let localesPaths: string[]
    if (!paths)
      return
    else if (typeof paths === 'string')
      localesPaths = paths.split(',')
    else
      localesPaths = paths
    if (!localesPaths)
      return
    return localesPaths.map(i => trimEnd(i, '/\\').replace(/\\/g, '/'))
  }

  static updateLocalesPaths(paths: string[]) {
    this._localesPaths = uniq((this._localesPaths || []).concat(paths))
  }

  static get themeAnnotation(): string {
    return this.getConfig<string>('theme.annotation')!
  }

  static get themeAnnotationMissing(): string {
    return this.getConfig<string>('theme.annotationMissing')!
  }

  static get themeAnnotationBorder(): string {
    return this.getConfig<string>('theme.annotationBorder')!
  }

  static get themeAnnotationMissingBorder(): string {
    return this.getConfig<string>('theme.annotationMissingBorder')!
  }

  static get extension() {
    return extensions.getExtension(EXT_ID)
  }

  static get extensionPath() {
    return this.ctx.extensionPath
  }

  static get encoding() {
    return this.getConfig<string>('encoding') || 'utf-8'
  }

  static get indent() {
    return this.getConfig<number>('indent') ?? 2
  }

  static get tabStyle() {
    return this.getConfig<string>('tabStyle') === 'tab' ? '\t' : ' '
  }

  static get translatePromptSource() {
    return this.getConfig<boolean>('translate.promptSource') ?? false
  }

  static get translateParallels() {
    return this.getConfig<number>('translate.parallels') || 5
  }

  static get translateEngines() {
    return this.getConfig<string[]>('translate.engines') || ['google']
  }

  // #region 翻译语言映射：项目语言文件 ↔ 引擎 API 语言码

  /**
   * 显式绑定的原始配置。支持两种写法，可混用：
   *   { "chs": "zh", "can": "cht" }                    // 对所有引擎生效
   *   { "baidu": { "chs": "zh" }, "google": { ... } }  // 只对指定引擎生效（优先级更高）
   */
  static get translateLocaleMapRaw(): Record<string, any> {
    return this.getConfig<Record<string, any>>('translate.localeMap') || {}
  }

  /** 取出对某个引擎生效的映射，key 统一成小写、下划线转连字符 */
  static getTranslateLocaleMap(engine: string): Record<string, string> {
    const raw = this.translateLocaleMapRaw
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string')
        result[normalizeEngineLocale(key)] = value
    }
    const scoped = raw[engine]
    if (scoped && typeof scoped === 'object' && !Array.isArray(scoped)) {
      for (const [key, value] of Object.entries(scoped)) {
        if (typeof value === 'string')
          result[normalizeEngineLocale(key)] = value
      }
    }
    return result
  }

  /**
   * 把项目里的 locale（通常就是语言文件名）解析成翻译 API 的语言码。
   * 优先级：显式配置 > 引擎声明的别名表。解析不了返回 undefined。
   */
  static resolveTranslateLocale(engine: string, locale?: string): string | undefined {
    if (!locale)
      return undefined
    const explicit = this.getTranslateLocaleMap(engine)[normalizeEngineLocale(locale)]
    if (explicit)
      return explicit
    return resolveEngineLocale(engine, locale)
  }

  /** 该引擎声明的可用语言清单（供配置界面展示） */
  static getTranslateEngineLocales(engine: string): EngineLocale[] {
    return getEngineLocales(engine)
  }

  /**
   * 翻译前校验：引擎没声明清单时不拦截（保持旧行为）；
   * 显式绑定过的语言一律放行（允许使用清单外的新语种）。
   */
  static isTranslateLocaleSupported(engine: string, locale: string, asSource = false): boolean {
    if (!getEngineLocales(engine).length)
      return true
    if (this.getTranslateLocaleMap(engine)[normalizeEngineLocale(locale)])
      return true
    const resolved = this.resolveTranslateLocale(engine, locale)
    return !!resolved && isEngineLocaleSupported(engine, resolved, asSource)
  }

  /** 配置界面用：某个项目语言的绑定状态 */
  static getTranslateLocaleStatus(engine: string, locale: string) {
    const explicit = this.getTranslateLocaleMap(engine)[normalizeEngineLocale(locale)]
    const resolved = this.resolveTranslateLocale(engine, locale)
    return {
      explicit,
      resolved,
      supported: this.isTranslateLocaleSupported(engine, locale),
      // 'explicit' | 'alias' | 'unresolved'
      source: explicit ? 'explicit' : resolved ? 'alias' : 'unresolved',
    }
  }

  // #endregion

  static get refactorTemplates() {
    return resolveRefactorTemplate(this.getConfig<string[]>('refactor.templates') || [])
  }

  static get disablePathParsing() {
    return this.getConfig<boolean>('disablePathParsing') ?? false
  }

  static get ignoreFiles() {
    return this.getConfig<string[]>('ignoreFiles') ?? []
  }

  static get keysInUse() {
    return this.getConfig<string[]>('keysInUse') || []
  }

  static set keysInUse(value) {
    this.setConfig('keysInUse', value)
  }

  static get usageDerivedKeyRules() {
    return this.getConfig<string[]>('usage.derivedKeyRules')
    ?? this.getConfig<string[]>('derivedKeyRules') // back compatible, deprecated.
    ?? undefined
  }

  static get usageScanningIgnore() {
    return this.getConfig<string[]>('usage.scanningIgnore') || []
  }

  static get preferEditor() {
    return this.getConfig<boolean>('editor.preferEditor') || false
  }

  static get reviewEnabled() {
    return this.getConfig<boolean>('review.enabled') ?? true
  }

  static get reviewGutters() {
    return this.getConfig<boolean>('review.gutters') ?? true
  }

  private static _reviewUserName: string | undefined
  static get reviewUserName() {
    const config = this.getConfig<string>('review.user.name')
    if (config)
      return config
    if (!Config._reviewUserName) {
      try {
        Config._reviewUserName = execSync('git config user.name').toString().trim()
      }
      catch (e) {
        return i18n.t('review.unknown_user')
      }
    }

    return Config._reviewUserName
  }

  private static _reviewUserEmail: string | undefined

  static get reviewUserEmail() {
    const config = this.getConfig<string>('review.user.email')
    if (config)
      return config
    if (!Config._reviewUserEmail) {
      try {
        Config._reviewUserEmail = execSync('git config user.email').toString().trim()
      }
      catch (e) {
        return ''
      }
    }

    return Config._reviewUserEmail
  }

  static get reviewUser() {
    return {
      name: Config.reviewUserName,
      email: Config.reviewUserEmail,
    }
  }

  static get reviewRemoveCommentOnResolved() {
    return this.getConfig<boolean>('review.removeCommentOnResolved') ?? false
  }

  static get translateOverrideExisting() {
    return this.getConfig<boolean>('translate.overrideExisting') ?? false
  }

  static get keygenStrategy() {
    return this.getConfig<string>('extract.keygenStrategy') ?? 'slug'
  }

  static get keygenStyle(): CaseStyles {
    return this.getConfig<CaseStyles>('extract.keygenStyle') ?? 'default'
  }

  static get keyPrefix() {
    return this.getConfig<string>('extract.keyPrefix') ?? ''
  }

  static get extractKeyMaxLength() {
    return this.getConfig<number>('extract.keyMaxLength') ?? Infinity
  }

  /**
   * 提取后若脚本文件里用到了 $t 却没有导入，自动插入这条 import。
   * 为空表示不处理；仅对 ts/js/tsx/jsx 生效（.vue 里 $t 属于模板作用域，不在此处理）。
   */
  static get extractAutoImportStatement(): string {
    return (this.getConfig<string>('extract.autoImportStatement') ?? '').trim()
  }

  /** 提取后把本页面用到的 key 同步到后端（等价于管理页的「新增前端」） */
  static get syncBackend() {
    return {
      enabled: this.getConfig<boolean>('syncBackend.enabled') ?? false,
      baseUrl: (this.getConfig<string>('syncBackend.baseUrl') ?? '').trim(),
      type: (this.getConfig<string>('syncBackend.type') ?? '5').trim(),
      tokenHeader: (this.getConfig<string>('syncBackend.tokenHeader') ?? 'Authorization').trim(),
      token: (this.getConfig<string>('syncBackend.token') ?? '').trim(),
      syncEndpoint: (this.getConfig<string>('syncBackend.syncEndpoint') ?? 'http://localhost:9006/locales-sync').trim(),
      translateAfterSync: this.getConfig<boolean>('syncBackend.translateAfterSync') ?? true,
    }
  }

  static get extractAutoDetect() {
    return this.getConfig<boolean>('extract.autoDetect') ?? false
  }

  static set extractAutoDetect(v: boolean) {
    this.setConfig('extract.autoDetect', v, false)
    commands.executeCommand('setContext', 'i18n-ally.extract.autoDetect', v)
  }

  static get extractParserHTMLOptions() {
    return this.getConfig<ExtractionHTMLOptions>('extract.parsers.html') ?? {}
  }

  static get extractParserBabelOptions() {
    return this.getConfig<ExtractionBabelOptions>('extract.parsers.babel') ?? {}
  }

  static get extractIgnored() {
    return this.getConfig<string[]>('extract.ignored') ?? []
  }

  static set extractIgnored(v) {
    this.setConfig('extract.ignored', v)
  }

  static get extractIgnoredRegex() {
    return this.getConfig<string[]>('extract.ignoredRegex') ?? []
  }

  static set extractIgnoredRegex(v) {
    this.setConfig('extract.ignoredRegex', v)
  }

  static get extractIgnoredByFiles() {
    return this.getConfig<Record<string, string[]>>('extract.ignoredByFiles') ?? {}
  }

  static set extractIgnoredByFiles(v) {
    this.setConfig('extract.ignoredByFiles', v)
  }

  static get showFlags() {
    return this.getConfig<boolean>('showFlags') ?? true
  }

  static get parserOptions() {
    return this.getConfig<any>('parserOptions') ?? {}
  }

  static get localeCountryMap() {
    return Object.assign(
      DEFAULT_LOCALE_COUNTRY_MAP,
      this.getConfig<Record<string, string>>('localeCountryMap'),
    )
  }

  static get targetPickingStrategy(): TargetPickingStrategy {
    return this.getConfig<TargetPickingStrategy | undefined>('extract.targetPickingStrategy')
      ?? TargetPickingStrategy.None
  }

  // config
  private static getConfig<T = any>(key: string, scope?: ConfigurationScope | undefined): T | undefined {
    let config = workspace
      .getConfiguration(EXT_NAMESPACE, scope)
      .get<T>(key)

    // compatible to vue-i18n-ally
    if (config === undefined) {
      config = workspace
        .getConfiguration(EXT_LEGACY_NAMESPACE)
        .get<T>(key)
    }

    return config
  }

  private static async setConfig(key: string, value: any, isGlobal = false) {
    // transfer legacy config
    if (workspace
      .getConfiguration(EXT_LEGACY_NAMESPACE)
      .get<any>(key)
    ) {
      await workspace.getConfiguration(EXT_LEGACY_NAMESPACE)
        .update(key, undefined, isGlobal)
    }

    // update value
    return await workspace
      .getConfiguration(EXT_NAMESPACE)
      .update(key, value, isGlobal)
  }

  /**
   * 写入忽略规则并等待落盘。
   * `setConfig` 内部是 `await workspace.getConfiguration().update()`，
   * 而 getter 每次走 `workspace.getConfiguration().get()` 实时读；
   * 若赋值后立刻读，拿到的仍是旧值。需要「写规则 → 立刻重新检测」的场景必须用这两个方法。
   */
  static async updateExtractIgnored(value: string[]): Promise<void> {
    await this.setConfig('extract.ignored', value)
  }

  static async updateExtractIgnoredByFiles(value: Record<string, string[]>): Promise<void> {
    await this.setConfig('extract.ignoredByFiles', value)
  }

  /**
   * 通用写入入口：await 落盘后返回。
   * 引导流程要连着写多项配置再读，必须走这个而不是直接赋值 setter。
   */
  static async updateConfig(key: string, value: any, isGlobal = false): Promise<void> {
    await this.setConfig(key, value, isGlobal)
  }

  static get baiduApiSecret() {
    return this.getConfig<string | null | undefined>('translate.baidu.apiSecret')
  }

  static get baiduAppid() {
    return this.getConfig<string | null | undefined>('translate.baidu.appid')
  }

  static get googleApiKey() {
    return this.getConfig<string | null | undefined>('translate.google.apiKey')
  }

  static get deeplApiKey() {
    return this.getConfig<string | null | undefined>('translate.deepl.apiKey')
  }

  static get deeplUseFreeApiEntry() {
    return this.getConfig<boolean>('translate.deepl.useFreeApiEntry')
  }

  static get deeplLog(): boolean {
    return !!this.getConfig('translate.deepl.enableLog')
  }

  static get libreTranslateApiRoot() {
    return this.getConfig<string | null | undefined>('translate.libre.apiRoot')
  }

  static get openaiApiKey() {
    return this.getConfig<string | null | undefined>('translate.openai.apiKey')
  }

  static get openaiApiRoot() {
    return this.getConfig<string | null | undefined>('translate.openai.apiRoot')
  }

  static get openaiApiModel() {
    return this.getConfig<string>('translate.openai.apiModel') ?? 'gpt-3.5-turbo'
  }

  static get telemetry(): boolean {
    return workspace.getConfiguration().get('telemetry.enableTelemetry') as boolean
  }
}
