import type { ClosetCategory, ClosetOutfit } from '@/state/closet';

/**
 * 服装库的「锚定」侧 —— 与 charAnchors.ts 的【角色固定外貌库】并列的第二份档案。
 *
 * 生成 tag 前把池子渲染成请求里的【服装库】文本:AI 看得见每套服装的词串,才能在
 * 为角色确定临时服装时挑一套照抄。名单、词串、分类名全部由插件生成,**AI 只读**。
 *
 * 与角色库的三处口径差异(设计时就决定不同,不是遗漏):
 * - 角色库按角色建档,服装库是**一个共享池**,不按角色分区;条目上的「仅限角色」
 *   只是少数专属款的挂名,通用款任何角色都能挑。
 * - 角色库的 outfit 字段是「长期不换的招牌着装」,由 AI 通过 changes 报告变更;
 *   服装库**AI 永远不能写**(见 state/closet.ts 的硬约束一),服装是临时状态,
 *   允许自动入库会让池子迅速失控。
 * - 角色库空库时要下发占位块(否则模型会以为没人建档);服装库空池时**整块不下发**,
 *   由任务协议里的兜底句式接住(「未附带【服装库】时自行决定」),没用衣柜的
 *   用户一分 token 不多付。
 *
 * 分类名为什么要一起发:用户把分类起成能读懂的情境词(校服、宴会、战斗),
 * 它就是免费的强信号 —— 「本楼是校园场景 → 优先从校服类里挑」。
 * 这也是用户当初选「AI 全选」而非本地打分的核心诉求:让 AI 自己看、自己挑。
 */

/** 把一条服装渲染成给 AI 看的一行;nl 只在协议含自然语言时附上。 */
export function formatOutfitForPrompt(
  outfit: ClosetOutfit,
  categoryName: string,
  nlOn = false,
): string {
  // 归属徽标:填了「仅限角色」的只给该角色挑,留空的是通用款
  const badges = [outfit.character.trim() ? `仅限 ${outfit.character.trim()}` : '通用'];
  if (categoryName) badges.push(categoryName);
  // 自然语言备用句式:当前工作流 nl 关闭时发了也没处写,不浪费 token
  const nl = nlOn && outfit.nl.trim() ? `｜nl=${outfit.nl.trim()}` : '';
  return `- ${outfit.name}（${badges.join(' · ')}）: ${outfit.tags}${nl}`;
}

/**
 * 服装库文本:发给 AI 的服装池部分。AI 依据它为每个角色挑一套临时服装并照抄词串。
 *
 * 空池返回空串,调用方据此不注入该块(见文件头第三条)。
 */
export function buildClosetText(
  categories: readonly ClosetCategory[],
  outfits: readonly ClosetOutfit[],
  nlOn = false,
): string {
  if (!outfits.length) return '';
  const nameOf = new Map(categories.map(category => [category.id, category.name]));
  const lines = outfits.map(outfit =>
    formatOutfitForPrompt(
      outfit,
      // 指向已删分类的条目按未分类处理(与界面层分组同口径),不显示野分类名
      outfit.categoryId ? nameOf.get(outfit.categoryId) ?? '' : '',
      nlOn,
    ),
  );
  const categoryNames = categories
    .map(category => category.name.trim())
    .filter(Boolean);
  // 分类信号行:只有真的建了分类才占这一行,平铺使用的用户不付这份开销
  const categoryLine = categoryNames.length
    ? `\n分类名即场景信号（${categoryNames.join('、')}）：正文情境与某个分类明显对应时，优先从该分类里挑。\n`
    : '\n';
  return `【服装库】[system-maintained; user-curated; AI read-only — pick ONE set per character and copy its tags verbatim]${categoryLine}${lines.join('\n')}`;
}
