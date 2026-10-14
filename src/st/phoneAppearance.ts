/**
 * 手机UI(酒馆助手脚本)角色外观缓存的读取适配层。
 *
 * 背景:手机UI 在脚本里 `window.PhoneCharacterAppearance = {...}`。但酒馆助手脚本跑在
 * **独立 iframe** 里,各 iframe 与主文档 window 互不可见 —— 而柏宝绘是加载在主文档的普通
 * 扩展,因此 `window.PhoneCharacterAppearance` 恒为 undefined。历史上「一键导入手机UI」
 * 报「手机UI未挂载或角色外观缓存为空」就是这个原因。
 *
 * 故按可靠性降序三级取用,命中即返回:
 *  ① 本窗口 `window.PhoneCharacterAppearance`(脚本与扩展同窗时才命中);
 *  ② 同源 iframe 内的 `PhoneCharacterAppearance`(广度优先,含嵌套,深度上限 3);
 *  ③ ST 共享上下文 `chatMetadata.yinqi_phone.character_appearances`
 *     —— 手机UI 的 `getPhoneMeta('character_appearances')` 就落在这里
 *        (该键不在其 YQ_BIG_DATA_KEYS 里,走轻量 chatMetadata 通道,不走 IDB)。
 *     与 iframe 布局无关,最稳;但只含用户缓存,不含手机UI 脚本内硬编码的默认角色。
 *
 * 三级都取不到时返回 null。返回值为「角色名 → 条目对象」的映射,条目内可能带 `_aliasOf`
 * 别名标记,由调用方按需过滤。
 */

import { getContext } from '@/st/context';

export type PhoneAppearanceMap = Record<string, Record<string, unknown>>;

/** 从任意 window 上取 `PhoneCharacterAppearance.getAll()`;非空对象才算命中。 */
export function pcaFromWindow(w: unknown): PhoneAppearanceMap | null {
  try {
    const pca = (w as { PhoneCharacterAppearance?: { getAll?: () => unknown } } | null)
      ?.PhoneCharacterAppearance;
    if (!pca || typeof pca.getAll !== 'function') return null;
    const all = pca.getAll();
    if (!all || typeof all !== 'object') return null;
    const obj = all as PhoneAppearanceMap;
    return Object.keys(obj).length ? obj : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 广度优先下钻同源 iframe(含嵌套,深度上限 3)找 `PhoneCharacterAppearance`。
 * 跨源 iframe 访问 `contentWindow.document` 会抛,自动跳过、不中断整体扫描。
 */
export function pcaFromIframes(rootDoc: Document | null): PhoneAppearanceMap | null {
  if (!rootDoc) return null;
  try {
    let docs: Document[] = [rootDoc];
    for (let depth = 0; depth < 3 && docs.length; depth++) {
      const next: Document[] = [];
      for (const doc of docs) {
        for (const fr of Array.from(doc.querySelectorAll('iframe'))) {
          let cw: Window | null = null;
          try {
            cw = (fr as HTMLIFrameElement).contentWindow;
          } catch (_e) {
            continue;
          }
          if (!cw) continue;
          const hit = pcaFromWindow(cw);
          if (hit) return hit;
          try {
            if (cw.document) next.push(cw.document);
          } catch (_e) {
            /* 跨源:不可下钻 */
          }
        }
      }
      docs = next;
    }
  } catch (_e) {
    /* ignore */
  }
  return null;
}

/** 从 ST 共享上下文读手机UI外观缓存(手机UI 的轻量存储通道)。 */
export function pcaFromChatMetadata(): PhoneAppearanceMap | null {
  try {
    const meta = getContext()?.chatMetadata as
      | { yinqi_phone?: { character_appearances?: unknown } }
      | undefined;
    const store = meta?.yinqi_phone?.character_appearances;
    if (!store || typeof store !== 'object') return null;
    const obj = store as PhoneAppearanceMap;
    return Object.keys(obj).length ? obj : null;
  } catch (_e) {
    return null;
  }
}

/** 三级回退取手机UI角色外观缓存;全空返回 null。 */
export function readPhoneAppearance(): PhoneAppearanceMap | null {
  const win = typeof window !== 'undefined' ? window : null;
  const doc = typeof document !== 'undefined' ? document : null;
  return pcaFromWindow(win) ?? pcaFromIframes(doc) ?? pcaFromChatMetadata();
}

/**
 * 三级都取不到时,进一步判断卡在哪一环,给用户一句可执行的原因
 * (只用于失败提示文案,不影响读取结果)。
 */
export function phoneAppearanceMissHint(): string {
  try {
    const meta = getContext()?.chatMetadata as
      | { yinqi_phone?: Record<string, unknown> }
      | undefined;
    const store = meta?.yinqi_phone;
    if (!store) return '手机UI脚本未在本聊天运行';
    if (!store.character_appearances) return '手机UI 本聊天还没有角色外观缓存';
    return '角色外观缓存为空';
  } catch (_e) {
    return '读取失败';
  }
}
