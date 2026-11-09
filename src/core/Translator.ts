import { EventEmitter, CancellationToken, window, ProgressLocation, commands } from 'vscode'
import { AllyError, ErrorType } from './Errors'
import { PendingWrite } from './types'
import { Global } from './Global'
import { LocaleTree, LocaleNode, LocaleRecord, Config, Loader } from '.'
import { Commands } from '~/commands'
import i18n from '~/i18n'
import { Log } from '~/utils'
import { Translator as TranslateEngine, TranslateResult } from '~/translators'

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

export type AccaptableTranslateItem =
  | LocaleNode
  | LocaleRecord
  | {locale: string; keypath: string; type: undefined }

export class Translator {
  private static translatingKeys: {keypath: string; locale: string}[] = []
  private static _onDidChange = new EventEmitter<TranslatorChangeEvent>()
  static readonly onDidChange = Translator._onDidChange.event
  private static _translator = new TranslateEngine()

  // #region utils
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

  private static getValueOfKey(loader: Loader, keypath: string, sourceLanguage: string) {
    const sourceNode = loader.getNodeByKey(keypath)
    if (!sourceNode) {
      if (Config.translateFallbackToKey)
        return keypath
      return ''
    }

    const sourceRecord = sourceNode.locales[sourceLanguage]
    if (!sourceRecord || !sourceRecord.value) {
      if (Config.translateFallbackToKey)
        return keypath
      return ''
    }

    return sourceRecord.value
  }
  // #endregion

  static async translateNodes(
    loader: Loader,
    nodes: AccaptableTranslateItem[],
    sourceLanguage: string,
    targetLocales?: string[],
    options?: { skipConfirm?: boolean },
  ) {
    if (!nodes.length)
      return

    const jobs = this.getTranslateJobs(loader, nodes, sourceLanguage, targetLocales)

    if (!jobs.length) {
      window.showInformationMessage(
        i18n.t('prompt.translate_no_jobs'),
      )
      return
    }

    if (jobs.length > 1 && !options?.skipConfirm) {
      const Yes = i18n.t('prompt.button_yes')
      const result = await window.showWarningMessage(
        i18n.t('prompt.translate_multiple_confirm', jobs.length),
        { modal: true },
        Yes,
      )
      if (result !== Yes)
        return
    }

    window.withProgress({
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

        const jobsByLocale: Record<string, TranslateJob[]> = {}
        for (const job of batchJobs) {
          if (!jobsByLocale[job.locale])
            jobsByLocale[job.locale] = []
          jobsByLocale[job.locale].push(job)
        }

        for (const [locale, localeJobs] of Object.entries(jobsByLocale)) {
          const texts = localeJobs.map(job => this.getValueOfKey(job.loader, job.keypath, job.source))
          const source = localeJobs[0].source

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
              if (result instanceof Error) {
                throw result
              }

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
      if (successfulResults.length > 0) {
        try {
          await this.saveTranslations(loader, successfulResults)
        }
        catch (err) {
          console.error('Failed to save translations', err)
          window.showErrorMessage(i18n.t('prompt.translate_save_failed'))
        }
      }

      // translating done
      if (successJobs.length === 1) {
        (async() => {
          const job = successJobs[0]

          const editButton = i18n.t('prompt.translate_edit_translated')
          const result = await window.showInformationMessage(
            i18n.t('prompt.translate_done_single', job.keypath),
            editButton,
          )
          if (result === editButton)
            commands.executeCommand(Commands.edit_key, { keypath: job.keypath, locale: job.locale })
        })()
      }
      else if (successJobs.length > 0) {
        window.showInformationMessage(i18n.t('prompt.translate_done_multiple', successJobs.length))
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
      }

      if (cancelledJobs.length)
        window.showInformationMessage(i18n.t('prompt.translate_cancelled_multiple', cancelledJobs.length))
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

    const pushRecord = (node: LocaleRecord, force = false) => {
      if (node.readonly)
        return

      if (force || Config.translateOverrideExisting || !node.value) {
        jobs.push({
          loader,
          locale: node.locale,
          keypath: node.keypath,
          filepath: node.filepath,
          source: sourceLanguage,
          token,
        })
      }
    }

    for (const node of nodes) {
      if (!node.type) {
        jobs.push({
          loader,
          locale: node.locale,
          keypath: node.keypath,
          source: sourceLanguage,
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
          .filter(record => record.locale !== sourceLanguage)
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
  ) {
    const now = new Date().toISOString()
    const r = results.filter(i => i.result) as ({result: PendingWrite; job: TranslateJob})[]

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
    }
    else {
      await loader.write(r.map(i => i.result))
    }
  }

  private static async translateTexts(texts: string[], from: string, to: string): Promise<(string | Error)[]> {
    const engines = Config.translateEngines

    for (const engine of engines) {
      try {
        const engineInstance = this._translator.engines[engine]
        if (engineInstance && typeof engineInstance.translateBatch === 'function') {
          try {
            const batchResult = await engineInstance.translateBatch({ texts, from, to })
            const batchResults = batchResult.results.map(r => {
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
            const result = await this.translateText(text, from, to)
            results.push(result)
          }
          catch (e) {
            results.push(e as Error)
          }
        }
        return results
      }
      catch (e) {
        console.error(`Translation engine ${engine} failed`, e)
      }
    }

    return texts.map(() => new Error('All translation engines failed'))
  }

  private static async translateText(text: string, from: string, to: string): Promise<string> {
    const engines = Config.translateEngines
    let trans_result: TranslateResult | undefined

    const errors: Error[] = []

    if (!text)
      return ''

    for (const engine of engines) {
      try {
        trans_result = await this._translator.translate({ engine, text, from, to })
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
      throw errors[0]

    return result
  }
}
