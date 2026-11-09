import { Parser } from 'htmlparser2'
import { parse } from '@babel/parser'
// @ts-ignore
import traverse from '@babel/traverse'
import { DefaultDynamicExtractionsRules, DefaultExtractionRules, ExtractionRule } from '../rules'
import { shouldExtract } from '../shouldExtract'
import { ExtractionHTMLOptions } from './options'
import { shiftDetectionPosition } from './utils'
import { DetectionResult } from '~/core/types'

const defaultOptions: Required<ExtractionHTMLOptions> = {
  attributes: ['title', 'alt', 'placeholder', 'label', 'aria-label'],
  ignoredTags: ['script', 'style'],
  vBind: true,
  inlineText: true,
}

function extractStringsFromExpression(
  expression: string,
  baseOffset: number,
  rules: ExtractionRule[],
  dynamicRules: ExtractionRule[],
): DetectionResult[] {
  const results: DetectionResult[] = []
  const ignores: [number, number][] = []

  function recordIgnore(path: any) {
    const fullStart = path?.node?.start ?? path?.start
    const fullEnd = path?.node?.end ?? path?.end
    if (!fullStart || !fullEnd)
      return
    ignores.push([fullStart, fullEnd])
  }

  function isIgnored(start: number, end: number) {
    return ignores.some(([s, e]) => (s <= start && start <= e) || (s <= end && end <= e))
  }

  function isTranslationFunction(callee: any) {
    if (callee.isIdentifier()) {
      const name = callee.node.name
      return ['t', 'tc', 'te', 'i18n'].includes(name)
    }
    if (callee.isMemberExpression()) {
      const property = callee.get('property')
      if (property.isIdentifier()) {
        const name = property.node.name
        return ['t', 'tc', 'te'].includes(name)
      }
    }
    return false
  }

  try {
    const ast = parse(expression, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript'],
    })

    traverse(ast, {
      CallExpression(path: any) {
        const callee = path.get('callee')
        if (isTranslationFunction(callee)) {
          path.get('arguments').forEach(recordIgnore)
        }
      },
      StringLiteral(path: any) {
        const fullStart = path.node.start
        const fullEnd = path.node.end
        if (!fullStart || !fullEnd)
          return

        if (isIgnored(fullStart, fullEnd))
          return

        const fullText = expression.slice(fullStart, fullEnd)
        const text = fullText.slice(1, -1)

        if (shouldExtract(text, rules)) {
          results.push({
            fullEnd: baseOffset + fullEnd,
            fullStart: baseOffset + fullStart,
            fullText,
            start: baseOffset + fullStart,
            end: baseOffset + fullEnd,
            text,
            source: 'html-interpolation',
          })
        }
      },
      TemplateLiteral(path: any) {
        const fullStart = path.node.start
        const fullEnd = path.node.end
        if (!fullStart || !fullEnd)
          return

        if (isIgnored(fullStart, fullEnd))
          return

        const fullText = expression.slice(fullStart, fullEnd)
        const text = fullText.slice(1, -1)

        if (shouldExtract(text, dynamicRules)) {
          results.push({
            fullEnd: baseOffset + fullEnd,
            fullStart: baseOffset + fullStart,
            fullText,
            start: baseOffset + fullStart,
            end: baseOffset + fullEnd,
            text,
            source: 'html-interpolation',
          })
        }
      },
    })
  }
  catch (e) {
    // ignore parsing errors
  }

  return results
}

export function detect(
  input: string,
  rules: ExtractionRule[] = DefaultExtractionRules,
  dynamicRules: ExtractionRule[] = DefaultDynamicExtractionsRules,
  userOptions: ExtractionHTMLOptions = {},
  extractScripts?: (script: string, start: number) => DetectionResult[],
): DetectionResult[] {
  const {
    attributes: ATTRS,
    ignoredTags: IGNORED_TAGS,
    vBind: V_BIND,
  } = Object.assign({}, defaultOptions, userOptions)

  const detections: DetectionResult[] = []

  // replace svelte inline function, #624
  input = input.replace(/<(.*?)={(.*?)}(.*?)>/g, '<$1="$2"$3>')

  let lastTag = ''
  let lastScriptIndex: number | null = null
  const parser = new Parser({
    onopentag(name, attrs) {
      lastTag = name
      if (name === 'script')
        lastScriptIndex = parser.endIndex! + 1

      if (IGNORED_TAGS.includes(name))
        return

      const attrNames = Object.keys(attrs).map((name) => {
        // static
        if (ATTRS.includes(name) && shouldExtract(attrs[name], rules))
          return [name, false]
        // dynamic
        else if (
          V_BIND
          && ATTRS.some(n => name === `:${n}` || name === `v-bind:${n}`)
          && shouldExtract(attrs[name], dynamicRules)
        )
          return [name, true]
        return null
      })
        .filter(Boolean) as [string, boolean][]
      if (!attrNames.length)
        return

      const tagStart = parser.startIndex
      const tagEnd = parser.endIndex!
      const code = input.slice(tagStart, tagEnd)

      for (const [name, isDynamic] of attrNames) {
        const attrValue = attrs[name]
        if (attrValue == null)
          continue

        const attrPattern = new RegExp('\\s' + name + '=(["\'])', 'g')
        let attrMatch
        let lastMatchIndex = -1
        while ((attrMatch = attrPattern.exec(code)) !== null) {
          lastMatchIndex = attrMatch.index
        }

        if (lastMatchIndex === -1)
          continue

        const fullStart = tagStart + lastMatchIndex + 1
        const attrText = name + '="' + attrValue + '"'
        const fullEnd = fullStart + attrText.length
        const fullText = input.slice(fullStart, fullEnd)
        const start = fullStart + name.length + 2 // ="
        const end = fullEnd - 1 // "
        const text = input.slice(start, end)

        if (isDynamic) {
          const strings = extractStringsFromExpression(text, start, rules, dynamicRules)
          if (strings.length > 0) {
            for (const str of strings) {
              detections.push({
                ...str,
                source: 'html-attribute-string' as const,
                attributeName: name,
                fullStart,
                fullEnd,
                fullText,
              })
            }
          }
          else {
            detections.push({
              text,
              start,
              end,
              isDynamic,
              fullStart,
              fullEnd,
              fullText,
              source: 'html-attribute',
              attributeName: name,
            })
          }
        }
        else {
          detections.push({
            text,
            start,
            end,
            isDynamic,
            fullStart,
            fullEnd,
            fullText,
            source: 'html-attribute',
            attributeName: name,
          })
        }
      }
    },
    onclosetag(name) {
      if (name !== 'script' || lastScriptIndex == null)
        return
      const start = lastScriptIndex
      const fullText = input.slice(start, parser.startIndex!)
      if (extractScripts)
        detections.push(...shiftDetectionPosition(extractScripts(fullText, start), start))
      lastScriptIndex = null
    },
    ontext(fullText) {
      if (lastScriptIndex != null)
        return
      if (IGNORED_TAGS.includes(lastTag))
        return

      const start = parser.startIndex
      const end = parser.endIndex! + 1

      const text = fullText.split(/\n/g).map(i => i.trim()).filter(Boolean).join(' ')

      const interpolationRegex = /\{\{([\s\S]*?)\}\}/g
      let match

      const interpolationRanges: [number, number][] = []
      while ((match = interpolationRegex.exec(fullText)) !== null) {
        const exprStart = start + match.index + 2
        const exprText = match[1]

        const strings = extractStringsFromExpression(exprText, exprStart, rules, dynamicRules)
        detections.push(...strings)

        interpolationRanges.push([match.index, match.index + match[0].length])
      }

      // Text node mixed with interpolations (e.g. `{{ year }} 年`): keep the
      // interpolations untouched and extract only the static text segments
      // around them, so the replacement becomes `{{ year }} {{ $t('key') }}`
      // instead of swallowing the whole expression into a single key.
      if (interpolationRanges.length) {
        const segments: [number, number][] = []
        let cursor = 0
        for (const [s, e] of interpolationRanges) {
          if (s > cursor)
            segments.push([cursor, s])
          cursor = e
        }
        if (cursor < fullText.length)
          segments.push([cursor, fullText.length])

        for (const [s, e] of segments) {
          const seg = fullText.slice(s, e)
          const trimmed = seg.trim()
          if (!trimmed)
            continue
          if (!shouldExtract(trimmed, rules))
            continue

          const segStart = start + s + (seg.length - seg.trimStart().length)
          detections.push({
            text: trimmed,
            fullText: trimmed,
            start: segStart,
            end: segStart + trimmed.length,
            source: 'html-inline',
          })
        }
        return
      }

      if (!shouldExtract(text, rules))
        return

      detections.push({
        text: fullText,
        fullText,
        start,
        end,
        source: 'html-inline',
      })
    },
  }, {
    xmlMode: true,
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
    recognizeSelfClosing: true,
  })

  parser.parseComplete(input)

  return detections
}
