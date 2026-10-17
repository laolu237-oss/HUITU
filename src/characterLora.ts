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

/** 词项归一:忽略大小写、下划线/空格差异、转义括号的反斜杠,避免同一词重复出现。 */
function normalizeItem(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\\(?=[()])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把「必须完整写入」的词串补齐进提示词。
 * - **去重**:同一词(忽略大小写/下划线/空白)只保留第一次出现——模型抄触发词串时
 *   常把它自带的 1girl 也抄进来,与本图人数 tag 重复;
 * - 已出现的词不重复添加;
 * - 人数 tag(1girl/2boys/solo…)从来源里剔除:照搬会与本图人数冲突;
 * - prependFirst 的来源(LoRA 触发词)统一挪到最前面,按来源顺序排列;
 * - **幂等**:对已补齐的结果再跑一次不会变化。
 */
export function ensureVerbatimItems(tag: string, sources: readonly VerbatimSource[]): string {
  if (!sources.length) return tag;
  const seen = new Set<string>();
  const items: string[] = [];
  const push = (item: string) => {
    const key = normalizeItem(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    items.push(item);
    return true;
  };
  for (const item of splitItems(tag)) push(item);
  for (const source of sources) {
    for (const item of splitItems(source.text)) {
      if (COUNT_TAG.test(item)) continue;
      push(item);
    }
  }
  // 触发词前置:先摘出来,再按来源顺序整体放到最前
  const front: string[] = [];
  for (const source of sources) {
    if (!source.prependFirst) continue;
    const first = splitItems(source.text)[0];
    if (!first) continue;
    const key = normalizeItem(first);
    const index = items.findIndex(item => normalizeItem(item) === key);
    if (index >= 0) front.push(items.splice(index, 1)[0]);
  }
  return [...front, ...items].join(', ');
}

/** 一个角色名在提示词里可能产生的噪声形态。 */
export interface CharacterNameNoise {
  /** 库条目名(如 User、林知意)——它不是 danbooru tag,不该出现在画面提示词里。 */
  name: string;
  /** LoRA 触发词串的第一项(真正的触发词,如 adnim)。 */
  triggerToken?: string;
}

/**
 * 剔除提示词里的「角色名噪声」:
 * - 裸名字(`User`、`林知意`)——模型拿它当 tag,对生图模型无意义;
 * - `名字 (触发词)`(如 `User (adnim)`)——模型把 LoRA 触发词误当成作品名拼成身份 tag;
 * - `名字 [lora]: …`——模型把库行的标记也抄进了 tag;
 * - 中文库名 + 作品名(如 `林知意 (honkai star rail)`)——中文名不是 danbooru tag,
 *   合法身份 tag 必须用英文角色名(如 `firefly (honkai star rail)`)。
 *
 * **例外**:英文库名 + 括号内作品名(且括号内不是触发词)视为合法身份 tag,原样保留。
 */
export function stripCharacterNameTags(
  tag: string,
  noise: readonly CharacterNameNoise[],
): string {
  if (!noise.length) return tag;
  const items = splitItems(tag).filter(item => {
    const key = normalizeItem(item);
    for (const { name, triggerToken } of noise) {
      const plain = normalizeItem(name);
      if (!plain) continue;
      if (key === plain) return false;
      if (!key.startsWith(plain)) continue;
      const boundary = key.charAt(plain.length);
      // 必须是词边界,避免把 username 之类的词误判成角色名
      if (boundary && !' \t([:：'.includes(boundary)) continue;
      const rest = key.slice(plain.length).trim();
      if (!rest) return false;
      if (rest.startsWith('(')) {
        const inner = rest.slice(1, rest.lastIndexOf(')')).trim();
        const asciiName = /^[\x20-\x7E]+$/.test(name.trim());
        // 英文名 + 作品名(非触发词)= 合法身份 tag
        if (asciiName && inner && inner !== normalizeItem(triggerToken ?? '')) continue;
        return false;
      }
      // name [lora]: … / name: … / name 其它 → 噪声
      return false;
    }
    return true;
  });
  return items.join(', ');
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
