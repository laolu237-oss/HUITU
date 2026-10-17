import type { ComfyLoraEntry } from '@/backends/comfyTemplates';
import type { CharTagEntry } from '@/state/charTags';

/**
 * 角色级 LoRA 动态挂载 + 「必须完整写入」词串补齐。
 *
 * 背景:
 * - 角色 LoRA(如「Anima角色\紫发美女」)只应在该角色出现在画面里时生效。以前只能把
 *   角色 LoRA 全挂在渠道里,同框角色互相污染;触发词也只能靠 AI 抄,而模型会把不认识的
 *   词(如 `adnim`)当噪声删掉——它不知道那是 LoRA 触发词。
 * - 整串模式与 LoRA 触发词串都是「一个字符都不能少」的外貌真源,不能交给模型自觉。
 *
 * 现在:绑定挂在角色条目上,出图前按「本图角色名」解析出该挂的 LoRA;必须完整的词串由
 * 插件用 ensureVerbatimItems **确定性补齐**(已出现的词不重复加,缺的补上),模型删不掉。
 *
 * 本模块只做纯计算:不读 settings、不读上下文,库条目与渠道 LoRA 都由调用方传入。
 */

export interface CharacterLoraResolution {
  /** 本图该挂的 LoRA(按角色名去重)。 */
  loras: ComfyLoraEntry[];
  /** 必须完整进入提示词的词串(每个在场 LoRA 角色一份,已去重)。 */
  sources: VerbatimSource[];
}

/** 一段「必须完整写入」的词串。 */
export interface VerbatimSource {
  /** 逗号分隔的词串;逐项检查是否已出现,缺的补上。 */
  text: string;
  /** true = 首个词是 LoRA 触发词,缺失时放到提示词最前面(而不是末尾)。 */
  prependFirst?: boolean;
}

/** 人数/独身类 tag:画面人数由本图 AI 决定,从来源里剔除,否则 1girl 会和 2girls 打架。 */
const COUNT_TAG = /^(?:solo|\d+\+?(?:girl|boy|other)s?|multiple (?:girls|boys|others))$/i;

function splitItems(text: string): string[] {
  return text
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean);
}

/** 词项归一:忽略大小写、下划线/空格差异,避免「long_hair」与「long hair」重复出现。 */
function normalizeItem(text: string): string {
  return text.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把「必须完整写入」的词串补齐进提示词。
 * - 已出现的词(忽略大小写/下划线/空白)不重复添加;
 * - 人数 tag(1girl/2boys/solo…)从来源里剔除:照搬会与本图人数冲突;
 * - prependFirst 的来源(LoRA 触发词)缺失时放到最前面,而不是末尾;
 * - **幂等**:对已补齐的结果再跑一次不会变化。
 */
export function ensureVerbatimItems(tag: string, sources: readonly VerbatimSource[]): string {
  if (!sources.length) return tag;
  const items = splitItems(tag);
  const present = new Set(items.map(normalizeItem));
  const prepend: string[] = [];
  for (const source of sources) {
    splitItems(source.text).forEach((item, index) => {
      if (COUNT_TAG.test(item)) return;
      const key = normalizeItem(item);
      if (!key || present.has(key)) return;
      present.add(key);
      if (index === 0 && source.prependFirst) prepend.push(item);
      else items.push(item);
    });
  }
  return [...prepend, ...items].join(', ');
}

/** 库里所有被角色绑定的 LoRA 名——用于把它们从渠道的固定列表里剔除。 */
export function collectBoundLoraNames(entries: readonly CharTagEntry[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.lora?.name?.trim();
    if (name) names.add(name);
  }
  return names;
}

/**
 * 按本图角色名解析 LoRA 与必须完整的词串。
 * 名字必须与库条目**逐字一致**(协议要求模型用库中原名),查不到的忽略;
 * 同一 LoRA 被多个角色绑定时只挂一次(取首次出现的强度)。
 */
export function resolveCharacterLoras(
  names: readonly string[],
  entries: readonly CharTagEntry[],
): CharacterLoraResolution {
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const loras: ComfyLoraEntry[] = [];
  const sources: VerbatimSource[] = [];
  const seenLora = new Set<string>();
  const seenSource = new Set<string>();
  for (const raw of names) {
    const entry = byName.get(raw.trim());
    const lora = entry?.lora;
    const name = lora?.name?.trim();
    if (!lora || !name) continue;
    if (!seenLora.has(name)) {
      seenLora.add(name);
      loras.push({ name, strength: lora.strength });
    }
    const trigger = lora.trigger.trim();
    if (trigger && !seenSource.has(trigger)) {
      seenSource.add(trigger);
      sources.push({ text: trigger, prependFirst: true });
    }
  }
  return { loras, sources };
}

/**
 * 合并渠道 LoRA 与本图角色 LoRA:
 * 1. 先剔除渠道里所有「被角色绑定过」的条目——那是旧的全挂做法,留着仍会污染;
 * 2. 再追加本图在场角色的绑定(同名只保留一份);
 * 3. 渠道里其余 LoRA(风格/放大/细节)原样保留,顺序不变。
 */
export function mergeCharacterLoras(
  base: readonly ComfyLoraEntry[],
  bound: ReadonlySet<string>,
  active: readonly ComfyLoraEntry[],
): ComfyLoraEntry[] {
  const out = base.filter(lora => !bound.has(lora.name.trim())).map(lora => ({ ...lora }));
  for (const lora of active) {
    if (!out.some(item => item.name === lora.name)) out.push({ ...lora });
  }
  return out;
}
