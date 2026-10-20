import type { AutoTagPrompts } from '@/state/settings';

/**
 * 提示词预设:把「破限 / 规范 / 思维链」五个槽位打包成一份具名快照,可导入、导出、切换。
 *
 * 为什么是「快照」而不是「引用世界书」:
 * 槽位是**固定拼装顺序、无条件生效、不做宏替换**的纯文本(autoTag/prompt.ts),
 * 而世界书是关键词激活 + 位置/深度可配的条目集。直接读世界书会引入激活语义、
 * ST 宏与 EJS 残留,还会让同一份规则在「这本书挂没挂」之间漂移。
 * 快照导入后即与来源脱钩:可编辑、可回退、可分享,行为可复现。
 *
 * 唯一生效源仍是 settings.autoTag.prompts —— 切换预设 = 把快照写进去。
 * 因此 prompt.ts 一行都不用改,不存在「预设与槽位两份真相」。
 */

export const PROMPT_PRESET_KIND = 'bbi-prompt-preset';
export const PROMPT_PRESET_SCHEMA = 1;

/** 文件里允许出现的槽位:与设置页「自定义提示词」列出的五条一一对应。 */
export const PRESET_PROMPT_KEYS = [
  'jailbreak',
  'comfySpec',
  'comfyThinking',
  'naiV5Spec',
  'naiV5Thinking',
] as const;
export type PresetPromptKey = (typeof PRESET_PROMPT_KEYS)[number];

/** 内部存储要覆盖全部七键(naiSpec / naiThinking 已下线,保留键位以便与设置同构)。 */
const ALL_PROMPT_KEYS = [
  'jailbreak',
  'naiSpec',
  'naiV5Spec',
  'comfySpec',
  'comfyThinking',
  'naiThinking',
  'naiV5Thinking',
] as const;

export type PresetBackend = 'comfyui' | 'nai';

export interface PromptPreset {
  id: string;
  /** 显示名,允许重名(以 id 为键)。 */
  name: string;
  /** 这份预设按哪个后端的口径写;与当前默认后端不一致时不会生效,UI 需提示。 */
  backend: PresetBackend;
  /** 七键全量快照,未使用的槽位为空串。 */
  prompts: AutoTagPrompts;
  /** 来源标识(书名 / 文档名),便于回溯;可空。 */
  basedOn: string;
  /** 导入文件里的不确定项说明;可空。 */
  notes: string[];
  createdAt: string;
}

/** 单槽位字符上限:超过这个量几乎必然是把整本书塞了进来。 */
export const MAX_SLOT_CHARS = 12000;
/** 预设数量上限,防止导入循环把设置撑爆(设置随 extension_settings 同步)。 */
export const MAX_PRESETS = 50;

const BACKEND_LABEL: Record<PresetBackend, string> = { comfyui: 'ComfyUI', nai: 'NAI' };

export function presetBackendLabel(b: PresetBackend): string {
  return BACKEND_LABEL[b] ?? 'ComfyUI';
}

export function emptyPrompts(): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
  };
}

/** 逐键兜底成字符串;非对象一律当空。 */
export function normalizePresetPrompts(raw: unknown): AutoTagPrompts {
  const out = emptyPrompts();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const k of ALL_PROMPT_KEYS) {
    const v = o[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

let presetSeq = 0;
/** 预设 id:时间戳 + 进程内序号,避免同一毫秒批量导入时撞号。 */
export function newPresetId(): string {
  presetSeq += 1;
  return `pp_${Date.now().toString(36)}_${presetSeq}`;
}

/** 数组兜底:丢掉无名条目、修掉重复 id、截断到上限。 */
export function normalizePromptPresets(raw: unknown): PromptPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : '';
    if (!name) continue;
    let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newPresetId();
    if (seen.has(id)) id = newPresetId();
    seen.add(id);
    out.push({
      id,
      name,
      backend: o.backend === 'nai' ? 'nai' : 'comfyui',
      prompts: normalizePresetPrompts(o.prompts),
      basedOn: typeof o.basedOn === 'string' ? o.basedOn : '',
      notes: Array.isArray(o.notes)
        ? o.notes.filter((n): n is string => typeof n === 'string').slice(0, 20)
        : [],
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/** 两组提示词是否完全一致(用于「已修改未保存」判定)。 */
export function promptsEqual(a: Partial<AutoTagPrompts>, b: Partial<AutoTagPrompts>): boolean {
  return ALL_PROMPT_KEYS.every(k => (a[k] ?? '') === (b[k] ?? ''));
}

export function hasAnyPrompt(p: Partial<AutoTagPrompts>): boolean {
  return PRESET_PROMPT_KEYS.some(k => (p[k] ?? '').trim().length > 0);
}

/* —— 校验 —— */

/** 这些内容一旦进了槽位就会被字面发给模型(槽位不做宏替换),或直接破坏协议。 */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\{\{\s*user\s*\}\}/i, why: '含 ST 宏 {{user}}(槽位不做宏替换,会原样发给模型)' },
  { re: /\{\{\s*char\s*\}\}/i, why: '含 ST 宏 {{char}}(同上)' },
  { re: /\{\{\s*(get|set)var/i, why: '含 ST 变量宏(同上)' },
  { re: /<%/, why: '含 EJS 片段(不会被求值)' },
  { re: /<START>/i, why: '含世界书分隔标记 <START>' },
];

/**
 * 块协议标记。这类词在「禁止输出 X」的句子里出现是**正常且必要**的
 * (内置思维链就有一句「不得包含 <bbi_image> 标签」),所以按行判断:
 * 同一行带否定词的放过,只拦「要求模型输出」的那种。
 */
const BLOCK_PROTOCOL: { re: RegExp; why: string }[] = [
  { re: /image###/gi, why: '要求输出 image### 块(那是主模型侧写法)' },
  { re: /<\/?shot\b/gi, why: '要求输出 <shot> 分镜标记' },
  { re: /<\/?ledger\b/gi, why: '要求输出 <ledger> 账本标记' },
  { re: /<bbi_image>/gi, why: '要求输出 <bbi_image> 内部标签' },
];

const NEGATION = /(禁止|不得|不要|不写|不可|勿|never|do not|don't|avoid)/i;
/** 出现这些动词 = 在要求模型输出,而不是在描述/排除它。 */
const INSTRUCTION = /(输出|写入|返回|给出|加上|追加|append|emit|output|write|return)/i;

/**
 * 返回第一个「要求输出块协议」的说明;只是提到(否定句、历史引用)则返回 null。
 *
 * 判定两条:① 该标记出现在行首(典型是模板排版);② 同一行有输出类动词且无否定词。
 * 内置思维链里的「历史 <bbi_image> 只作连续性线索」两条都不满足,故放过。
 */
function findBlockProtocol(text: string): string | null {
  for (const f of BLOCK_PROTOCOL) {
    for (const m of text.matchAll(f.re)) {
      const at = m.index ?? 0;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      const lineEnd = text.indexOf('\n', at);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
      const atLineHead = line.trimStart().startsWith(m[0]);
      const instructing = INSTRUCTION.test(line) && !NEGATION.test(line);
      if (atLineHead || instructing) return f.why;
    }
  }
  return null;
}

/**
 * 自然语言条件段配对检查。解析端用非贪婪正则匹配 `{{#nl}}…{{/nl}}`,
 * 所以不成对、嵌套、顺序颠倒都会静默吞掉半段文本 —— 必须在导入时拦下。
 */
export function checkNlSections(text: string): string | null {
  const opens = (text.match(/\{\{[#^]nl\}\}/g) ?? []).length;
  const closes = (text.match(/\{\{\/nl\}\}/g) ?? []).length;
  if (opens !== closes) return `自然语言条件段不成对(${opens} 个开头 / ${closes} 个结尾)`;
  let depth = 0;
  for (const m of text.matchAll(/\{\{[#^]nl\}\}|\{\{\/nl\}\}/g)) {
    if (m[0] === '{{/nl}}') {
      depth -= 1;
      if (depth < 0) return '自然语言条件段顺序错误:出现了多余的 {{/nl}}';
    } else {
      depth += 1;
      if (depth > 1) return '自然语言条件段不支持嵌套';
    }
  }
  return null;
}

export type PresetParseResult = { ok: true; preset: PromptPreset } | { ok: false; error: string };

/**
 * 解析并校验导入文件。任何一条不过都整体拒绝 —— 提示词是「每楼都发」的东西,
 * 放一份半坏的进去,错误会以「出图变差」的形式缓慢显现,比直接报错难查得多。
 */
export function parsePromptPresetFile(text: string): PresetParseResult {
  if (text.length > 2_000_000) {
    return { ok: false, error: '文件超过 2 MB,不像是提示词预设。' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON。' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '文件内容不是 JSON 对象。' };
  }
  const o = raw as Record<string, unknown>;
  if (o.app === 'baibai-image') {
    return { ok: false, error: '这是柏宝绘的配置备份文件,请到「配置导入导出」里导入。' };
  }
  if (o.kind !== PROMPT_PRESET_KIND) {
    return { ok: false, error: '文件类型不是提示词预设(kind 不匹配)。' };
  }
  const schema = typeof o.schemaVersion === 'number' ? o.schemaVersion : 0;
  if (schema !== PROMPT_PRESET_SCHEMA) {
    return {
      ok: false,
      error:
        schema > PROMPT_PRESET_SCHEMA
          ? `预设版本 v${schema} 高于当前插件支持的 v${PROMPT_PRESET_SCHEMA},请先更新插件。`
          : '缺少 schemaVersion,或版本号无效。',
    };
  }
  if (o.backend !== 'comfyui' && o.backend !== 'nai') {
    return { ok: false, error: 'backend 只能是 "comfyui" 或 "nai"。' };
  }
  const backend: PresetBackend = o.backend;
  if (!o.prompts || typeof o.prompts !== 'object' || Array.isArray(o.prompts)) {
    return { ok: false, error: '缺少 prompts 段。' };
  }

  const issues: string[] = [];
  const prompts = emptyPrompts();
  for (const [k, v] of Object.entries(o.prompts as Record<string, unknown>)) {
    if (!(PRESET_PROMPT_KEYS as readonly string[]).includes(k)) {
      issues.push(`未知槽位「${k}」`);
      continue;
    }
    if (typeof v !== 'string') {
      issues.push(`槽位「${k}」不是字符串`);
      continue;
    }
    const val = v.replace(/\r\n/g, '\n');
    if (val.length > MAX_SLOT_CHARS) {
      issues.push(`槽位「${k}」超长(${val.length} 字符,上限 ${MAX_SLOT_CHARS})`);
    }
    for (const f of FORBIDDEN) {
      if (f.re.test(val)) issues.push(`槽位「${k}」${f.why}`);
    }
    const blockIssue = findBlockProtocol(val);
    if (blockIssue) issues.push(`槽位「${k}」${blockIssue}`);
    const nlErr = checkNlSections(val);
    if (nlErr) issues.push(`槽位「${k}」${nlErr}`);
    const nlMacro = (val.match(/\{\{nl\}\}/g) ?? []).length;
    if (nlMacro > 0 && k !== 'comfySpec') {
      issues.push(`槽位「${k}」出现 {{nl}} 宏(只允许出现在 comfySpec)`);
    }
    if (nlMacro > 1) issues.push(`槽位「${k}」的 {{nl}} 宏出现 ${nlMacro} 次(最多 1 次)`);
    // 上面已用 PRESET_PROMPT_KEYS 校验过 k,这里直接按联合键写入(不再需要 as 断言)
    prompts[k as PresetPromptKey] = val;
  }

  if (!hasAnyPrompt(prompts)) {
    return { ok: false, error: '所有槽位都是空的,没有可导入的内容。' };
  }
  // 槽位与声明后端不匹配 → 导入后「看起来成功但完全不生效」,是最难查的失败,直接拦。
  const filled = PRESET_PROMPT_KEYS.filter(k => prompts[k].trim().length > 0);
  const comfyFilled = filled.some(k => k === 'comfySpec' || k === 'comfyThinking');
  const naiFilled = filled.some(k => k === 'naiV5Spec' || k === 'naiV5Thinking');
  if (backend === 'comfyui' && !comfyFilled) {
    issues.push('backend 为 comfyui,却没有填 comfySpec / comfyThinking');
  }
  if (backend === 'nai' && !naiFilled) {
    issues.push('backend 为 nai,却没有填 naiV5Spec / naiV5Thinking');
  }

  if (issues.length) {
    const head = issues.slice(0, 6).join('；');
    return { ok: false, error: issues.length > 6 ? `${head}；等 ${issues.length} 项问题` : head };
  }

  const name = (typeof o.name === 'string' ? o.name.trim() : '').slice(0, 40) || '导入预设';
  return {
    ok: true,
    preset: {
      id: newPresetId(),
      name,
      backend,
      prompts,
      basedOn: typeof o.basedOn === 'string' ? o.basedOn : '',
      notes: Array.isArray(o.notes)
        ? o.notes.filter((n): n is string => typeof n === 'string').slice(0, 20)
        : [],
      createdAt: new Date().toISOString(),
    },
  };
}

/** 组装可导出的文件对象(空槽位不写,保持文件可读)。 */
export function buildPromptPresetFile(p: PromptPreset): Record<string, unknown> {
  const prompts: Record<string, string> = {};
  for (const k of PRESET_PROMPT_KEYS) {
    const v = p.prompts[k] ?? '';
    if (v.trim()) prompts[k] = v;
  }
  return {
    schemaVersion: PROMPT_PRESET_SCHEMA,
    kind: PROMPT_PRESET_KIND,
    name: p.name,
    backend: p.backend,
    basedOn: p.basedOn,
    prompts,
    notes: p.notes,
  };
}

/** 确认弹窗里展示的槽位摘要,如「comfySpec 4120 字符」。 */
export function presetSlotSummary(p: PromptPreset): string {
  const parts = PRESET_PROMPT_KEYS.filter(k => (p.prompts[k] ?? '').trim()).map(
    k => `${k} ${p.prompts[k].length} 字符`,
  );
  return parts.length ? parts.join('、') : '(空)';
}
