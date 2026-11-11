import { EventEmitter, CancellationToken, window, ProgressLocation, commands } from 'vscode'
import { AllyError, ErrorType } from './Errors'
import { PendingWrite } from './types'
import { Global } from './Global'
import { LocaleTree, LocaleNode, LocaleRecord, Config, Loader } from '.'
import { Commands } from '~/commands'
import i18n from '~/i18n'
import { Log } from '~/utils'
import { resolveProjectLocale } from '~/utils/projectLocale'
import { translator, TranslateResult } from '~/translators'

interface TranslatorChangeEvent {
  keypath: string
  locale: string
  action: 'start' | 'end'
}

export interface TranslateJob {
  loader: Loader
  locale: string
  keypath: string
  source: string
  filepath?: string
  token?: CancellationToken
}

export interface TranslateSaveOutcome {
  /** written = 真正写进语言文件；candidates = 只存进 Review 候选；skipped = 找不到目标文件没写 */
  mode: 'written' | 'candidates'
  written: number
  candidates: number
  skipped: number
  error?: string
}

export type AccaptableTranslateItem =
  | LocaleNode
  | LocaleRecord
  | {locale: string; keypath: string; type: undefined }

export class Translator {
  private static translatingKeys: {keypath: string; locale: string}[] = []
  private static _onDidChange = new EventEmitter<TranslatorChangeEvent>()
  static readonly onDidChange = Translator._onDidChange.event
  private static _translator = translator
  /** 「源语言配置与项目文件不符」的提示按 项目 + 标识 只弹一次 */
  private static _sourceAlignedNotified = new Set<string>()

  // #region utils
  /**
   * 把配置里的源语言对齐到项目里真实存在的语言文件。
   *
   * 设置里的 sourceLanguage 是全局的（用户级），项目里的语言文件却是各项目自己命名的：
   * 配了 `zh-cn`、项目里只有 `chs.json` 时，以前会一直拿 `zh-cn` 去 node.locales 找原文，
   * 一个都找不到 —— 表现为「翻译全部缺失一条都没翻」，且界面不提示原因。
   * 这里按语种语义（zh-cn / chs / cn / zh-Hans 视为同一种）落到真实文件上。
   */
  static alignSourceLanguage(loader: Loader, sourceLanguage: string): string {
    const locales = loader.locales || []
    // 语言文件还没加载完时不做判断，保持旧行为，免得误报
    if (!locales.length || !sourceLanguage)
      return sourceLanguage

    const resolved = resolveProjectLocale(sourceLanguage, locales, [Config.displayLanguage])

    // 项目里没有任何语言能和配置的源语言对上（例如项目只有 en.json，设置里写 zh-cn）
    if (resolved.kind === 'none') {
      const key = `${Global.rootpath}::${sourceLanguage}::__none__`
      if (!this._sourceAlignedNotified.has(key)) {
        this._sourceAlignedNotified.add(key)
        Log.warn(`🌎🔤 源语言「${sourceLanguage}」在当前项目里找不到对应语言文件（已加载：${locales.join('、')}）`)
        window.showWarningMessage(
          `源语言设置的是「${sourceLanguage}」，但当前项目里没有对应的语言文件（已加载：${locales.join('、')}），翻译会取不到原文。`,
          '打开本项目设置',
        ).then((choice) => {
          if (choice === '打开本项目设置')
            commands.executeCommand('i18n-ally.open-workspace-settings')
        })
      }
      return sourceLanguage
    }

    if (!resolved.changed)
      return resolved.locale

    Log.info(`🌎🔤 源语言「${resolved.configured}」在当前项目里没有同名语言文件，已自动改用「${resolved.locale}」作为源语言（${resolved.kind} 匹配）`)

    const key = `${Global.rootpath}::${resolved.configured}::${resolved.locale}`
    if (!this._sourceAlignedNotified.has(key)) {
      this._sourceAlignedNotified.add(key)
      const setButton = `把源语言设为 ${resolved.locale}`
      window.showWarningMessage(
        `源语言设置的是「${resolved.configured}」，但当前项目里没有这个语言文件；本次已自动改用「${resolved.locale}」取原文。把它写进本项目设置后就不会再提示。`,
        setButton,
        '打开本项目设置',
      ).then((choice) => {
        if (choice === setButton) {
          Config.updateConfig('sourceLanguage', resolved.locale, false)
          window.showInformationMessage(`已把本项目的源语言设为 ${resolved.locale}`)
        }
        else if (choice === '打开本项目设置') {
          commands.executeCommand('i18n-ally.open-workspace-settings')
        }
      })
    }

    return resolved.locale
  }

  private static start(keypath: string, locale: string, update = true) {
    this.end(keypath, locale, false)
    this.translatingKeys.push({ keypath, locale })
    if (update)
      this._onDidChange.fire({ keypath, locale, action: 'start' })
  }

  private static end(keypath: string, locale: string, update = true) {
    this.translatingKeys = this.translatingKeys.filter(i => !(i.keypath === keypath && i.locale === locale))
    if (update)
      this._onDidChange.fire({ keypath, locale, action: 'end' })
  }

  static isTranslating(node: LocaleNode| LocaleRecord | LocaleTree) {
    if (node.type === 'record')
      return !!this.translatingKeys.find(i => i.keypath === node.keypath && i.locale === node.locale)
    if (node.type === 'node')
      return !!this.translatingKeys.find(i => i.keypath === node.keypath)
    if (node.type === 'tree')
      return !!this.translatingKeys.find(i => i.keypath.startsWith(node.keypath))
    return false
  }

  /** node.locales 的键来自文件名解析，与设置里的 sourceLanguage 可能大小写不同 */
  private static localeKeyOf(node: LocaleNode | undefined, locale: string): string | undefined {
    if (!node)
      return undefined
    return Object.keys(node.locales).find(l => Config.isSameLocale(l, locale))
  }

  private static valueOfLocale(node: LocaleNode | undefined, locale: string): string {
    const key = this.localeKeyOf(node, locale)
    const value = key ? node?.locales[key]?.value : undefined
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * 决定这条翻译任务拿哪种语言的文案当原文。
   *
   * 正常路径用配置的源语言；但源语言文件在该 key 上为空/缺失时（例如 chs.json
   * 没有 CustomDateDetails.form.Org，而 can.json / en.json 有），只要其它语言
   * 有值就交叉引用其中一种作为 from，把译文反向写回源语言。
   *
   * 返回 node.locales 里的精确键，保证 getValueOfKey 一定能取到原文。
   */
  private static resolveSourceLocaleFor(
    loader: Loader,
    keypath: string,
    sourceLanguage: string,
    targetLocale: string,
  ): string | undefined {
    const node = loader.getNodeByKey(keypath) || undefined

    if (this.valueOfLocale(node, sourceLanguage) && !Config.isSameLocale(sourceLanguage, targetLocale))
      return this.localeKeyOf(node, sourceLanguage)

    if (!Config.translateFallbackFromOtherLocales)
      return undefined

    const ignored = Config.ignoredLocales
    // 配置里的优先级排前面，项目语言列表兜底；永远不拿目标语言自己当原文
    const order = [...Config.translateFallbackSourceOrder, ...Global.allLocales]
    const seen = new Set<string>()
    for (const locale of order) {
      if (Config.isSameLocale(locale, targetLocale))
        continue
      if (ignored.some(i => Config.isSameLocale(i, locale)))
        continue
      const key = this.localeKeyOf(node, locale)
      if (!key || seen.has(key.toLowerCase()))
        continue
      seen.add(key.toLowerCase())
      if (this.valueOfLocale(node, locale))
        return key
    }
    return undefined
  }

  private static getValueOfKey(loader: Loader, keypath: string, from: string) {
    const sourceNode = loader.getNodeByKey(keypath)
    if (!sourceNode) {
      if (Config.translateFallbackToKey)
        return keypath
      return ''
    }

    const key = this.localeKeyOf(sourceNode, from)
    const sourceRecord = key ? sourceNode.locales[key] : undefined
    if (!sourceRecord || !sourceRecord.value) {
      if (Config.translateFallbackToKey)
        return keypath
      return ''
    }

    return sourceRecord.value
  }

  /**
   * 把项目 locale 转换成翻译引擎的 API 语言码。
   * 例如 chs → zh、can → cht（百度）；没有声明清单的引擎原样透传。
   */
  private static resolveEngineLocales(engine: string, from: string, to: string) {
    return {
      from: Config.resolveTranslateLocale(engine, from) || from,
      to: Config.resolveTranslateLocale(engine, to) || to,
    }
  }

  private static unsupportedLocaleError(engine: string, locale: string) {
    return new Error(
      `[${engine}] 语言「${locale}」没有对应的翻译语言码，请运行「配置翻译语言映射」把该语言文件绑定到引擎支持的语言`,
    )
  }
  // #endregion

  static async translateNodes(
    loader: Loader,
    nodes: AccaptableTranslateItem[],
    sourceLanguage: string,
    targetLocales?: string[],
    options?: { skipConfirm?: boolean },
  ): Promise<TranslateSaveOutcome | undefined> {
    if (!nodes.length)
      return undefined

    // 配置的源语言可能和项目里的语言文件名对不上（zh-cn vs chs.json），
    // 这里统一换成项目里真实存在的那个，否则一条原文都取不到。
    sourceLanguage = this.alignSourceLanguage(loader, sourceLanguage)

    const jobs = this.getTranslateJobs(loader, nodes, sourceLanguage, targetLocales)

    if (!jobs.length) {
      window.showInformationMessage(
        i18n.t('prompt.translate_no_jobs'),
      )
      return undefined
    }

    if (jobs.length > 1 && !options?.skipConfirm) {
      const Yes = i18n.t('prompt.button_yes')
      const result = await window.showWarningMessage(
        i18n.t('prompt.translate_multiple_confirm', jobs.length),
        { modal: true },
        Yes,
      )
      if (result !== Yes)
        return undefined
    }

    // 必须 await：否则调用方（同步后端 / 翻译全部缺失）会以为翻译已结束，
    // 提前弹出「完成」，而实际写盘还在后台跑，表现为「提示成功但没译文」。
    return await window.withProgress({
      location: ProgressLocation.Notification,
      title: i18n.t('prompt.translate_in_progress'),
      cancellable: true,
    },
    async(progress, token) => {
      jobs.forEach(job => job.token = token)

      const successJobs: TranslateJob[] = []
      const failedJobs: [TranslateJob, Error][] = []
      const cancelledJobs: TranslateJob[] = []
      let finished = 0
      const total = jobs.length

      const increment = 1 / total * 100

      const allResults: ({result: PendingWrite | undefined; job: TranslateJob})[] = []

      const batchSize = 40
      const totalBatches = Math.ceil(jobs.length / batchSize)

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        if (token?.isCancellationRequested)
          break

        const batchJobs = jobs.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize)

        // 同一个目标语言的原文可能来自不同语言（有的用源语言、有的交叉引用 can/en），
        // 必须按「目标语言 + 原文语言」分组，否则整组会拿第一个 job 的 from 去翻
        const jobsByGroup: Record<string, TranslateJob[]> = {}
        for (const job of batchJobs) {
          const group = `${job.locale}::${job.source}`
          if (!jobsByGroup[group])
            jobsByGroup[group] = []
          jobsByGroup[group].push(job)
        }

        for (const [, localeJobs] of Object.entries(jobsByGroup)) {
          const locale = localeJobs[0].locale
          const source = localeJobs[0].source
          const texts = localeJobs.map(job => this.getValueOfKey(job.loader, job.keypath, job.source))

          const message = `Batch ${batchIdx + 1}/${totalBatches} (${locale}) ${finished + 1}/${total}`
          progress.report({ increment: 0, message })

          const results = await this.translateTexts(texts, source, locale)

          for (let i = 0; i < localeJobs.length; i++) {
            if (token?.isCancellationRequested)
              break

            const job = localeJobs[i]
            const result = results[i]

            const jobMessage = `"${job.keypath}" (${job.source}->${job.locale}) ${finished + 1}/${total}`
            progress.report({ increment: 0, message: jobMessage })

            try {
              if (result instanceof Error)
                throw result

              if (!result) {
                cancelledJobs.push(job)
              }
              else {
                const pending: PendingWrite = {
                  locale: job.locale,
                  value: result,
                  filepath: job.filepath,
                  keypath: job.keypath,
                }
                allResults.push({ result: pending, job })
                successJobs.push(job)
              }
            }
            catch (err) {
              console.error(err)
              failedJobs.push([job, err])
            }
            finished += 1
            progress.report({ increment, message: jobMessage })
          }
        }
      }

      const successfulResults = allResults.filter(i => i.result)
      let outcome: TranslateSaveOutcome = { mode: 'written', written: 0, candidates: 0, skipped: 0 }
      if (successfulResults.length > 0) {
        try {
          outcome = await this.saveTranslations(loader, successfulResults)
        }
        catch (err) {
          console.error('Failed to save translations', err)
          Log.error(err as Error, false)
          outcome = { ...outcome, error: (err as Error).message }
          window.showErrorMessage(i18n.t('prompt.translate_save_failed'))
        }
      }

      // translating done —— 提示必须反映「译文到底有没有落盘」，
      // 不能再只看 successJobs（引擎返回了字符串就算成功）。
      const translated = successJobs.length
      const fallbackCount = successJobs.filter(j => !Config.isSameLocale(j.source, sourceLanguage)).length
      const fallbackText = fallbackCount
        ? `（其中 ${fallbackCount} 条源语言缺失，已交叉引用其它语言作为原文）`
        : ''
      if (translated > 0) {
        if (outcome.error) {
          window.showWarningMessage(
            `已翻译 ${translated} 条，但写入语言文件失败：${outcome.error}`,
          )
        }
        else if (outcome.mode === 'candidates') {
          const writeNow = '直接写入语言文件'
          const writeAlways = '以后都直接写入'
          window.showWarningMessage(
            `已生成 ${outcome.candidates} 条翻译候选，未写入语言文件：本项目开启了「翻译结果存为候选」，译文现在只存在 .vscode/i18n-ally-reviews.yml，需要到 Review 面板逐条确认。${fallbackText}`,
            writeNow,
            writeAlways,
          ).then(async(choice) => {
            if (choice !== writeNow && choice !== writeAlways)
              return
            if (choice === writeAlways)
              await Config.updateConfig('translate.saveAsCandidates', false, false)
            try {
              const written = await Global.reviews.applyTranslationCandidates(
                successfulResults.map(i => ({ keypath: i.job.keypath, locale: i.job.locale })),
              )
              window.showInformationMessage(`已把 ${written} 条译文写入语言文件`)
            }
            catch (e) {
              window.showErrorMessage(`写入语言文件失败：${(e as Error).message}`)
            }
          })
        }
        else if (outcome.skipped > 0) {
          window.showWarningMessage(
            `已翻译 ${translated} 条，写入 ${outcome.written} 条；${outcome.skipped} 条没写进去（找不到目标语言文件或处于只读模式，详见 i18n CN 日志）`,
          )
        }
        else if (translated === 1) {
          (async() => {
            const job = successJobs[0]
            const editButton = i18n.t('prompt.translate_edit_translated')
            const result = await window.showInformationMessage(
              `已翻译并写入 1 条文案：「${job.keypath}」${fallbackText}`,
              editButton,
            )
            if (result === editButton)
              commands.executeCommand(Commands.edit_key, { keypath: job.keypath, locale: job.locale })
          })()
        }
        else {
          window.showInformationMessage(`已翻译并写入 ${outcome.written} 条文案${fallbackText}`)
        }
      }

      if (failedJobs.length) {
        for (const [job, error] of failedJobs) {
          Log.info(`🌎⚠️ Failed to translate "${job.keypath}" (${job.source}->${job.locale})`)
          Log.error(error, false)
        }

        const message = failedJobs.length === 1
          ? i18n.t('prompt.translate_failed_single', failedJobs[0][0].keypath, failedJobs[0][0].locale)
          : i18n.t('prompt.translate_failed_multiple', failedJobs.length)

        Log.error(message)

        // 以前失败只写日志，界面上看不到，用户只会发现「有些词条没翻」却不知道原因。
        // 现在把首条失败原因直接弹出来，尤其是语言码没绑定这种情况。
        const firstReason = failedJobs[0][1]?.message || ''
        // 语言码没绑定时，弹窗直接给入口，别让人自己去命令面板里猜命令名
        const isLocaleError = /没有对应的翻译语言码/.test(firstReason)
        window.showWarningMessage(
          `${message}${firstReason ? ` · 原因：${firstReason}` : ''}`,
          ...(isLocaleError ? ['配置翻译语言映射'] : []),
        ).then((choice) => {
          if (choice === '配置翻译语言映射')
            commands.executeCommand(Commands.config_translate_locales)
        })
      }

      if (cancelledJobs.length) {
        window.showWarningMessage(
          `${i18n.t('prompt.translate_cancelled_multiple', cancelledJobs.length)}（通常是源语言该 key 为空，或引擎返回了空结果）`,
        )
      }

      return outcome
    })
  }

  static getTranslateJobs(
    loader: Loader,
    nodes: AccaptableTranslateItem[],
    sourceLanguage: string,
    targetLocales?: string[],
    token?: CancellationToken,
  ): TranslateJob[] {
    const jobs: TranslateJob[] = []

    const resolveFrom = (keypath: string, targetLocale: string): string | undefined => {
      const from = this.resolveSourceLocaleFor(loader, keypath, sourceLanguage, targetLocale)
      if (!from) {
        Log.warn(`🌎⚠️ "${keypath}" 在源语言 ${sourceLanguage} 无文案，其它语言也没有可交叉引用的原文，跳过 ${targetLocale}`)
        return undefined
      }
      if (!Config.isSameLocale(from, sourceLanguage))
        Log.info(`🌎🔁 "${keypath}" 交叉引用 ${from} 的文案作为原文 -> ${targetLocale}`)
      return from
    }

    const pushRecord = (node: LocaleRecord, force = false) => {
      if (node.readonly)
        return

      if (force || Config.translateOverrideExisting || !node.value) {
        const from = resolveFrom(node.keypath, node.locale)
        if (!from)
          return
        jobs.push({
          loader,
          locale: node.locale,
          keypath: node.keypath,
          filepath: node.filepath,
          source: from,
          token,
        })
      }
    }

    for (const node of nodes) {
      if (!node.type) {
        const from = resolveFrom(node.keypath, node.locale)
        if (!from)
          continue
        jobs.push({
          loader,
          locale: node.locale,
          keypath: node.keypath,
          source: from,
          token,
        })
      }
      else if (node.type === 'record') {
        pushRecord(node, true)
      }
      else {
        if (node.readonly)
          continue

        Object.values(loader.getShadowLocales(node, targetLocales))
          // 以前无条件把源语言自己过滤掉，导致「翻译所有缺失的文案」对
          // chs.json 的空 key 一个任务都不生成；交叉引用开启时保留它
          .filter(record => Config.translateFallbackFromOtherLocales
            || !Config.isSameLocale(record.locale, sourceLanguage))
          .forEach(record => pushRecord(record))
      }
    }
    return jobs
  }

  static async translateJob(
    job: TranslateJob,
  ) {
    const { loader, locale, keypath, filepath, token, source } = job
    if (token?.isCancellationRequested)
      return

    if (Config.isSameLocale(locale, source))
      throw new AllyError(ErrorType.translating_same_locale)

    const value = this.getValueOfKey(loader, keypath, source)

    try {
      Log.info(`🌍 Translating "${keypath}" (${source}->${locale})`)
      this.start(keypath, locale)
      const result = await this.translateText(value, source, locale)
      this.end(keypath, locale)

      if (token?.isCancellationRequested)
        return

      const pending: PendingWrite = {
        locale,
        value: result,
        filepath,
        keypath,
      }

      return pending
    }
    catch (e) {
      this.end(keypath, locale)
      throw e
    }
  }

  private static async saveTranslations(
    loader: Loader,
    results: ({result: PendingWrite | undefined; job: TranslateJob})[],
  ): Promise<TranslateSaveOutcome> {
    const now = new Date().toISOString()
    const r = results.filter(i => i.result) as ({result: PendingWrite; job: TranslateJob})[]

    if (!r.length)
      return { mode: 'written', written: 0, candidates: 0, skipped: 0 }

    if (Config.translateSaveAsCandidates) {
      await Global.reviews.setTranslationCandidates(r.map(i => ({
        key: i.job.keypath,
        locale: i.job.locale,
        translation: {
          source: i.job.source,
          text: i.result.value || '',
          time: now,
        },
      })))
      Log.warn(`[translate] 译文已存为 ${r.length} 条候选，未写入语言文件（translate.saveAsCandidates=true）`)
      // 候选模式是「故意不写盘」，但提示必须说清楚，否则用户会以为翻译已经落地
      return { mode: 'candidates', written: 0, candidates: r.length, skipped: 0 }
    }

    const written = await loader.write(r.map(i => i.result)) || 0
    const skipped = Math.max(0, r.length - written)
    if (skipped)
      Log.warn(`[translate] ${r.length} 条待写入，实际写入 ${written} 条，${skipped} 条未落盘`)
    return { mode: 'written', written, candidates: 0, skipped }
  }

  private static async translateTexts(texts: string[], from: string, to: string): Promise<(string | Error)[]> {
    const engines = Config.translateEngines
    let lastError: Error | undefined

    for (const engine of engines) {
      try {
        // 发请求前先确认这个语言能解析成引擎语言码，避免把 chs / can 之类的
        // 项目文件名原样丢给 API，最后只拿到一个错误码被静默丢弃。
        if (!Config.isTranslateLocaleSupported(engine, to))
          throw this.unsupportedLocaleError(engine, to)
        // 交叉引用时 from 可能不是配置的源语言，同样要能解析成引擎语言码。
        // asSource=true：只要求该语言在引擎清单里存在，不要求它能当目标语言
        if (!Config.isTranslateLocaleSupported(engine, from, true))
          throw this.unsupportedLocaleError(engine, from)

        const api = this.resolveEngineLocales(engine, from, to)
        const engineInstance = this._translator.engines[engine]
        if (engineInstance && typeof engineInstance.translateBatch === 'function') {
          try {
            const batchResult = await engineInstance.translateBatch({ texts, from: api.from, to: api.to })
            const batchResults = batchResult.results.map((r) => {
              if (r.error)
                return r.error
              return (r.result || []).join('\n') || r.error || new Error('No result')
            })

            const hasErrors = batchResults.some(r => r instanceof Error)
            if (!hasErrors)
              return batchResults
          }
          catch (batchErr) {
            console.error('Batch translation failed, falling back to single translation', batchErr)
          }
        }

        const results: (string | Error)[] = []
        for (const text of texts) {
          try {
            const result = await this.translateText(text, api.from, api.to)
            results.push(result)
          }
          catch (e) {
            results.push(e as Error)
          }
        }
        return results
      }
      catch (e) {
        lastError = e as Error
        console.error(`Translation engine ${engine} failed`, e)
      }
    }

    // 保留真实原因（例如「语言 can 没有对应的翻译语言码」），别用一句笼统的失败盖掉
    return texts.map(() => lastError || new Error('All translation engines failed'))
  }

  private static async translateText(text: string, from: string, to: string): Promise<string> {
    const engines = Config.translateEngines
    let trans_result: TranslateResult | undefined

    const errors: Error[] = []

    if (!text)
      return ''

    for (const engine of engines) {
      try {
        if (!Config.isTranslateLocaleSupported(engine, to)) {
          errors.push(this.unsupportedLocaleError(engine, to))
          continue
        }
        const api = this.resolveEngineLocales(engine, from, to)
        trans_result = await this._translator.translate({ engine, text, from: api.from, to: api.to })
        if (trans_result.error)
          throw trans_result.error

        break
      }
      catch (e) {
        errors.push(e)
      }
    }

    const result = trans_result && (trans_result.result || []).join('\n')

    if (!result)
      throw errors[0] || new Error('No translation engine available')

    return result
  }
}
