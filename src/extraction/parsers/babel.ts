import { parse } from '@babel/parser'
// @ts-ignore
import traverse from '@babel/traverse'
import { DefaultDynamicExtractionsRules, DefaultExtractionRules, ExtractionRule } from '../rules'
import { shouldExtract } from '../shouldExtract'
import { ExtractionBabelOptions } from './options'
import { DetectionResult } from '~/core/types'
import { CJK_CHAR_REGEX } from '../utils'

const defaultOptions: Required<ExtractionBabelOptions> = {
  ignoredJSXAttributes: ['class', 'className', 'key', 'style', 'ref', 'onClick'],
}

export function detect(
  input: string,
  rules: ExtractionRule[] = DefaultExtractionRules,
  dynamicRules: ExtractionRule[] = DefaultDynamicExtractionsRules,
  userOptions: ExtractionBabelOptions = {},
  customCallExpression?: (path: any, recordIgnore: (path: any) => void) => void,
) {
  const {
    ignoredJSXAttributes,
  } = Object.assign({}, defaultOptions, userOptions)

  const detections: DetectionResult[] = []

  const ast = parse(input, {
    sourceType: 'unambiguous',
    plugins: [
      'jsx',
      'typescript',
      'decorators-legacy',
    ],
  })

  const ignores: [number, number][] = []

  function handlePath(path: any, type: DetectionResult['source']) {
    const fullStart = path?.node?.start
    const fullEnd = path?.node?.end

    if (!fullStart || !fullEnd)
      return

    if (isIgnored(fullStart, fullEnd))
      return

    const quoted = type !== 'jsx-text'
    const fullText = input.slice(fullStart, fullEnd)

    // const start = quoted ? fullStart + 1 : fullStart
    // const end = quoted ? fullEnd - 1 : fullEnd
    const text = quoted ? fullText.slice(1, -1) : fullText

    if (type === 'js-template' && !shouldExtract(text, dynamicRules))
      return
    else if (!shouldExtract(text, rules))
      return

    detections.push({
      fullEnd,
      fullStart,
      fullText,
      start: fullStart,
      end: fullEnd,
      text,
      source: type,
    })
  }

  function recordIgnore(path: any) {
    const fullStart = path?.node?.start ?? path?.start
    const fullEnd = path?.node?.end ?? path?.end

    if (!fullStart || !fullEnd)
      return

    ignores.push([fullStart, fullEnd])
  }

  function isIgnored(start: number, end: number) {
    return ignores.find(([s, e]) => (s <= start && start <= e) || (s <= end && end <= e)) != null
  }

  traverse(ast, {
    StringLiteral(path: any) {
      handlePath(path, 'js-string')
    },
    TemplateLiteral(path: any) {
      // Template literal with interpolations, e.g. `设备资源 - ${row.name}` /
      // `${year}年`: extract every static chunk around the interpolations, so
      // the replacement becomes `${$t('key')} - ${row.name}` /
      // `${year}${$t('key')}` and the bindings stay untouched.
      const expressions: any[] = path?.node?.expressions || []
      if (expressions.length) {
        const bodyStart = path.node.start + 1
        const bodyEnd = path.node.end - 1

        for (let i = 0; i <= expressions.length; i++) {
          const s = i === 0 ? bodyStart : expressions[i - 1].end + 1
          const e = i < expressions.length ? expressions[i].start - 2 : bodyEnd
          if (e <= s)
            continue

          const raw = input.slice(s, e)
          // keep only the CJK core of the chunk, so surrounding punctuation and
          // spaces (e.g. the ` - ` in `设备资源 - ${row.name}`) stay literal
          const firstCjk = raw.search(CJK_CHAR_REGEX)
          if (firstCjk < 0)
            continue
          let lastCjk = raw.length - 1
          while (lastCjk > firstCjk && !CJK_CHAR_REGEX.test(raw[lastCjk]))
            lastCjk -= 1

          const text = raw.slice(firstCjk, lastCjk + 1)
          if (!text)
            continue
          if (!shouldExtract(text, rules))
            continue

          const segStart = s + firstCjk
          detections.push({
            text,
            fullText: text,
            start: segStart,
            end: segStart + text.length,
            source: 'js-template-segment',
          })
        }
        return
      }

      handlePath(path, 'js-template')
    },
    JSXText(path: any) {
      handlePath(path, 'jsx-text')
    },
    // scan for jsx attributes
    JSXElement(path: any) {
      path?.node?.openingElement?.attributes?.forEach((i: any) => {
        if (ignoredJSXAttributes.includes(i?.name?.name))
          recordIgnore(i)
      })
    },
    // ignore `console.xxx`
    CallExpression(path: any) {
      if (customCallExpression) customCallExpression(path, recordIgnore)
      const callee = path.get('callee')
      if (!callee.isMemberExpression()) return
      if (isGlobalConsoleId(callee.get('object')))
        recordIgnore(path)
    },
  })

  return detections
}

function isGlobalConsoleId(id: any) {
  const name = 'console'
  return (
    id.isIdentifier({ name })
    && !id.scope.getBinding(name)
    && id.scope.hasGlobal(name)
  )
}
