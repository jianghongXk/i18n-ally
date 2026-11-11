/**
 * ⚠️ 这是 locales/*.json → package.nls.*.json 的单向生成器，跑一次就会整份覆盖 nls。
 *
 * 本项目实际是**手改 package.nls.*.json**（设置界面文案、enumDescriptions 都在那边），
 * 所以默认不要跑它。真要跑，先把 locales/*.json 与 nls 同步（当前两边已对齐，幂等）。
 * 它还会把 locales/en.json 里多出来的 key 用英文灌进其它语言包。
 *
 * 已从 package.json 的 scripts 中移除对应命令，就是为了避免误触发。
 * 需要时手动执行：npx esno scripts/build-i18n.ts
 */
import path from 'path'
import fg from 'fast-glob'
import fs from 'fs-extra'

const DEFAULT_LOCALE = 'en'

;(async() => {
  const fallbackMessages = JSON.parse(await fs.readFile(`./locales/${DEFAULT_LOCALE}.json`, 'utf-8'))

  const files = await fg('./locales/*.json')
  for (const file of files) {
    const { name: locale } = path.parse(file)
    const messages = JSON.parse(await fs.readFile(file, 'utf-8'))

    Object.keys(fallbackMessages)
      .forEach((key) => {
        messages[key] = messages[key] || fallbackMessages[key]
      })

    const output = locale === DEFAULT_LOCALE
      ? './package.nls.json'
      : `./package.nls.${locale.toLowerCase()}.json`

    await fs.writeFile(output, JSON.stringify(messages, null, 2), 'utf-8')
  }
})()
