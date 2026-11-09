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
// imageIdsJson，captions 按位置从返回数组取、缺失补 ''；
// imageCaptions 数组本身不截断不补齐。
//
// 模型服务由调用方注入（deps.llm）；未注入时返回 MODEL_NOT_AVAILABLE。

export const SYSTEM_PROMPT =
  '你是一位资深小红书内容运营，擅长写自然、口语化、有真实分享感的图文笔记。不要夸大其词，不要编造具体价格、品牌功效数据或不存在的经历细节；信息不足时写成通用经验分享。'

export const MODEL_NOT_AVAILABLE = 'MODEL_NOT_AVAILABLE'

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

/** 提示词拼接：主题、风格、关键词、参考图片文件名列表四部分。 */
export function buildUserPrompt({ topic, keywords, style, imageNames }) {
  let prompt = `主题：${topic}\n风格：${style}`
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
  const style = String(input?.style ?? '').trim() || '种草测评'
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
  const mountedAssetIds = images
    .filter((image) => image?.assetId != null)
    .map((image) => image.assetId)
  // captions 按位置从返回数组取、缺失补 ''；imageCaptions 数组本身不截断不补齐。
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
      image_captions_json: JSON.stringify(imageCaptions),
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
          imageCaptions,
        }
      : null,
  }
}
