import { workspace } from 'vscode'
import { ExtractionRule, ExtractionScore } from './base'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/**
 * 只提取含中日韩字符的字符串。
 *
 * 本项目源语言是中文，像 `'0 0 1024 1024'`（SVG viewBox）、`'1024x768'` 这类
 * 纯技术字符串不该变成词条。需要提取英文时把 i18n-ally.extract.requireCJK 关掉即可。
 */
export class CjkOnlyExtractionRule extends ExtractionRule {
  name = 'cjk-only'

  shouldExtract(str: string) {
    const enabled = workspace.getConfiguration('i18n-ally').get<boolean>('extract.requireCJK', true)
    if (!enabled)
      return ExtractionScore.None

    return CJK.test(str) ? ExtractionScore.None : ExtractionScore.MustExclude
  }
}
