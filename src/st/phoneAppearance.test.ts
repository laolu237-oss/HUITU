import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pcaFromChatMetadata,
  pcaFromIframes,
  pcaFromWindow,
  phoneAppearanceMissHint,
  readPhoneAppearance,
} from '@/st/phoneAppearance';

/** 造一个只有 querySelectorAll 的假 document。 */
function fakeDoc(frames: unknown[]): Document {
  return { querySelectorAll: () => frames } as unknown as Document;
}

/** 造一个带 PhoneCharacterAppearance 的假 window。 */
function fakeWin(entries: Record<string, unknown> | null, extra: Record<string, unknown> = {}): unknown {
  const win: Record<string, unknown> = { ...extra };
  if (entries) win.PhoneCharacterAppearance = { getAll: () => entries };
  return win;
}

function fakeIframe(win: unknown): unknown {
  return { contentWindow: win };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('手机UI 外观缓存读取 · pcaFromWindow', () => {
  it('getAll 返回非空对象时命中', () => {
    expect(pcaFromWindow(fakeWin({ 林知意: { facialFeatures: 'x' } }))).toEqual({
      林知意: { facialFeatures: 'x' },
    });
  });

  it('无 PhoneCharacterAppearance / getAll 非函数 / 抛错 / 空对象 / 非对象 一律返回 null', () => {
    expect(pcaFromWindow(null)).toBeNull();
    expect(pcaFromWindow({})).toBeNull();
    expect(pcaFromWindow({ PhoneCharacterAppearance: {} })).toBeNull();
    expect(
      pcaFromWindow({ PhoneCharacterAppearance: { getAll: () => ({}) } }),
    ).toBeNull();
    expect(
      pcaFromWindow({ PhoneCharacterAppearance: { getAll: () => 'nope' } }),
    ).toBeNull();
    expect(
      pcaFromWindow({
        PhoneCharacterAppearance: {
          getAll: () => {
            throw new Error('boom');
          },
        },
      }),
    ).toBeNull();
  });
});

describe('手机UI 外观缓存读取 · pcaFromIframes', () => {
  it('rootDoc 为 null 时返回 null', () => {
    expect(pcaFromIframes(null)).toBeNull();
  });

  it('命中一级 iframe(手机UI 脚本所在 iframe)', () => {
    const doc = fakeDoc([fakeIframe(fakeWin({ 主角: { characterTraits: 'a' } }))]);
    expect(pcaFromIframes(doc)).toEqual({ 主角: { characterTraits: 'a' } });
  });

  it('一级未命中时下钻到嵌套 iframe', () => {
    const inner = fakeDoc([fakeIframe(fakeWin({ 苏: { facialFeatures: 'b' } }))]);
    const doc = fakeDoc([fakeIframe(fakeWin(null, { document: inner }))]);
    expect(pcaFromIframes(doc)).toEqual({ 苏: { facialFeatures: 'b' } });
  });

  it('跨源 iframe(取 document 抛错)被跳过,不影响后续同源 iframe 命中', () => {
    const crossOrigin = {
      contentWindow: {
        get document(): Document {
          throw new Error('cross-origin');
        },
      },
    };
    const doc = fakeDoc([fakeIframe(crossOrigin), fakeIframe(fakeWin({ A: { raw: 'r' } }))]);
    expect(pcaFromIframes(doc)).toEqual({ A: { raw: 'r' } });
  });

  it('所有 iframe 都没有 PhoneCharacterAppearance 时返回 null', () => {
    const doc = fakeDoc([fakeIframe({}), fakeIframe(fakeWin({}))]);
    expect(pcaFromIframes(doc)).toBeNull();
  });

  it('深度上限 3:第四层才出现时不命中', () => {
    const d3 = fakeDoc([fakeIframe(fakeWin({ 深: { raw: 'x' } }))]);
    const d2 = fakeDoc([fakeIframe(fakeWin(null, { document: d3 }))]);
    const d1 = fakeDoc([fakeIframe(fakeWin(null, { document: d2 }))]);
    const root = fakeDoc([fakeIframe(fakeWin(null, { document: d1 }))]);
    expect(pcaFromIframes(root)).toBeNull();
  });
});

describe('手机UI 外观缓存读取 · pcaFromChatMetadata', () => {
  it('从 chatMetadata.yinqi_phone.character_appearances 命中', () => {
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chatMetadata: { yinqi_phone: { character_appearances: { 秋: { raw: 'z' } } } },
        }),
      },
    });
    expect(pcaFromChatMetadata()).toEqual({ 秋: { raw: 'z' } });
  });

  it('yinqi_phone 缺失 / 该键为空对象 / 非对象 一律 null', () => {
    const ctx = (meta: unknown) => ({
      SillyTavern: { getContext: () => ({ chatMetadata: meta }) },
    });

    vi.stubGlobal('window', ctx({}));
    expect(pcaFromChatMetadata()).toBeNull();

    vi.stubGlobal('window', ctx({ yinqi_phone: { character_appearances: {} } }));
    expect(pcaFromChatMetadata()).toBeNull();

    vi.stubGlobal('window', ctx({ yinqi_phone: { character_appearances: 7 } }));
    expect(pcaFromChatMetadata()).toBeNull();
  });

  it('ST 未就绪(getContext 不可用)时返回 null', () => {
    vi.stubGlobal('window', {});
    expect(pcaFromChatMetadata()).toBeNull();
  });
});

describe('手机UI 外观缓存读取 · readPhoneAppearance 三级回退', () => {
  it('一级命中即返回', () => {
    vi.stubGlobal('window', fakeWin({ 甲: { raw: '1' } }));
    vi.stubGlobal('document', fakeDoc([]));
    expect(readPhoneAppearance()).toEqual({ 甲: { raw: '1' } });
  });

  it('一级空 → 二级 iframe 命中', () => {
    vi.stubGlobal('window', fakeWin({}));
    vi.stubGlobal('document', fakeDoc([fakeIframe(fakeWin({ 乙: { raw: '2' } }))]));
    expect(readPhoneAppearance()).toEqual({ 乙: { raw: '2' } });
  });

  it('一级二级皆空 → 三级 chatMetadata 命中', () => {
    vi.stubGlobal('window', {
      ...(fakeWin({}) as Record<string, unknown>),
      SillyTavern: {
        getContext: () => ({
          chatMetadata: { yinqi_phone: { character_appearances: { 丙: { raw: '3' } } } },
        }),
      },
    });
    vi.stubGlobal('document', fakeDoc([]));
    expect(readPhoneAppearance()).toEqual({ 丙: { raw: '3' } });
  });

  it('三级皆空 → null', () => {
    vi.stubGlobal('window', {
      SillyTavern: { getContext: () => ({ chatMetadata: {} }) },
    });
    vi.stubGlobal('document', fakeDoc([]));
    expect(readPhoneAppearance()).toBeNull();
  });
});

describe('手机UI 外观缓存读取 · phoneAppearanceMissHint', () => {
  const ctx = (meta: unknown) => ({
    SillyTavern: { getContext: () => ({ chatMetadata: meta }) },
  });

  it('chatMetadata 无 yinqi_phone → 手机UI脚本未在本聊天运行', () => {
    vi.stubGlobal('window', ctx({}));
    expect(phoneAppearanceMissHint()).toBe('手机UI脚本未在本聊天运行');
  });

  it('有 yinqi_phone 但无 character_appearances → 还没有角色外观缓存', () => {
    vi.stubGlobal('window', ctx({ yinqi_phone: { count: 3 } }));
    expect(phoneAppearanceMissHint()).toBe('手机UI 本聊天还没有角色外观缓存');
  });

  it('有 character_appearances 键 → 缓存为空', () => {
    vi.stubGlobal('window', ctx({ yinqi_phone: { character_appearances: {} } }));
    expect(phoneAppearanceMissHint()).toBe('角色外观缓存为空');
  });

  it('ST 未就绪(取不到上下文)→ 手机UI脚本未在本聊天运行', () => {
    vi.stubGlobal('window', {});
    expect(phoneAppearanceMissHint()).toBe('手机UI脚本未在本聊天运行');
  });

  it('getContext 抛错时兜底为读取失败(防御分支)', () => {
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => {
          throw new Error('boom');
        },
      },
    });
    // context.ts 内部已 catch,取到 null ⇒ 仍走「未运行」;此处锁住不抛到调用方。
    expect(phoneAppearanceMissHint()).toBe('手机UI脚本未在本聊天运行');
  });
});
