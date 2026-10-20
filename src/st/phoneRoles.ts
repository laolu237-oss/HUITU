/**
 * 手机UI『角色形象』→ 柏宝绘角色库条目的结构化快照。
 *
 * 为什么要有这一层(而不是在页面里直接摸 `PhoneCharacterAppearance`):
 * 1. 手机UI 跑在酒馆助手的 iframe 里,取值要走三级回退(见 `@/st/phoneAppearance`),
 *    这套回退对「显示」和「生成时取库」是同一个需求,只该有一份实现;
 * 2. 它的条目形状是 `{nameCN,nameEN,gender,11 个外貌字段,initialOutfit,_aliasOf,_isDefault}`,
 *    与柏宝绘的 `CharTagEntry` 不同构,映射也得只写一次;
 * 3. 别名(`_aliasOf`)要展开成真实数据的副本 —— 手机UI 导出到柏宝绘时就是这么做的
 *    (其 `getAllWithAliases`),否则别名角色在柏宝绘里会是一条空档案。
 *
 * 真源分工(见 更新文档/2026-10-20-*):**外貌**以手机UI 为准,柏宝绘只读镜像;
 * **剧情记忆**(在场/着装/状态)仍然读柏宝书,两边不重叠。
 */

import {
  pcaFromChatMetadata,
  pcaFromIframes,
  pcaFromWindow,
  type PhoneAppearanceMap,
} from '@/st/phoneAppearance';
import { CHAR_TAG_FIELDS, emptyCharFields, type CharTagEntry } from '@/state/charTags';

export type PhoneRoleOrigin = 'window' | 'iframe' | 'chatMetadata';

/** 条目的非外貌元信息(柏宝绘的 CharTagEntry 不存这些,但界面/同步要用)。 */
export interface PhoneRoleMeta {
  nameEN: string;
  gender: string;
  /** 手机UI 脚本内硬编码的默认角色(林知意/苏曼那批)。 */
  isDefault: boolean;
  /** 兽类/宠物(只有 characterTraits,没有人类分部位字段)。 */
  isBeast: boolean;
}

export interface PhoneRolesSnapshot {
  /** 已映射成柏宝绘条目形状,按名字去重、别名已展开。 */
  entries: CharTagEntry[];
  meta: Record<string, PhoneRoleMeta>;
  /** 数据实际来自哪一级回退;null = 手机UI 不可用(未启用/未加载/本聊天无缓存)。 */
  origin: PhoneRoleOrigin | null;
  /** 手机UI 的「角色形象」总开关;读不到时按 true(它的默认值也是 true)。 */
  enabled: boolean;
}

/** 手机UI 条目里的整串槽位:白名单是 11 字段 + nameCN/nameEN/gender,整串叫 wholeFrontSFW。 */
function pickWhole(raw: Record<string, unknown>): string {
  for (const key of ['wholeFrontSFW', 'raw'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 单条手机UI 数据 → CharTagEntry;11 字段与整串全空时返回 null(没有可用外貌)。 */
function toEntry(name: string, raw: Record<string, unknown>, meta: PhoneRoleMeta): CharTagEntry | null {
  const fields = emptyCharFields();
  let filled = false;
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text) continue;
    fields[field] = text;
    filled = true;
  }
  const whole = pickWhole(raw);
  if (!filled && !whole) return null;
  return {
    name,
    fields,
    raw: whole,
    nl: '',
    // 镜像条目的来源是「手机UI」,界面据此显示徽标;它不是 AI 建的,所以不进 changes 体系
    source: 'phone',
    desc: meta.nameEN ? `手机UI 角色形象(${meta.nameEN})` : '手机UI 角色形象',
    history: [],
  };
}

function metaOf(raw: Record<string, unknown>, isDefault: boolean): PhoneRoleMeta {
  return {
    nameEN: str(raw, 'nameEN'),
    gender: str(raw, 'gender'),
    isDefault: isDefault || raw._isDefault === true,
    isBeast: raw.isBeast === true || raw.isPet === true || str(raw, 'gender') === 'beast',
  };
}

/** 从映射构建快照;`isDefault` 由来源决定(window/iframe 的 getAll 已合并内置,chatMetadata 只有用户缓存)。 */
function build(
  map: PhoneAppearanceMap,
  origin: PhoneRoleOrigin,
  enabled: boolean,
): PhoneRolesSnapshot {
  const meta: Record<string, PhoneRoleMeta> = {};
  const reals: Record<string, Record<string, unknown>> = {};
  const aliases: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== 'object') continue;
    const aliasOf = typeof raw._aliasOf === 'string' ? raw._aliasOf.trim() : '';
    if (aliasOf) {
      aliases.push([name, aliasOf]);
      continue;
    }
    reals[name] = raw;
    meta[name] = metaOf(raw, raw._isDefault === true);
  }
  const entries: CharTagEntry[] = [];
  for (const [name, raw] of Object.entries(reals)) {
    const entry = toEntry(name, raw, meta[name]);
    if (entry) entries.push(entry);
  }
  // 别名:复制真名的条目与元信息(与手机UI getAllWithAliases 同口径)
  for (const [alias, target] of aliases) {
    const source = reals[target];
    if (!source || meta[alias]) continue;
    meta[alias] = metaOf(source, source._isDefault === true);
    const entry = toEntry(alias, source, meta[alias]);
    if (entry) entries.push(entry);
  }
  return { entries, meta, origin, enabled };
}

/**
 * 读一次手机UI 角色形象快照。
 *
 * 三级回退与「一键导入手机UI」完全一致:本窗口 → 同源 iframe(手机UI 脚本所在)→
 * ST 共享 chatMetadata。**一二级才含手机UI 脚本内硬编码的默认角色**,三级只有用户缓存
 * ——调用方要用 `origin` 把这件事说给用户听。
 */
export function readPhoneRoles(): PhoneRolesSnapshot {
  const empty: PhoneRolesSnapshot = { entries: [], meta: {}, origin: null, enabled: true };
  const win = typeof window !== 'undefined' ? window : null;
  const doc = typeof document !== 'undefined' ? document : null;

  const fromWindow = (w: unknown): { map: PhoneAppearanceMap; enabled: boolean } | null => {
    const map = pcaFromWindow(w);
    if (!map) return null;
    const pca = (w as { PhoneCharacterAppearance?: { isEnabled?: () => boolean } })
      ?.PhoneCharacterAppearance;
    let enabled = true;
    try {
      if (typeof pca?.isEnabled === 'function') enabled = !!pca.isEnabled();
    } catch (_e) {
      /* 开关读不到就按开 */
    }
    return { map, enabled };
  };

  const direct = fromWindow(win);
  if (direct) return build(direct.map, 'window', direct.enabled);

  // iframe 路径:手机UI 的 getAll 在这里,含内置默认角色
  if (doc) {
    const iframeMap = pcaFromIframes(doc);
    if (iframeMap) {
      let enabled = true;
      try {
        for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
          let cw: Window | null = null;
          try {
            cw = (frame as HTMLIFrameElement).contentWindow;
          } catch (_e) {
            continue;
          }
          const pca = (cw as { PhoneCharacterAppearance?: { isEnabled?: () => boolean } } | null)
            ?.PhoneCharacterAppearance;
          if (typeof pca?.isEnabled === 'function') {
            enabled = !!pca.isEnabled();
            break;
          }
        }
      } catch (_e) {
        /* 读不到开关就按开 */
      }
      return build(iframeMap, 'iframe', enabled);
    }
  }

  const shared = pcaFromChatMetadata();
  if (shared) {
    let enabled = true;
    try {
      const meta = (window as unknown as { SillyTavern?: { getContext?: () => { chatMetadata?: Record<string, unknown> } } })
        ?.SillyTavern?.getContext?.()?.chatMetadata as
        | { yinqi_phone?: { char_appearance_enabled?: unknown } }
        | undefined;
      const flag = meta?.yinqi_phone?.char_appearance_enabled;
      if (flag === false || flag === 'false') enabled = false;
    } catch (_e) {
      /* 读不到开关就按开 */
    }
    return build(shared, 'chatMetadata', enabled);
  }

  return empty;
}

/** 给界面用的一句来源说明(为什么看不到默认角色 / 为什么一条都没有)。 */
export function describePhoneRoleOrigin(snapshot: PhoneRolesSnapshot): string {
  switch (snapshot.origin) {
    case 'window':
    case 'iframe':
      return '手机UI 脚本直读(含内置默认角色)';
    case 'chatMetadata':
      return '共享存储(仅本聊天缓存,读不到手机UI 内置默认角色)';
    default:
      return '手机UI 未运行 / 本聊天还没有角色形象';
  }
}
