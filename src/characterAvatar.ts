/**
 * 角色头像生成。
 *
 * 与楼层出图的分工:楼层出图按剧情给构图/景别/动作;头像是一张**标准头像照**
 * (半身、正面、简单背景),所以这里另配一份内置提示词,与角色自己的外貌串一起发。
 * 内置提示词做成常量而不是设置项:它服务的是「列表里那个小方块」,不是创作自由。
 */

/** 生成头像时附加在角色外貌串之后的内置提示词。 */
export const AVATAR_PROMPT =
  'portrait, upper body, facing viewer, looking at viewer, simple background, centered';

/** 头像串 = 角色外貌串 + 内置头像提示词;角色没有可用外貌时只发内置部分。 */
export function buildAvatarPrompt(characterTag: string): string {
  const tag = characterTag.trim();
  return tag ? `${tag}, ${AVATAR_PROMPT}` : AVATAR_PROMPT;
}

/**
 * 头像文件名前缀。上传服务端会把扩展名统一替换成实际格式,
 * 所以磁盘上是 `avatar.png` / `avatar.jpg`;同名静默覆盖 → 重新生成就是换头像。
 */
export const AVATAR_FILE_STEM = 'avatar';

/** 一个文件是不是该角色的头像(而不是目录里的普通出图)。 */
export function isAvatarFile(file: string): boolean {
  return /^avatar\./i.test(file);
}
