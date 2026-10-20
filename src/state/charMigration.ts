/**
 * 旧「本聊天层」数据的一次性处置(迁移 / 清理)。
 *
 * 2026-10-20 起柏宝绘的角色库只剩「全局」一层:角色形象只有两个地方 ——
 * 柏宝绘(库)与手机UI(角色形象)。本聊天层的旧数据不再参与派生库,
 * 但聊天文件里还留着,所以这里给两个明确出口,不让它变成看不见的幽灵档案:
 *   - drain:把旧基线并入全局(同名跳过),然后清空旧层;
 *   - purge:直接清空旧层(用户确认「没用的就删掉」)。
 * 楼层 ops 里那些「只建过档、已不在基线」的名字搬不出可信值(取值靠楼层重放),
 * 所以这两种处置都会一并剥掉它们的 ops —— 也就是真正删掉。
 */

import {
  clearChatCharTagBase,
  listChatCharTagFloorNames,
  readChatCharTagBase,
} from '@/state/charTags';
import { findGlobalCharTag, upsertGlobalCharTag } from '@/state/globalCharTags';

export interface LegacyChatTagSummary {
  /** 旧手动基线里有几条。 */
  base: number;
  /** 只在楼层 ops 里出现过、基线上没有的名字数(通常是 AI 早期建档)。 */
  floorOnly: number;
}

export function summarizeLegacyChatCharTags(): LegacyChatTagSummary {
  const base = readChatCharTagBase();
  const baseNames = new Set(base.map(entry => entry.name));
  const floorOnly = listChatCharTagFloorNames().filter(name => !baseNames.has(name)).length;
  return { base: base.length, floorOnly };
}

/** 旧数据是否还有东西可处理(界面据此决定要不要显示提示条)。 */
export function hasLegacyChatCharTags(): boolean {
  const summary = summarizeLegacyChatCharTags();
  return summary.base > 0 || summary.floorOnly > 0;
}

/**
 * 把旧本聊天基线并入全局(同名跳过),然后清空旧层。
 * @returns moved=新并入的条数;skipped=全局已有同名而跳过的条数。
 */
export function drainLegacyChatCharTagsToGlobal(): { moved: number; skipped: number } {
  const base = readChatCharTagBase();
  let moved = 0;
  let skipped = 0;
  for (const entry of base) {
    if (findGlobalCharTag(entry.name)) {
      skipped += 1;
      continue;
    }
    if (upsertGlobalCharTag({ ...entry, history: [] })) moved += 1;
    else skipped += 1;
  }
  clearChatCharTagBase();
  return { moved, skipped };
}

/** 直接丢弃旧本聊天层(基线 + 楼层 ops)。 */
export function purgeLegacyChatCharTags(): { removed: number } {
  const summary = summarizeLegacyChatCharTags();
  clearChatCharTagBase();
  return { removed: summary.base + summary.floorOnly };
}
