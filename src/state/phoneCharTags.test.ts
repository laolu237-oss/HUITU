import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 手机UI 角色形象影子层(state/phoneCharTags.ts + st/phoneRoles.ts)。
 *
 * 这一层是 2026-10-20 新增的外貌真源入口,行为上有三条硬约束,任何一条坏了都会
 * 让「手机UI 一份数据、柏宝绘一份旧拷贝」的老问题复发:
 *   ① 影子条目要真的进派生库(生成时 AI 能看到并照抄),且标记 source='phone';
 *   ② 全局库同名的角色**不进影子**(全局是用户固定的,不能被盖住);
 *   ③ 影子名字必须算「锁定名」,AI 的 changes / 旧楼层 ops 都动不了它。
 */

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<Record<string, unknown>>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  saveChat: ReturnType<typeof vi.fn>;
}

let ctx: FakeCtx;
let charTags: typeof import('@/state/charTags');
let globalTags: typeof import('@/state/globalCharTags');
let phoneTags: typeof import('@/state/phoneCharTags');

const FIELDS = (traits: string, face: string) => ({
  characterTraits: traits,
  facialFeatures: face,
  facialFeaturesBack: '',
  upperBodySFW: '',
  upperBodySFWBack: '',
  fullBodySFW: '',
  fullBodySFWBack: '',
  upperBodyNSFW: '',
  upperBodyNSFWBack: '',
  fullBodyNSFW: '',
  fullBodyNSFWBack: '',
});

/** 假手机UI:一个正常角色 + 一个别名 + 一个兽类(只有 characterTraits)。 */
function fakePhone(all: Record<string, unknown>) {
  return {
    getAll: () => all,
    isEnabled: () => true,
  };
}

beforeEach(async () => {
  vi.resetModules();
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    chat: [],
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
    saveChat: vi.fn(() => Promise.resolve()),
  };
  const win: Record<string, unknown> = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  (globalThis as Record<string, unknown>).window = win;
  charTags = await import('@/state/charTags');
  globalTags = await import('@/state/globalCharTags');
  phoneTags = await import('@/state/phoneCharTags');
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

function boot(all: Record<string, unknown>): void {
  (window as unknown as Record<string, unknown>).PhoneCharacterAppearance = fakePhone(all);
  globalTags.initGlobalCharTags();
  phoneTags.initPhoneCharTags();
  charTags.hydrateCharTags();
}

describe('手机UI 角色形象影子', () => {
  it('映射成库条目、别名展开、并把影子并进派生库', () => {
    boot({
      苏曼: { nameCN: '苏曼', nameEN: 'Su Man', gender: 'female', ...FIELDS('42yo, milf', 'amber eyes') },
      郭志强: { nameCN: '郭志强', gender: 'male', ...FIELDS('22yo, student', 'short black hair') },
      苏姐: { _aliasOf: '苏曼' },
      烈焰犬: { nameCN: '烈焰犬', gender: 'beast', isBeast: true, characterTraits: 'no humans, large dog' },
    });

    const names = charTags.charTagLib.entries.map(entry => entry.name).sort();
    expect(names).toEqual(['烈焰犬', '苏姐', '苏曼', '郭志强']);
    const su = charTags.findCharTag('苏曼')!;
    expect(su.source).toBe('phone');
    expect(su.fields.facialFeatures).toBe('amber eyes');
    // 别名拿到的是真名的副本,不是空档案
    expect(charTags.findCharTag('苏姐')!.fields.characterTraits).toBe('42yo, milf');
    expect(charTags.findCharTag('烈焰犬')!.fields.characterTraits).toBe('no humans, large dog');
    expect(phoneTags.phoneCharTagLib.origin).toBe('window');
    expect(phoneTags.phoneCharTagLib.entries).toHaveLength(4);
  });

  it('全局库同名的角色不进影子,并计入 skippedByGlobal', () => {
    globalTags.upsertGlobalCharTag({
      ...charTags.emptyCharFields(),
      name: '苏曼',
      fields: { ...charTags.emptyCharFields(), characterTraits: '1girl, fixed by user' },
      raw: '',
      nl: '',
      source: 'manual',
      desc: '',
      history: [],
    } as never);
    boot({
      苏曼: { nameCN: '苏曼', ...FIELDS('42yo, milf', 'amber eyes') },
      郭志强: { nameCN: '郭志强', ...FIELDS('22yo, student', 'short black hair') },
    });

    expect(phoneTags.phoneCharTagLib.entries.map(entry => entry.name)).toEqual(['郭志强']);
    expect(phoneTags.phoneCharTagLib.skippedByGlobal).toBe(1);
    // 派生库里 苏曼 仍在(来自全局),但值是全局那份
    expect(charTags.findCharTag('苏曼')!.fields.characterTraits).toBe('1girl, fixed by user');
    expect(charTags.findCharTag('苏曼')!.source).toBe('manual');
  });

  it('影子名字是锁定名,旧楼层 ops 改不动它', () => {
    boot({ 郭志强: { nameCN: '郭志强', ...FIELDS('22yo, student', 'short black hair') } });
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: {
          [charTags.BBI_CHAR_EXTRA_KEY]: {
            v: 1,
            swipe: 0,
            ops: [{ kind: 'set', name: '郭志强', field: 'facialFeatures', value: 'long red hair', reason: '染发', at: 1 }],
          },
        },
      },
    ];
    charTags.hydrateCharTags();

    expect(charTags.lockedCharTagNames().has('郭志强')).toBe(true);
    expect(charTags.findCharTag('郭志强')!.fields.facialFeatures).toBe('short black hair');
  });

  it('内容没变时 refresh 返回 false(2s 轮询靠它短路)', () => {
    boot({ 郭志强: { nameCN: '郭志强', ...FIELDS('22yo, student', 'short black hair') } });
    // 初始化已经读过一次,再来一次内容相同 → 不算变化
    expect(phoneTags.refreshPhoneCharTags()).toBe(false);
    expect(phoneTags.refreshPhoneCharTags(true)).toBe(false);
    // 手机UI 那边多了一个角色 → 才算变化(否则轮询会每 2s 重放一次派生库)
    (window as unknown as Record<string, unknown>).PhoneCharacterAppearance = fakePhone({
      郭志强: { nameCN: '郭志强', ...FIELDS('22yo, student', 'short black hair') },
      张凯: { nameCN: '张凯', ...FIELDS('22yo, student', 'brown eyes') },
    });
    expect(phoneTags.refreshPhoneCharTags()).toBe(true);
  });

  it('手机UI 清空后影子跟着消失(不落盘)', () => {
    boot({ 郭志强: { nameCN: '郭志强', ...FIELDS('22yo, student', 'short black hair') } });
    (window as unknown as Record<string, unknown>).PhoneCharacterAppearance = fakePhone({});
    phoneTags.refreshPhoneCharTags(true);
    charTags.recomputeCharTags();
    expect(charTags.findCharTag('郭志强')).toBeUndefined();
  });
});
