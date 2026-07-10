import crypto from 'crypto'
import axios from 'axios'
import qs from 'qs'

const appid = process.env.BAIDU_APPID || 'your_appid'
const secret = process.env.BAIDU_SECRET || 'your_secret'
const salt = Date.now().toString()

function getSign(query: string) {
  if (appid && salt) {
    const string = appid + query + salt + secret
    const md5 = crypto.createHash('md5')
    md5.update(string)
    return md5.digest('hex')
  }
  return ''
}

async function testSingle() {
  console.log('=== Testing single text translation ===')
  const query = '你好世界'
  const sign = getSign(query)
  
  const form = {
    q: query,
    appid,
    salt,
    from: 'zh',
    to: 'en',
    sign,
  }

  try {
    const { data } = await axios({
      method: 'GET',
      url: `https://fanyi-api.baidu.com/api/trans/vip/translate?${qs.stringify(form)}`,
    })
    console.log('Single result:', JSON.stringify(data, null, 2))
  } catch (e: any) {
    console.error('Single error:', e.response?.data || e.message)
  }
}

async function testBatch() {
  console.log('\n=== Testing batch translation ===')
  const texts = ['你好世界', '今天天气不错', '这是一个测试', 'Hello World']
  const query = texts.join('\n')
  const sign = getSign(query)
  
  const form = {
    q: query,
    appid,
    salt,
    from: 'zh',
    to: 'en',
    sign,
  }

  try {
    const { data } = await axios({
      method: 'GET',
      url: `https://fanyi-api.baidu.com/api/trans/vip/translate?${qs.stringify(form)}`,
    })
    console.log('Batch result:', JSON.stringify(data, null, 2))
    console.log('trans_result length:', data.trans_result?.length)
    if (data.trans_result) {
      data.trans_result.forEach((item: any, index: number) => {
        console.log(`${index}: "${item.src}" -> "${item.dst}"`)
      })
    }
  } catch (e: any) {
    console.error('Batch error:', e.response?.data || e.message)
  }
}

async function testSmallBatch() {
  console.log('\n=== Testing small batch (2 texts) ===')
  const texts = ['你好', '世界']
  const query = texts.join('\n')
  const sign = getSign(query)
  
  const form = {
    q: query,
    appid,
    salt,
    from: 'zh',
    to: 'en',
    sign,
  }

  try {
    const { data } = await axios({
      method: 'GET',
      url: `https://fanyi-api.baidu.com/api/trans/vip/translate?${qs.stringify(form)}`,
    })
    console.log('Small batch result:', JSON.stringify(data, null, 2))
  } catch (e: any) {
    console.error('Small batch error:', e.response?.data || e.message)
  }
}

async function main() {
  console.log('Baidu Translate API Test')
  console.log('AppID:', appid)
  
  await testSingle()
  await testBatch()
  await testSmallBatch()
}

main().catch(console.error)