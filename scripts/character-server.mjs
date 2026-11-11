import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import { makeCatalog, roles } from '../assets/js/character-catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  loadEnvFile(resolve(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const catalog = makeCatalog(...await Promise.all(['poses', 'costumes', 'faces'].map(async name =>
  JSON.parse(await readFile(resolve(root, 'data', name + '.json'), 'utf8'))
)));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const maxImage = 10 * 1024 * 1024;
const guidance = {
  pose: 'Use only this image for pose, gesture, camera angle and framing.',
  outfit: 'Use only this image for clothing and accessories.',
  person: 'Use only this image for facial identity and visible facial features.',
  body: 'Use only this image for physique and body proportions.',
  background: 'Use only this image for the environment and background.',
};

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return '.jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

async function readLimited(stream, limit, message) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw new RequestError(message, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function presetBytes(role, id) {
  const item = catalog[role]?.find(entry => entry.id === id);
  if (!item) throw new RequestError(`${roles[role]}预设不存在。`);
  try {
    return await readLimited(createReadStream(resolve(root, item.full)), maxImage, '预设图片过大。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!item.remote) throw new RequestError(`${roles[role]}预设原图不可用，请替换。`);
    try {
      const upstream = await fetch(item.remote, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!upstream.ok) throw new Error('Portrait download failed');
      const bytes = await readLimited(upstream.body, maxImage, '预设图片过大。');
      if (imageType(bytes)) return bytes;
    } catch {
      // The portrait catalog includes a local thumbnail for offline use.
    }
    try {
      return await readLimited(createReadStream(resolve(root, item.thumb)), maxImage, '预设图片过大。');
    } catch {
      throw new RequestError('长相预设暂时不可用，请更换预设或上传图片。', 502);
    }
  }
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new RequestError('请求来源无效。', 403);
}

function wetokenConfig() {
  const key = process.env.WETOKEN_API_KEY;
  if (!key) throw new RequestError('请在服务端 .env 中配置 WETOKEN_API_KEY。', 503);
  return {
    base: (process.env.WETOKEN_BASE_URL || 'https://www.wetoken.top').replace(/\/+$/, ''),
    headers: { Authorization: `Bearer ${key}` },
  };
}

async function completePrompt(req, res) {
  checkOrigin(req);
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError('请求格式无效。');
  const raw = await readLimited(req.iterator({ destroyOnReturn: false }), 2 * 1024 * 1024, '参考图数据过大。');
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new RequestError('无法读取提示词。');
  }
  const prompt = input?.prompt;
  const references = input?.references;
  if (typeof prompt !== 'string' || prompt.length > 4000 ||
      !references || typeof references !== 'object' || Array.isArray(references)) {
    throw new RequestError('提示词或参考图格式无效。');
  }
  const missing = Object.keys(roles).filter(role => !Object.hasOwn(references, role));
  if (!prompt.trim() && !Object.keys(references).length) throw new RequestError('请先输入提示词或添加参考图。');

  const content = [{
    type: 'text',
    text: `已有创作要求：${prompt}\n缺少参考图的方面：${missing.map(role => roles[role]).join('、') || '无'}。`,
  }];
  for (const [role, url] of Object.entries(references)) {
    if (!Object.hasOwn(roles, role) || typeof url !== 'string' ||
        url.length > 380000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
      throw new RequestError('参考图格式无效。');
    }
    content.push({ type: 'text', text: `以下是${roles[role]}参考图。` },
      { type: 'image_url', image_url: { url } });
  }

  const { base, headers } = wetokenConfig();
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.WETOKEN_DEEPSEEK_MODEL || 'deepseek-v4-pro',
        messages: [
          { role: 'system', content: '根据参考图和已有创作要求写一条完整、可直接用于角色生图的新提示词。保留用户的明确要求，补充缺少参考图的方面，让这些细节与参考图协调。只输出最终提示词，语言与已有创作要求一致，默认中文。' },
          { role: 'user', content },
        ],
      }),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RequestError(`DeepSeek 生成提示词失败（HTTP ${response.status}）。`, 502);
    }
    const data = await response.json();
    const generated = data.choices?.[0]?.message?.content?.trim();
    if (!generated) throw new RequestError('DeepSeek 没有返回可用的描述。', 502);
    if (generated.length > 4000) throw new RequestError('生成的提示词超过 4000 字符，请重试。', 502);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ prompt: generated }));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error.name === 'TimeoutError') throw new RequestError('生成提示词超时，请重试。', 504);
    throw new RequestError('无法从 DeepSeek 获取新提示词，请重试。', 502);
  }
}

async function imageRequestError(response) {
  const payload = await response.json().catch(() => null);
  const detail = payload?.error ?? payload;
  const message = typeof detail === 'string' ? detail : detail?.message;
  if (response.status === 400 && typeof message === 'string' &&
      /rejected by the safety system/i.test(message)) {
    return {
      sizeRejected: false,
      error: new RequestError('WeToken 内容审核拒绝了这次生成。请检查提示词和参考图。如果认为是误判，请联系 WeToken 支持。', 422),
    };
  }
  const sizeRejected = response.status === 400 && (
    detail?.param === 'size' || detail?.code === 'invalid_size' ||
    /(?:invalid|unsupported|allowed|must be).{0,40}\bsize\b|\bsize\b.{0,40}(?:invalid|unsupported|allowed|must be)/i.test(message || '')
  );
  const safeMessage = typeof message === 'string'
    ? message.replaceAll(process.env.WETOKEN_API_KEY, '[已隐藏]')
      .replace(/(?:https?:\/\/|data:)[^\s"'<>]+/gi, '[已隐藏]').replace(/\s+/g, ' ').trim().slice(0, 300)
    : '';
  const prefix = `WeToken 生成失败（HTTP ${response.status}）。`;
  return { sizeRejected, error: new RequestError(prefix + (safeMessage || '接口未提供具体原因。'), 502) };
}

async function generate(req, res) {
  checkOrigin(req);
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data;')) throw new RequestError('请求格式无效。');
  const raw = await readLimited(req.iterator({ destroyOnReturn: false }), 5 * maxImage + 65536, '上传总大小超出限制。');
  const input = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData()
    .catch(() => { throw new RequestError('无法读取上传内容。'); });
  const prompt = input.get('prompt');
  if (typeof prompt !== 'string' || prompt.length > 4000) throw new RequestError('提示词不能超过 4000 字符。');
  const { base, headers } = wetokenConfig();

  const files = new FormData();
  const notes = [];
  for (const role of Object.keys(roles)) {
    const upload = input.get(role);
    const id = input.get(role + '_preset');
    if (upload === null && id === null) continue;
    if ((upload !== null && (typeof upload === 'string' || id !== null)) ||
        (id !== null && typeof id !== 'string')) throw new RequestError(`${roles[role]}参考格式无效。`);
    if (upload?.size > maxImage) throw new RequestError(`${roles[role]}图片不能超过 10 MB。`, 413);
    const bytes = upload ? Buffer.from(await upload.arrayBuffer()) : await presetBytes(role, id);
    const extension = imageType(bytes);
    if (!extension) throw new RequestError(`${roles[role]}图片必须为 PNG、JPEG 或 WebP。`);
    const name = role + '_image' + extension;
    files.append('image[]', new Blob([bytes], { type: types[extension] }), name);
    notes.push(`Image ${notes.length + 1} (${name}): ${guidance[role]}`);
  }

  if (!prompt.trim() && !notes.length) throw new RequestError('请输入提示词或添加参考图。');
  const model = process.env.WETOKEN_IMAGE_MODEL || 'gpt-image-2';
  const configuredSize = process.env.WETOKEN_IMAGE_SIZE || '';
  const [width, height] = configuredSize.split('x').map(Number);
  const size = configuredSize === '9:16' || (/^[1-9]\d*x[1-9]\d*$/.test(configuredSize) &&
    width * 16 === height * 9) ? configuredSize : '1152x2048';
  const endpoint = notes.length ? 'edits' : 'generations';
  const framing = 'Compose the image vertically in a 9:16 aspect ratio.';
  if (notes.length) {
    files.set('model', model);
    files.set('prompt', [
      framing,
      'Generate one character image. Keep the reference roles independent and use natural anatomy.',
      ...notes,
      prompt.trim(),
    ].join('\n'));
  } else {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const signal = AbortSignal.timeout(300000);
    const send = requestedSize => {
      if (notes.length) files.set('size', requestedSize);
      const body = notes.length ? files : JSON.stringify({
        model, size: requestedSize, prompt: `${framing}\n${prompt.trim()}`, n: 1,
      });
      return fetch(`${base}/v1/images/${endpoint}`, {
        method: 'POST', headers, body, signal, redirect: 'error',
      });
    };
    let response = await send(size);
    let failure = response.ok ? null : await imageRequestError(response);
    if (failure?.sizeRejected) {
      response = await send(size === '9:16' ? '1152x2048' : '9:16');
      failure = response.ok ? null : await imageRequestError(response);
    }
    if (failure) throw failure.error;
    const { data } = await response.json();
    const result = data?.[0];
    let bytes;
    if (result?.b64_json) {
      bytes = Buffer.from(result.b64_json, 'base64');
    } else if (result?.url) {
      const url = new URL(result.url);
      if (url.protocol !== 'https:') throw new Error('Invalid image URL');
      const image = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!image.ok) throw new Error('Image download failed');
      bytes = await readLimited(image.body, 30 * 1024 * 1024, '生成图片过大。');
    }
    const extension = bytes && imageType(bytes);
    if (!extension) throw new Error('Invalid image response');
    res.writeHead(200, { 'Content-Type': types[extension], 'Cache-Control': 'no-store' }).end(bytes);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error.name === 'TimeoutError') throw new RequestError('生成或下载超时，请重试。', 504);
    throw new RequestError('无法从 WeToken 获取生成图片，请重试。', 502);
  }
}

const port = Number(process.env.CHARACTER_PORT || 8124);
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw new RequestError('主机无效。', 403);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && path === '/api/character') return await generate(req, res);
    if (req.method === 'POST' && path === '/api/character/prompt') return await completePrompt(req, res);
    const file = path === '/' ? '/index.html' : path;
    const isPublic = /^\/(?:[\w-]+\.html|og-cover\.jpg|(?:assets|data|img|thumbs|costume|portrait\/thumbs)\/[\w/.-]+)$/.test(file);
    const type = types[extname(file)];
    if (!['GET', 'HEAD'].includes(req.method) || !isPublic || !type || file.includes('..')) {
      throw new RequestError('页面不存在。', 404);
    }
    const absolute = resolve(root, '.' + file);
    const info = await stat(absolute);
    if (!info.isFile()) throw new RequestError('文件不存在。', 404);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(absolute).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
    const message = error.status ? error.message : status === 404 ? '文件不存在。' : '服务器处理失败。';
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: message }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/character.html`));
