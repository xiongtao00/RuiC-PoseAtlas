import { makeCatalog, roles } from './character-catalog.js';

const get = id => document.getElementById(id);
const form = get('generator');
const dialog = get('picker');
const search = get('search');
const status = get('status');
const tiles = get('tiles');
const selections = new Map();
const pickerScroll = get('picker-scroll');
const pickerEnd = get('picker-end');
const pickerStatus = get('picker-status');
const batchSize = 36;
const presetRoles = ['pose', 'outfit', 'person'];
let catalogPromise;
let activeRole;
let matches = [];
let shown = 0;
let renderVersion = 0;

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

function select(role, selection) {
  const previous = selections.get(role);
  if (previous?.file) URL.revokeObjectURL(previous.thumb);
  if (selection) selections.set(role, selection);
  else selections.delete(role);
  renderReferences();
}

function iconButton(icon, label, action) {
  const control = button('', action);
  control.className = 'icon-button';
  control.title = label;
  control.setAttribute('aria-label', label);
  control.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
  return control;
}

const icons = {
  gallery: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1"/><path d="m3 17 5-4 4 3 4-5 5 6"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>',
  remove: '<path d="m7 7 10 10M17 7 7 17"/>',
};

function renderReferences() {
  get('references').replaceChildren(...Object.entries(roles).map(([role, label]) => {
    const card = document.createElement('div');
    card.className = 'reference';
    const selection = selections.get(role);
    const thumbnail = document.createElement('div');
    thumbnail.className = 'reference-thumbnail';
    if (selection) {
      const image = document.createElement('img');
      image.src = selection.thumb;
      image.alt = selection.label;
      thumbnail.append(image);
      card.title = selection.label;
    } else {
      thumbnail.textContent = '＋';
      thumbnail.setAttribute('aria-hidden', 'true');
    }
    const title = document.createElement('strong');
    title.textContent = label;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = 'image/png,image/jpeg,image/webp';
    upload.hidden = true;
    upload.addEventListener('change', () => {
      const file = upload.files[0];
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        status.textContent = `${label}请使用 10 MB 以内的 PNG、JPEG 或 WebP 图片。`;
        upload.value = '';
        return;
      }
      status.textContent = '';
      select(role, { file, label: file.name, thumb: URL.createObjectURL(file) });
    });
    if (presetRoles.includes(role)) {
      actions.append(iconButton(icons.gallery, `浏览${label}预设`, () => browse(role)));
    }
    actions.append(iconButton(icons.upload, `上传${label}图`, () => upload.click()), upload);
    if (selection) actions.append(iconButton(icons.remove, `移除${label}图`, () => select(role)));
    card.append(thumbnail, title, actions);
    return card;
  }));
}

function loadCatalog() {
  catalogPromise ??= Promise.all(['poses', 'costumes', 'faces'].map(async name => {
    const response = await fetch(`data/${name}.json`);
    if (!response.ok) throw new Error('Catalog unavailable');
    return response.json();
  })).then(data => makeCatalog(...data)).catch(error => {
    catalogPromise = undefined;
    throw error;
  });
  return catalogPromise;
}

const cardSizes = new ResizeObserver(entries => {
  for (const { target } of entries) {
    target.parentElement.style.gridRowEnd = `span ${Math.ceil(target.getBoundingClientRect().height + 8)}`;
  }
});

function appendTiles() {
  if (!dialog.open || shown >= matches.length) return;
  const role = activeRole;
  const batch = matches.slice(shown, shown + batchSize);
  for (const item of batch) {
    const wrapper = document.createElement('div');
    const card = button(item.label, () => {
      select(role, item);
      dialog.close();
    });
    const image = document.createElement('img');
    image.src = item.thumb;
    image.alt = '';
    image.loading = 'lazy';
    card.prepend(image);
    wrapper.append(card);
    tiles.append(wrapper);
    cardSizes.observe(card);
  }
  shown += batch.length;
  pickerStatus.textContent = `已显示 ${shown} / ${matches.length} 张`;
  moreTiles.unobserve(pickerEnd);
  if (shown < matches.length) moreTiles.observe(pickerEnd);
}

const moreTiles = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) appendTiles();
}, { root: pickerScroll, rootMargin: '0px 0px 320px' });

function resetTiles() {
  cardSizes.disconnect();
  moreTiles.unobserve(pickerEnd);
  tiles.replaceChildren();
  pickerScroll.scrollTop = 0;
  matches = [];
  shown = 0;
}

async function renderTiles() {
  const version = ++renderVersion;
  resetTiles();
  pickerStatus.textContent = '正在载入素材…';
  try {
    const catalog = await loadCatalog();
    if (version !== renderVersion || !dialog.open) return;
    const query = search.value.trim().toLowerCase();
    matches = catalog[activeRole].filter(item =>
      `${item.label} ${item.id} ${item.keywords || ''}`.toLowerCase().includes(query)
    );
    if (matches.length) appendTiles();
    else pickerStatus.textContent = '没有匹配的素材';
  } catch {
    if (version === renderVersion && dialog.open) pickerStatus.textContent = '素材加载失败。关闭后可重新打开重试。';
  }
}

function browse(role) {
  activeRole = role;
  search.value = '';
  get('picker-title').textContent = `选择${roles[role]}参考`;
  dialog.showModal();
  renderTiles();
}

search.addEventListener('input', renderTiles);
dialog.addEventListener('close', resetTiles);

async function promptReference(item) {
  const image = new Image();
  image.src = item.thumb;
  await image.decode();
  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

const completePrompt = get('complete-prompt');
completePrompt.addEventListener('click', async () => {
  const field = get('prompt');
  const original = field.value;
  const references = Object.fromEntries(selections);
  completePrompt.disabled = true;
  completePrompt.textContent = '生成中…';
  try {
    const response = await fetch('/api/character/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: original,
        references: Object.fromEntries(await Promise.all(Object.entries(references).map(async ([role, item]) =>
          [role, await promptReference(item)]
        ))),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '生成提示词失败。');
    if (field.value !== original || selections.size !== Object.keys(references).length ||
        Object.entries(references).some(([role, item]) => selections.get(role) !== item)) {
      status.textContent = '提示词或参考图已变更，请重新生成。';
      return;
    }
    field.value = data.prompt;
    status.textContent = '已生成新的提示词，可继续编辑。';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    completePrompt.disabled = false;
    completePrompt.textContent = '生成提示词';
  }
});

let resultUrl;
form.addEventListener('submit', async event => {
  event.preventDefault();
  const generate = get('generate');
  if (generate.disabled) return;
  const body = new FormData(form);
  if (!body.get('prompt').trim() && !selections.size) {
    status.textContent = '请输入提示词或添加参考图。';
    get('prompt').focus();
    return;
  }
  for (const [role, selection] of selections) {
    if (selection.file) body.set(role, selection.file);
    else body.set(role + '_preset', selection.id);
  }
  generate.disabled = true;
  generate.textContent = '生成中…';
  status.textContent = '正在生成角色图，请稍候。';
  try {
    const response = await fetch('/api/character', { method: 'POST', body });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || '生成失败。请确认已启动角色生成服务后重试。');
    }
    const image = await response.blob();
    if (!image.type.startsWith('image/')) throw new Error('服务未返回有效图片。');
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(image);
    get('result').src = resultUrl;
    get('result').hidden = false;
    get('placeholder').hidden = true;
    status.textContent = '生成完成。';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    generate.disabled = false;
    generate.textContent = '生成角色图';
  }
});

renderReferences();
