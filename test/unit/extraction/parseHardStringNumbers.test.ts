/* eslint-disable no-template-curly-in-string */
import { expect } from 'chai'
import { parseHardString } from '../../../src/extraction/parseHardString'

describe('parseHardString - ICU number placeholders', () => {
  it('tail number', () => {
    const r = parseHardString('簇母线电压1')
    expect(r?.text).to.equal('簇母线电压{0}')
    expect(r?.args).to.eql(['1'])
  })

  it('tail multi-digit number', () => {
    const r = parseHardString('簇母线电压220')
    expect(r?.text).to.equal('簇母线电压{0}')
    expect(r?.args).to.eql(['220'])
  })

  it('no number', () => {
    const r = parseHardString('簇母线电压')
    expect(r?.text).to.equal('簇母线电压')
    expect(r?.args).to.eql([])
  })

  it('middle number converted', () => {
    const r = parseHardString('温度25℃')
    expect(r?.text).to.equal('温度{0}℃')
    expect(r?.args).to.eql(['25'])
  })

  it('multiple numbers', () => {
    const r = parseHardString('第3页共10页')
    expect(r?.text).to.equal('第{0}页共{1}页')
    expect(r?.args).to.eql(['3', '10'])
  })

  it('number in middle and tail', () => {
    const r = parseHardString('共256项数据1')
    expect(r?.text).to.equal('共{0}项数据{1}')
    expect(r?.args).to.eql(['256', '1'])
  })

  it('space separated number', () => {
    const r = parseHardString('共 256 项数据')
    expect(r?.text).to.equal('共 {0} 项数据')
    expect(r?.args).to.eql(['256'])
  })

  it('pure text untouched', () => {
    const r = parseHardString('hello world')
    expect(r?.text).to.equal('hello world')
    expect(r?.args).to.eql([])
  })

  it('with ${expr} - numbers untouched', () => {
    const r = parseHardString('你好${name}，今年25岁')
    expect(r?.text).to.equal('你好{0}，今年25岁')
    expect(r?.args).to.eql(['name'])
  })

  it('with {{expr}} - numbers untouched', () => {
    const r = parseHardString('你好{{name}}，共256项')
    expect(r?.text).to.equal('你好{0}，共256项')
    expect(r?.args).to.eql(['name'])
  })

  it('tail number with dynamic expr - numbers untouched', () => {
    const r = parseHardString('你好${name}1')
    expect(r?.text).to.equal('你好{0}1')
    expect(r?.args).to.eql(['name'])
  })
})
