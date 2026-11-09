import { BasicExtrationRule } from './basic'
import { NonAsciiExtractionRule } from './non-ascii-characters'
import { DynamicExtractionRule } from './dynamic'
import { CjkOnlyExtractionRule } from './cjk-only'

export * from './base'
export * from './basic'
export * from './non-ascii-characters'

export const DefaultExtractionRules = [
  new CjkOnlyExtractionRule(),
  new BasicExtrationRule(),
  new NonAsciiExtractionRule(),
]

export const DefaultDynamicExtractionsRules = [
  new DynamicExtractionRule(),
]
