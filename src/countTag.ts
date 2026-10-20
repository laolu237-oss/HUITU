/**
 * 人数 tag 兜底:确认「本图只有一个人」但提示词里没有任何人数/独身 tag 时,补上 `1girl, solo`
 * (或 `1boy, solo`;性别判断不出来时只补 `solo`)。
 *
 * 为什么需要它:单人画面被画成两三个同一个人,最常见的原因不是模型爱画多人,而是 tag 里
 * **根本没有人数 tag** —— Anima / SD 系在缺人数时自行决定画几个人,再叠上一长串重复的外貌
 * 描述(触发词串 + 服装库整串),就很容易"多画几个相似的人"。规范里写「必须写 1girl, solo」
 * 属于劝告,模型仍会漏;这里是最后一道确定性兜底。
 *
 * 为什么必须「能证明只有一个人」才动手:
 * - 只有 `names`(ComfyUI 角色名数组)或 NAI 的 `characters[]` 长度为 1 才算证据;
 * - 拿不到证据时宁可不补 —— 给双人画面补上 `solo` 会把两个人挤成一个,比漏画更糟。
 *
 * 为什么插在触发词之后:LoRA 触发词要尽量靠前,而人数 tag 按规范也该在最前;
 * 两者同时存在时,触发词第一、人数紧跟,是唯一同时满足两条的顺序。
 */

/** 与 characterLora.ts 同口径:这些人数据 tag 出现任何一个,就说明模型已经写了人数。 */
const COUNT_TAG = /^(?:solo|no humans|\d+\+?(?:girl|boy|other)s?|multiple (?:girls|boys|others))$/i;

/** 只作为「性别线索」使用,不写进提示词。宁可判不出(只补 solo),也不要补错性别。 */
const FEMALE_WORDS = ['girl', 'girls', 'woman', 'women', 'female', 'lady', 'breasts', 'cleavage', 'pussy', 'vagina', 'panties', 'bra'];
const MALE_WORDS = ['boy', 'boys', 'man', 'men', 'male', 'penis', 'testicles', 'scrotum'];

/**
 * 从文本里找性别线索。
 *
 * 为什么按「词」而不是正则 `\b(girl)\b`:`1girl` 的 `g` 前面是数字,`\b` 不成立,
 * 正则写法会漏掉最常见的人数 tag。这里先按非字母数字切词,再去掉前导数字,
 * `1girl` → `girl` 就能命中;同时避免 `cowgirl`、`bracelet` 这类子串误判。
 */
function genderHints(text: string): { female: boolean; male: boolean } {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(token => token.replace(/^\d+/, ''));
  return {
    female: tokens.some(token => FEMALE_WORDS.includes(token)),
    male: tokens.some(token => MALE_WORDS.includes(token)),
  };
}

export interface SoloTagOptions {
  /**
   * 本图**已知**的角色数。undefined / 0 / ≥2 一律不动:
   * 只有确知为 1 时才补,避免把双人画面误改成单人。
   */
  characterCount?: number;
  /** LoRA 触发词(串首项)。命中的话,人数 tag 插在它后面而不是最前面。 */
  triggerToken?: string;
  /**
   * 额外的性别线索(不写进提示词)。NAI 传 `characters[].tag`(如 `girl, white dress`),
   * 因为那边的人数信息本来就分块放在角色提示里,Base tag 可能一个性别词都没有。
   */
  hintText?: string;
}

function splitItems(text: string): string[] {
  return text
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean);
}

/** 词项归一:与 characterLora.ts 的 normalizeItem 同口径(忽略大小写、下划线、转义括号)。 */
function normalizeItem(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\\(?=[()])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 给单人画面补人数 tag。**幂等**:已有人数 tag 时原样返回,重复调用不会叠加。
 */
export function ensureSoloTag(tag: string, options: SoloTagOptions = {}): string {
  if (options.characterCount !== 1) return tag;
  const items = splitItems(tag);
  if (!items.length) return tag;
  // 模型已经写了人数 / solo / no humans:说明它想过这件事,不要再插手
  if (items.some(item => COUNT_TAG.test(item))) return tag;

  const hints = genderHints(options.hintText ? `${items.join(', ')}, ${options.hintText}` : items.join(', '));
  const count = hints.female && !hints.male ? '1girl' : hints.male && !hints.female ? '1boy' : '';
  const tokens = count ? [count, 'solo'] : ['solo'];

  const trigger = options.triggerToken?.trim();
  const at = trigger && normalizeItem(items[0]) === normalizeItem(trigger) ? 1 : 0;
  items.splice(at, 0, ...tokens);
  return items.join(', ');
}
