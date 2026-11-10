// 生成笔记：只做生文，不生图；模型只收到参考图的文件名，
// 看不到任何图片内容。生成不走登录门禁、不调浏览器。
//
// 入参：generateNote({ topic, keywords, style, accountId, images })
//   images: 最多 9 项，每项 { assetId|null, path }
//   assetId 非 null：查 assets 表取 name；
//   手填 path：只取最后一段文件名，图本身不被读取、也不挂载。
//
// 系统提示词原文（照抄）：
//   “你是一位资深小红书内容运营，擅长写自然、口语化、有真实分享感的
//   图文笔记。不要夸大其词，不要编造具体价格、品牌功效数据或不存在的
//   经历细节；信息不足时写成通用经验分享。”
// draftSchema 四字段只有 describe 文本，没有任何 max 长度硬校验：
//   title“笔记标题，20字以内，口语化，可带1-2个emoji”；
//   body“笔记正文，300-600字，分段自然，口语化，段落间空行”；
//   tags“5-8个话题标签，不带#号”；
//   imageCaptions“与所给参考图片一一对应的配图说明，按图片顺序，
//   数组长度必须与图片数量相同；没有图片时为空数组”。
//
// 入库截断：title slice(0,100)、body slice(0,5000)、tags slice(0,10)、
// topic 原样、status='draft'；仅 assetId 非 null 的图按原顺序写
// imageIdsJson，imageCaptionsJson 存挂载图对应的子集（attachedCaptions，
// 按原位置从模型返回数组取、缺失补 ''），与 Muse 一致。
//
// 模型服务由调用方注入（deps.llm）；未注入时返回 MODEL_NOT_AVAILABLE。

export const SYSTEM_PROMPT =
  '你是一位资深小红书内容运营，擅长写自然、口语化、有真实分享感的图文笔记。不要夸大其词，不要编造具体价格、品牌功效数据或不存在的经历细节；信息不足时写成通用经验分享。'

export const MODEL_NOT_AVAILABLE = 'MODEL_NOT_AVAILABLE'

// 三档固定风格（Muse actions.ts:4647 附近，原文照抄）；默认“种草”。
export const NOTE_STYLES = ['种草', '评测', '探店']
export const DEFAULT_STYLE = '种草'
export const STYLE_GUIDANCE = {
  种草: '以真实使用/体验后的分享口吻种草：先讲使用场景和真实感受，再讲它好在哪、适合谁，像朋友之间推荐好物一样自然，不要硬广腔，不要堆砌卖点。',
  评测: '以测评口吻写：围绕体验有条理地展开（外观/上手、使用感受、优点、不足或注意事项分开讲），最后给明确结论和适合人群；没有真实数据时不要编造参数、跑分或功效数据。',
  探店: '以探店分享口吻写：到店的动线和环境氛围、招牌或必点、实际体验细节、适合什么场合和人群；不要编造具体价格、店名细节或不存在的经历，价格只写「丰俭由人」一类通用说法或略过。',
}

/** 参考图解析为文件名列表（模型只收到这些名字）。 */
export function resolveImageNames(store, images) {
  return (images ?? []).map((image) => {
    if (image?.assetId != null && store) {
      const asset = store.getAsset(image.assetId)
      if (asset?.name) return asset.name
      return '图片'
    }
    const path = String(image?.path ?? '')
    if (!path) return '图片'
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : path || '图片'
  })
}

/** 提示词拼接：主题、风格（含风格写作指引）、关键词、参考图片文件名列表。 */
export function buildUserPrompt({ topic, keywords, style, imageNames }) {
  const guidance = STYLE_GUIDANCE[style] ?? ''
  let prompt = `主题：${topic}\n风格：${style}。${guidance}`
  if (keywords) prompt += `\n关键词/要点：${keywords}`
  if (imageNames.length > 0) {
    const listed = imageNames
      .map((name, i) => `第${i + 1}张「${name}」`)
      .join('、')
    prompt += `\n参考图片（按顺序共${imageNames.length}张）：${listed}。正文要自然呼应这些配图，并为每张图写一句配图说明。`
  } else {
    prompt += '\n这篇笔记暂时没有配图，imageCaptions 返回空数组。'
  }
  // 结构化输出要求：只返回 JSON，字段为 title、body、tags、imageCaptions。
  prompt +=
    '\n请只返回 JSON，字段说明：title 为笔记标题（20字以内，口语化，可带1-2个emoji）；body 为笔记正文（300-600字，分段自然，口语化，段落间空行）；tags 为5-8个话题标签（不带#号）；imageCaptions 为与所给参考图片一一对应的配图说明（按图片顺序，数组长度必须与图片数量相同；没有图片时为空数组）。'
  return prompt
}

function chunkText(chunk) {
  if (chunk == null) return ''
  if (typeof chunk === 'string') return chunk
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta === 'string') return chunk.delta
  if (typeof chunk.delta?.content === 'string') return chunk.delta.content
  if (typeof chunk.content === 'string') return chunk.content
  if (typeof chunk.choices?.[0]?.delta?.content === 'string') {
    return chunk.choices[0].delta.content
  }
  if (typeof chunk.choices?.[0]?.message?.content === 'string') {
    return chunk.choices[0].message.content
  }
  if (typeof chunk.choices?.[0]?.text === 'string') return chunk.choices[0].text
  return ''
}

async function collectStreamText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result.text === 'string') return result.text
  if (typeof result.then === 'function') return collectStreamText(await result)
  if (typeof result[Symbol.asyncIterator] === 'function') {
    let out = ''
    for await (const chunk of result) out += chunkText(chunk)
    return out
  }
  if (typeof result[Symbol.iterator] === 'function') {
    let out = ''
    for (const chunk of result) out += chunkText(chunk)
    return out
  }
  return ''
}

function parseModelJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/**
 * 生成图文笔记并存为草稿。
 * @param {object} input { topic, keywords, style, accountId, images }
 * @param {object} deps { store, llm }（llm 为注入的模型服务）
 */
export async function generateNote(input, deps = {}) {
  const store = deps.store ?? null
  const llm = deps.llm ?? null

  const topic = String(input?.topic ?? '').trim()
  const keywords = String(input?.keywords ?? '').trim()
  const style = NOTE_STYLES.includes(String(input?.style ?? '').trim())
    ? String(input.style).trim()
    : DEFAULT_STYLE
  const accountId = input?.accountId ?? null
  const images = Array.isArray(input?.images) ? input.images : []

  if (!topic || topic.length > 200) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: '主题必填，1–200 字，请检查后重试。',
    }
  }
  if (images.length > 9) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: '参考图片最多 9 张，请减少后重试。',
    }
  }

  const imageNames = resolveImageNames(store, images)
  const userPrompt = buildUserPrompt({ topic, keywords, style, imageNames })

  if (!llm?.stream) {
    return {
      ok: false,
      code: MODEL_NOT_AVAILABLE,
      message: '模型服务未在宿主挂载，生成不可用（待实测）。',
    }
  }

  let text = ''
  try {
    const stream = await llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    })
    text = await collectStreamText(stream)
  } catch {
    return {
      ok: false,
      code: 'MODEL_CALL_FAILED',
      message: '模型调用失败，未生成草稿，请稍后重试。',
    }
  }

  const parsed = parseModelJson(text)
  const title = String(parsed?.title ?? '').trim()
  const body = String(parsed?.body ?? '').trim()
  const tags = (Array.isArray(parsed?.tags) ? parsed.tags : [])
    .map((tag) => String(tag ?? '').trim().replace(/^#+/, ''))
    .filter(Boolean)
  const imageCaptions = (Array.isArray(parsed?.imageCaptions) ? parsed.imageCaptions : []).map(
    (caption) => String(caption ?? ''),
  )

  if (!parsed || !title || !body) {
    return {
      ok: false,
      code: 'MODEL_PARSE_FAILED',
      message: '模型返回内容无法解析，未生成草稿，请重试。',
    }
  }

  // 仅 assetId 非 null 的图按原顺序挂到草稿上；手填 path 的图不挂载。
  // 入库的 imageCaptions 是挂载图对应的子集（按 Muse 为准：
  // actions.ts 里 imageCaptionsJson 存的是 attachedCaptions，
  // 即按原位置从模型返回数组里取出的挂载图说明，不是完整数组）。
  const mountedAssetIds = images
    .filter((image) => image?.assetId != null)
    .map((image) => image.assetId)
  const mountedPositions = []
  images.forEach((image, i) => {
    if (image?.assetId != null) mountedPositions.push(i)
  })
  const mountedCaptions = mountedPositions.map((pos) => imageCaptions[pos] ?? '')

  let noteId = null
  let saved = null
  if (store) {
    saved = store.createNote({
      account_id: accountId,
      title: title.slice(0, 100),
      body: body.slice(0, 5000),
      tags_json: JSON.stringify(tags.slice(0, 10)),
      topic,
      status: 'draft',
      image_ids_json: JSON.stringify(mountedAssetIds),
      image_captions_json: JSON.stringify(mountedCaptions),
      fetched_images_json: '[]',
      source: 'local',
      source_url: '',
      published_at: null,
    })
    noteId = saved?.id ?? null
  }

  return {
    ok: true,
    noteId,
    title: title.slice(0, 100),
    body: body.slice(0, 5000),
    tags: tags.slice(0, 10),
    imageCaptions,
    // 与挂载图片一一对应的配图说明（按原位置取，缺失为 ''），供客户端展示用。
    mountedCaptions,
    note: saved
      ? {
          id: saved.id,
          accountId: saved.account_id,
          title: saved.title,
          body: saved.body,
          tags: tags.slice(0, 10),
          topic: saved.topic,
          status: saved.status,
          imageIds: mountedAssetIds,
          imageCaptions: mountedCaptions,
        }
      : null,
  }
}

// ---------- 生图（三后端，Muse actions.ts:4814–4957） ----------
//
//   muse：走宿主生图能力。DSH 里宿主若注入了 imageGen（createCore 的
//         可选依赖 { generate({ prompt, backend }) -> { buffer, mimeType } }），
//         用它生成；未注入时返回 { ok:false, reason:'muse_error' }，绝不假装生成。
//   dsh：DSH 原生后端，同样走宿主 imageGen；未注入时返回
//         { ok:false, reason:'dsh_unavailable' } + 中文原因。
//         （注意与 Muse 侧正好互换：Muse 里 dsh 明确不可用、muse 可用；
//         DSH 里 dsh 才是原生后端。宿主是否提供生图通道以实测为准，
//         本实现不先写死其中一个为可用——见 PORTING-PLAN §8.5。）
//   api：OpenAI 兼容接口 POST {baseUrl}/images/generations
//         （baseUrl/model/key 读 settings 表，key 只在服务端用；
//         默认 baseUrl https://api.openai.com/v1、默认模型 gpt-image-1；
//         支持 b64_json 或 url 返回，url 时再下载，60 秒超时；
//         120 秒超时）。无 key 时 { ok:false, reason:'no_key' }。
// 成功时把图片存为 assets 行（名 AI生图-<ISO时间>.png，
// folderLabel='AI 生图'），返回 { ok:true, reason:'none', assetId }。
// 失败一律返回 { ok:false, reason, message }，绝不返回假图。
export const IMAGE_GEN_BACKENDS = ['muse', 'dsh', 'api']
export const DEFAULT_IMAGE_API_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_IMAGE_API_MODEL = 'gpt-image-1'

export function getImageGenSettingsFromStore(store) {
  const row = store.getSettings()
  const apiBaseUrl = row.image_api_base_url ?? ''
  const apiModel = row.image_api_model ?? ''
  const updatedAtRaw = row.image_api_key_updated_at ?? null
  // 库里存毫秒时间戳，出接口按 Muse 口径转 ISO 字符串（无 key 时为 null）。
  let apiKeyUpdatedAt = null
  if (typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw)) {
    const d = new Date(updatedAtRaw)
    apiKeyUpdatedAt = Number.isNaN(d.getTime()) ? null : d.toISOString()
  } else if (typeof updatedAtRaw === 'string' && updatedAtRaw) {
    const parsed = Date.parse(updatedAtRaw)
    apiKeyUpdatedAt = Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  return {
    apiBaseUrl,
    apiModel,
    apiKeySet: Boolean(row.image_api_key),
    apiKeyUpdatedAt,
    preferredBackend: row.preferred_image_backend ?? 'muse',
    effectiveBaseUrl: apiBaseUrl.trim() || DEFAULT_IMAGE_API_BASE_URL,
    effectiveModel: apiModel.trim() || DEFAULT_IMAGE_API_MODEL,
  }
}

export async function generateImage(input, deps = {}) {
  const store = deps.store ?? null
  const imageGen = deps.imageGen ?? null
  const prompt = String(input?.prompt ?? '').trim()
  const backend = input?.backend
  if (!prompt || prompt.length > 500) {
    return { ok: false, reason: 'muse_error', message: '生图提示词必填，1–500 字。', assetId: null }
  }
  if (!IMAGE_GEN_BACKENDS.includes(backend)) {
    return { ok: false, reason: 'muse_error', message: '生图后端只能是 muse、dsh 或 api。', assetId: null }
  }

  const storeAsset = (name, blobKey, mimeType, sizeBytes) => {
    if (!store) return null
    const asset = store.createAsset({
      name,
      relative_path: name,
      folder_label: 'AI 生图',
      mime_type: mimeType,
      size_bytes: sizeBytes,
      blob_key: blobKey,
    })
    return asset?.id ?? null
  }
  const assetName = () =>
    `AI生图-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.png`

  // muse / dsh：走宿主生图能力（注入的 imageGen）。
  if (backend === 'muse' || backend === 'dsh') {
    if (!imageGen?.generate) {
      return backend === 'dsh'
        ? {
            ok: false,
            reason: 'dsh_unavailable',
            message:
              'DSH 生图后端现在用不了：宿主没有提供生图通道。这次没有生成图片，请改选 Muse 或 API 后端，或在账号管理里填好 API Key 后用 API 后端。',
            assetId: null,
          }
        : {
            ok: false,
            reason: 'muse_error',
            message:
              'Muse 生图后端现在用不了：宿主没有提供生图通道。这次没有生成图片，请改选 API 后端，或在账号管理里填好 API Key 后用 API 后端。',
            assetId: null,
          }
    }
    try {
      const media = await imageGen.generate({
        prompt: `为一篇小红书图文笔记生成的配图插画（不是照片，是插画风格）：${prompt}`,
        backend,
      })
      const buffer = media?.buffer ?? media?.bytes ?? null
      if (!buffer || buffer.length === 0) {
        return {
          ok: false,
          reason: backend === 'dsh' ? 'dsh_unavailable' : 'muse_error',
          message: '生图后端没有返回图片数据。这次没有生成图片，可以稍后再试。',
          assetId: null,
        }
      }
      const mimeType = media?.mimeType ?? media?.contentType ?? 'image/png'
      const blobKey = `assets/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      store?.saveBlobFile(blobKey, Buffer.from(buffer))
      const assetId = storeAsset(assetName(), blobKey, mimeType, Buffer.from(buffer).length)
      return {
        ok: true,
        reason: 'none',
        message: `已用${backend === 'dsh' ? ' DSH' : ' Muse'}生成图片，并加到参考附图里。`,
        assetId,
      }
    } catch (e) {
      return {
        ok: false,
        reason: backend === 'dsh' ? 'dsh_unavailable' : 'muse_error',
        message: `${backend === 'dsh' ? 'DSH' : 'Muse'} 生图这次没有成功：${e instanceof Error ? e.message : String(e)}。没有生成图片，可以稍后再试。`,
        assetId: null,
      }
    }
  }

  // backend === 'api'：OpenAI 兼容接口。
  const settings = store ? store.getSettings() : null
  const apiKey = settings?.image_api_key ?? ''
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no_key',
      message:
        '还没有填写生图 API 的 Key，所以 API 后端现在生成不了图片。去「账号管理」里的「生图 API」填上接口地址和 Key 再回来生成；也可以先改用 Muse 后端。',
      assetId: null,
    }
  }
  const baseUrl = String(settings?.image_api_base_url ?? '').replace(/\/+$/, '') || DEFAULT_IMAGE_API_BASE_URL
  const model = String(settings?.image_api_model ?? '').trim() || DEFAULT_IMAGE_API_MODEL
  try {
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      return {
        ok: false,
        reason: 'api_error',
        message: `生图 API 返回了错误（HTTP ${res.status}）${detail ? `：${detail}` : ''}。没有生成图片，请检查账号管理里填的接口地址、模型和 Key。`,
        assetId: null,
      }
    }
    const payload = await res.json()
    const first = payload?.data?.[0]
    let bytes = null
    let mimeType = 'image/png'
    if (first?.b64_json) {
      bytes = Buffer.from(first.b64_json, 'base64')
    } else if (first?.url) {
      const imgRes = await fetch(first.url, { signal: AbortSignal.timeout(60_000) })
      if (!imgRes.ok) throw new Error(`下载生成的图片失败（HTTP ${imgRes.status}）`)
      mimeType = imgRes.headers.get('content-type') ?? 'image/png'
      bytes = Buffer.from(await imgRes.arrayBuffer())
    }
    if (!bytes || bytes.length === 0) {
      return {
        ok: false,
        reason: 'api_error',
        message: '生图 API 没有返回图片数据。这次没有生成图片，请检查接口地址和模型是否支持生图。',
        assetId: null,
      }
    }
    const blobKey = `assets/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    store?.saveBlobFile(blobKey, bytes)
    const assetId = storeAsset(assetName(), blobKey, mimeType, bytes.length)
    return { ok: true, reason: 'none', message: '已用 API 生成图片，并加到参考附图里。', assetId }
  } catch (e) {
    return {
      ok: false,
      reason: 'api_error',
      message: `调用生图 API 失败：${e instanceof Error ? e.message : String(e)}。没有生成图片，请检查接口地址是否可达、Key 是否有效。`,
      assetId: null,
    }
  }
}

export async function testImageGenApi(store) {
  const settings = store.getSettings()
  const apiKey = settings?.image_api_key ?? ''
  if (!apiKey) {
    return {
      ok: false,
      message: '还没有保存生图 API 的 Key，测不了：先在「生图 API」里填上 Key 并保存，再回来测试连接。',
    }
  }
  const baseUrl = String(settings?.image_api_base_url ?? '').replace(/\/+$/, '') || DEFAULT_IMAGE_API_BASE_URL
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      return {
        ok: true,
        message: `连接正常：接口 ${baseUrl} 能打开，保存的 Key 被接受。生图时将用模型「${String(settings?.image_api_model ?? '').trim() || DEFAULT_IMAGE_API_MODEL}」调用这个接口。`,
      }
    }
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    return {
      ok: false,
      message:
        res.status === 401 || res.status === 403
          ? `接口拒绝了这个 Key（HTTP ${res.status}）：Key 可能填错、已失效或没有权限。换一个 Key 保存后再测。${detail ? `接口原话：${detail}` : ''}`
          : `接口返回了错误（HTTP ${res.status}）${detail ? `：${detail}` : ''}。请检查接口地址是否填对（要填到 /v1 这一层）。`,
    }
  } catch (e) {
    return {
      ok: false,
      message: `连接不上接口 ${baseUrl}：${e instanceof Error ? e.message : String(e)}。请检查接口地址是否可达、是否填对。`,
    }
  }
}
