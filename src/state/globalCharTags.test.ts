import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 全局角色库(state/globalCharTags.ts)集成测试。
 * 以假 window.SillyTavern.getContext 喂一个内存 extensionSettings/chatMetadata,
 * 验证:CRUD 落盘、历史剥离、合并进派生库、锁定名拦截 AI ops、提升/复制两条迁移路径。
 *
 * [v11·2026-10-14] 11 字段:sex/hair/eyes 字段名已改为 characterTraits/facialFeatures。
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
// 每次 resetModules 后动态重进,保证模块级状态(fingerprint/baseEntries)干净
let charTags: typeof import('@/state/charTags');
let globalTags: typeof import('@/state/globalCharTags');

function makeEntry(name: string, fields: Partial<Record<import('@/state/charTags').CharTagField, string>>) {
  return {
    name,
    fields: { ...charTags.emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
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
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  charTags = await import('@/state/charTags');
  globalTags = await import('@/state/globalCharTags');
  globalTags.initGlobalCharTags();
  charTags.hydrateCharTags();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('global char tag store', () => {
  it('upsert 落盘 extensionSettings 且剥离 history,并合并进派生库', () => {
    const ok = globalTags.upsertGlobalCharTag({
      ...makeEntry('玩家', { characterTraits: '1boy', facialFeatures: 'short black hair' }),
      history: [{ field: 'facialFeatures', from: 'a', to: 'b', reason: 'x', floor: 1, at: 1 }],
    });
    expect(ok).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].history).toEqual([]);
    // 派生库(本聊天为空时)直接含全局条目
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['玩家']);
    const stored = ctx.extensionSettings['baibai_image_char_global'] as {
      schemaVersion: number;
      entries: Array<{ name: string; history: unknown[] }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.entries[0].name).toBe('玩家');
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('同名为覆盖更新;oldName 改名;remove 删除', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { characterTraits: '1boy' }));
    globalTags.upsertGlobalCharTag(
      makeEntry('玩家', { characterTraits: '1boy', facialFeatures: 'red eyes' }),
    );
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].fields.facialFeatures).toBe('red eyes');

    globalTags.upsertGlobalCharTag(makeEntry('冒险者', { characterTraits: '1boy' }), '玩家');
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['冒险者']);

    expect(globalTags.removeGlobalCharTag('冒险者')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
    expect(globalTags.removeGlobalCharTag('不存在')).toBe(false);
  });

  it('拒绝空条目(无字段也无整串)', () => {
    expect(globalTags.upsertGlobalCharTag(makeEntry('空', {}))).toBe(false);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
  });

  it('init 时领养 extensionSettings 里已有的全局库', async () => {
    ctx.extensionSettings['baibai_image_char_global'] = {
      schemaVersion: 1,
      revision: 3,
      entries: [makeEntry('老玩家', { characterTraits: '1girl' })],
    };
    vi.resetModules();
    charTags = await import('@/state/charTags');
    globalTags = await import('@/state/globalCharTags');
    globalTags.initGlobalCharTags();
    charTags.hydrateCharTags();
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
  });
});

describe('锁定与合并语义', () => {
  it('全局独有角色被锁定:本聊天 AI 楼层 ops 对它无效', () => {
    globalTags.upsertGlobalCharTag(
      makeEntry('玩家', { characterTraits: '1boy', facialFeatures: 'short black hair' }),
    );
    const dye = charTags.createCharTagSetOp('玩家', 'facialFeatures', 'long red hair', '染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.facialFeatures).toBe('short black hair');
    expect([...charTags.lockedCharTagNames()]).toEqual(['玩家']);
  });

  // [2026-10-20] 本聊天层下线:不再有「本聊天同名覆盖全局并解锁」「提升为全局」
  // 「复制到本聊天」这些跨层动作 —— 只剩角色库一层 + 手机UI 只读影子。
  it('本聊天层的旧数据不会混进派生库(只在迁移时被搬出来)', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { characterTraits: '1boy' }));
    ctx.chatMetadata['baibai_image_char_tags'] = {
      version: 3,
      entries: [makeEntry('路人', { characterTraits: '1girl' })],
    };
    charTags.hydrateCharTags();
    expect(charTags.charTagLib.entries.map(entry => entry.name)).toEqual(['玩家']);
    expect(charTags.readChatCharTagBase().map(entry => entry.name)).toEqual(['路人']);
  });
});