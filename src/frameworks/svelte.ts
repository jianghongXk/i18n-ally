import { TextDocument } from 'vscode'
import { Framework } from './base'
import { LanguageId } from '~/utils'
import { Config, DetectionResult } from '~/core'
import { extractionsParsers, DefaultExtractionRules, DefaultDynamicExtractionsRules } from '~/extraction'

class SvelteFramework extends Framework {
  id= 'svelte'
  display= 'Svelte'

  detection= {
    packageJSON: [
      'svelte-i18n',
      'sveltekit-i18n'
    ],
  }

  languageIds: LanguageId[] = [
    'javascript',
    'typescript',
    'svelte',
  ]

  // for visualize the regex, you can use https://regexper.com/
  usageMatchRegex = [
    '(?:\\$(?:_|t|format)|(?:get)\\(\\s*(?:_|t|format)\\s*\\))\\(\\s*[\'"`]({key})[\'"`]',
  ]

  refactorTemplates(keypath: string, args?: string[], document?: TextDocument, detection?: DetectionResult) {
    if (detection?.source === 'html-interpolation') {
      return [
        `$_('${keypath}')`,
        `$t('${keypath}')`,
      ]
    }
    return [
      `$_('${keypath}')`,
      `$t('${keypath}')`,
      `{ $t('${keypath}') }`,
      keypath,
    ]
  }

  supportAutoExtraction = ['svelte']

  detectHardStrings(doc: TextDocument) {
    const text = doc.getText()

    return extractionsParsers.html.detect(
      text,
      DefaultExtractionRules,
      DefaultDynamicExtractionsRules,
      Config.extractParserHTMLOptions,
      // <script>
      script => extractionsParsers.babel.detect(
        script,
        DefaultExtractionRules,
        DefaultDynamicExtractionsRules,
      ),
    )
  }
}

export default SvelteFramework
