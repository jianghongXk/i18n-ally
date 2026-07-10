import { expect } from 'chai'
import { extractionsParsers } from '../../../../src/extraction'

const html = extractionsParsers.html

describe('detections', () => {
  describe('attrs', () => {
    it('html', () => {
      expect(html.detect('<div placeholder="Hello"></div>')).to.matchSnapshot()

      expect(html.detect(`
<textarea
  class="form-control"
  rows="8"
  v-model="article.body"
  placeholder="Write your article (in markdown)"
  ></textarea>
`)).to.matchSnapshot()

      expect(html.detect('<img src="{{ img_url }}" title="This is a title" alt="This is an alt.">')).to.matchSnapshot()
      expect(html.detect('<img src="https://example.com/img.svg" :title="image" alt="img.svg">')).eql([])
    })

    it('vue-favored attrs', () => {
      expect(html.detect(
        // eslint-disable-next-line no-template-curly-in-string
        '<input v-bind:placeholder="\'Placeholder \' + input_name" :title="`${input_name} title`" name="email">'),
      ).to.matchSnapshot()
    })
  })

  describe('inline', () => {
    it('plain text', () => {
      expect(html.detect('<p>Popular Tags</p>')).to.matchSnapshot()
    })

    it('mixed text', () => {
      expect(html.detect(`
<p>
  <router-link :to="{ name: 'login' }">Sign in</router-link>
  or
  <router-link :to="{ name: 'register' }">sign up</router-link>
  to add comments on this article.
</p>`)).to.matchSnapshot()
    })

    it('vue-favored variables', () => {
      expect(html.detect('<p>Using mustaches: {{ rawHtml }}</p>')).to.matchSnapshot()
    })

    it('ignore translated keys', () => {
      expect(html.detect('<p>{{ $t("hello.world") }}</p>').length).to.eq(0)
      expect(html.detect('<p :placeholder="t(`hello.world`)"></p>').length).to.eq(0)
      expect(html.detect('<p :placeholder="hello + world"></p>').length).to.eq(0)
    })

    it('multiple lines', () => {
      expect(html.detect(`
<p>
  Using
  v-html
  directive:
  <span v-html="rawHtml"></span>
</p>
`)).to.matchSnapshot()
    })

    it('invalid', () => {
      expect(html.detect('<p>class.name</p>')).eql([])
      expect(html.detect('<p> {{ $t("hello") }} </p>')).eql([])
    })

    it('exclude tag', () => {
      expect(html.detect('<script>Hello</script>')).eql([])
      expect(html.detect('<style lang="ts">Hello</style>')).eql([])
    })

    it('vue interpolation expressions with Chinese', () => {
      const result1 = html.detect('<span>{{ detailData.forecastType === "1" ? "日前预测" : "超短期预测" }}</span>')
      expect(result1).to.have.length(2)
      expect(result1[0].text).to.eq('日前预测')
      expect(result1[1].text).to.eq('超短期预测')

      const result2 = html.detect('<span>{{ type === "a" ? "中文A" : type === "b" ? "中文B" : "中文C" }}</span>')
      expect(result2).to.have.length(3)
      expect(result2[0].text).to.eq('中文A')
      expect(result2[1].text).to.eq('中文B')
      expect(result2[2].text).to.eq('中文C')

      const result3 = html.detect('<span>{{ status ? "启用" : "禁用" }}</span>')
      expect(result3).to.have.length(2)
      expect(result3[0].text).to.eq('启用')
      expect(result3[1].text).to.eq('禁用')
    })

    it('ignore translation function arguments in interpolation', () => {
      expect(html.detect('<span>{{ $t("hello") }}</span>').length).to.eq(0)
      expect(html.detect('<span>{{ t("world") }}</span>').length).to.eq(0)
      expect(html.detect('<span>{{ tc("items", 2) }}</span>').length).to.eq(0)
      expect(html.detect('<span>{{ this.$t("key") }}</span>').length).to.eq(0)
      expect(html.detect('<span>{{ i18n.t("key") }}</span>').length).to.eq(0)
    })

    it('mixed text with interpolation', () => {
      const result = html.detect('<span>状态：{{ status ? "启用" : "禁用" }}</span>')
      const extractedTexts = result.map(r => r.text)
      expect(extractedTexts).to.include('启用')
      expect(extractedTexts).to.include('禁用')
      const interpolationResults = result.filter(r => r.source === 'html-interpolation')
      expect(interpolationResults).to.have.length(2)
    })

    it('interpolation source type', () => {
      const result = html.detect('<span>{{ detailData.forecastType === "1" ? "日前预测" : "超短期预测" }}</span>')
      expect(result).to.have.length(2)
      expect(result[0].source).to.eq('html-interpolation')
      expect(result[1].source).to.eq('html-interpolation')
    })
  })
})
