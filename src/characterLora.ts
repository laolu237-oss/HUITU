import type { ComfyLoraEntry } from '@/backends/comfyTemplates';
import type { CharTagEntry } from '@/state/charTags';

/**
 * 角色级 LoRA 动态挂载的纯逻辑层。
 *
 * 背景:角色 LoRA(如「Anima角色\紫发美女」)只应在**该角色出现在画面里**时生效。
 * 以前只能把角色 LoRA 全挂在渠道里,同框的每个角色互相污染;触发词也只能靠 AI 抄,
 * 而模型会把不认识的词(如 `adnim`)当噪声删掉——它不知道那是 LoRA 触发词。
 *
 * 现在:绑定挂在角色条目上,出图前按「本图角色名」解析出该挂的 LoRA 与触发词,
 * 由插件确定性拼接。模型既删不掉,也不会串。
 *
 * 本模块只做纯计算:不读 settings、不读上下文,库条目与渠道 LoRA 都由调用方传入。
 */

export interface CharacterLoraResolution {
  /** 本图该挂的 LoRA(按角色名去重)。 */
  loras: ComfyLoraEntry[];
  /** 本图的触发词(去重、保序)。 */
  triggers: string[];
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
 * 按本图角色名解析 LoRA 与触发词。
 * 名字必须与库条目**逐字一致**(协议要求模型用库中原名),查不到的忽略;
 * 同一 LoRA 被多个角色绑定时只挂一次(取首次出现的强度)。
 */
export function resolveCharacterLoras(
  names: readonly string[],
  entries: readonly CharTagEntry[],
): CharacterLoraResolution {
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const loras: ComfyLoraEntry[] = [];
  const triggers: string[] = [];
  const seenLora = new Set<string>();
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
    if (trigger && !triggers.includes(trigger)) triggers.push(trigger);
  }
  return { loras, triggers };
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

/** 触发词拼在正向提示词最前面;无触发词时原样返回。 */
export function withTriggers(prompt: string, triggers: readonly string[]): string {
  const prefix = triggers
    .map(trigger => trigger.trim())
    .filter(Boolean)
    .join(', ');
  if (!prefix) return prompt;
  return prompt.trim() ? `${prefix}, ${prompt.trim()}` : prefix;
}
