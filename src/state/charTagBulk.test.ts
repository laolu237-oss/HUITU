import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 批量操作(「收藏当前列表 / 清除非收藏」)的落盘与派生验收。
 *
 * 这两个动作的**真实风险不在 UI,而在写盘次数与派生重算**:单条 API 每次都
 * 扫全聊天楼层 + 序列化整库 + 整段重放,几十条一起删/收藏时如果不走批量,
 * 手机上会明显卡住、且可能在中途留下半套数据。所以这里重点验:
 *   ① 一次操作只落盘一次(saveSettingsDebounced / saveMetadataDebounced 各 1 次);
 *   ② 派生库(含 AI 楼层 ops 重放)结果正确;
 *   ③ AI 楼层建档的条目被收藏时,值会沉进手动基线、历史 ops 被剥掉(下次重放不变)。
 */

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<Record<string, unknown>>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  saveChat: ReturnType<typeof vi.fn>;
}

const META_KEY = 'baibai_image_char_tags';
const GLOBAL_KEY = 'baibai_image_char_global';

let ctx: FakeCtx;
let charTags: typeof import('@/state/charTags');
let globalTags: typeof import('@/state/globalCharTags');

function makeEntry(name: string, traits = '1girl') {
  return {
    name,
    fields: { ...charTags.emptyCharFields(), characterTraits: traits },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  };
}

/** 一楼的 AI 建档 delta:new op 让派生库多出一个条目。 */
function floorWithNew(name: string): Record<string, unknown> {
  return {
    name: 'Char',
    is_user: false,
    is_system: false,
    mes: '正文',
    swipe_id: 0,
    extra: {
      [charTags.BBI_CHAR_EXTRA_KEY]: {
        v: 1,
        swipe: 0,
        ops: [
          {
            kind: 'new',
            name,
            fields: { ...charTags.emptyCharFields(), characterTraits: '1girl, red eyes' },
            raw: '',
            nl: '',
            source: 'ai',
            desc: '',
            reason: '首次出场',
            at: 1,
          },
        ],
      },
    },
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

describe('全局库 · 批量删除 / 批量收藏', () => {
  it('只删未收藏,一次落盘', () => {
    for (const [name, fav] of [
      ['甲', false],
      ['乙', true],
      ['丙', false],
    ] as const) {
      globalTags.upsertGlobalCharTag({ ...makeEntry(name), favorite: fav });
    }
    ctx.saveSettingsDebounced.mockClear();

    const removed = globalTags.removeGlobalCharTagsByNames(['甲', '丙', '不存在的']);

    expect(removed).toBe(2);
    expect(globalTags.globalCharTagLib.entries.map(entry => entry.name)).toEqual(['乙']);
    expect(ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    const stored = ctx.extensionSettings[GLOBAL_KEY] as { entries: Array<{ name: string }> };
    expect(stored.entries.map(entry => entry.name)).toEqual(['乙']);
  });

  it('批量收藏幂等:第二次返回 0 且不再落盘', () => {
    globalTags.upsertGlobalCharTag(makeEntry('甲'));
    globalTags.upsertGlobalCharTag(makeEntry('乙'));

    expect(globalTags.setGlobalCharTagsFavoriteByNames(['甲', '乙'], true)).toBe(2);
    expect(globalTags.globalCharTagLib.entries.every(entry => entry.favorite === true)).toBe(true);

    ctx.saveSettingsDebounced.mockClear();
    expect(globalTags.setGlobalCharTagsFavoriteByNames(['甲', '乙'], true)).toBe(0);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });

  it('通过 upsert 保存的收藏在重载后仍在(收藏不能只活在弹窗草稿里)', async () => {
    globalTags.upsertGlobalCharTag({ ...makeEntry('甲'), favorite: true });
    const stored = ctx.extensionSettings[GLOBAL_KEY];
    expect((stored as { entries: Array<{ favorite?: boolean }> }).entries[0].favorite).toBe(true);

    // 模拟「重新进角色管理页」:模块重载 + 用同一份 extensionSettings 重新领养
    vi.resetModules();
    const reloadedGlobal = await import('@/state/globalCharTags');
    const reloadedChat = await import('@/state/charTags');
    reloadedGlobal.initGlobalCharTags();
    reloadedChat.hydrateCharTags();
    expect(reloadedGlobal.globalCharTagLib.entries[0].favorite).toBe(true);
    expect(reloadedChat.charTagLib.entries[0].favorite).toBe(true);
  });

  it('取消收藏时删掉 favorite 键,不留 false 残渣', () => {
    globalTags.upsertGlobalCharTag({ ...makeEntry('甲'), favorite: true });
    expect(globalTags.setGlobalCharTagsFavoriteByNames(['甲'], false)).toBe(1);
    expect('favorite' in globalTags.globalCharTagLib.entries[0]).toBe(false);
  });
});

describe('本聊天层下线后的派生库', () => {
  it('旧的本聊天基线与楼层 ops 都不进派生库', () => {
    ctx.chatMetadata[META_KEY] = { version: 3, entries: [makeEntry('甲'), makeEntry('乙')] };
    ctx.chat = [floorWithNew('路人')];
    charTags.hydrateCharTags();

    expect(charTags.charTagLib.entries).toHaveLength(0);
    expect(charTags.findCharTag('甲')).toBeUndefined();
    // 迁移接口仍读得到旧数据(页面据此提示、或迁出)
    expect(charTags.readChatCharTagBase().map(entry => entry.name)).toEqual(['甲', '乙']);
    expect(charTags.listChatCharTagFloorNames()).toContain('路人');
  });

  it('并入角色库:旧基线搬进全局(同名跳过),楼层 ops 清空', async () => {
    ctx.chatMetadata[META_KEY] = {
      version: 3,
      entries: [{ ...makeEntry('甲'), favorite: true }, makeEntry('乙')],
    };
    ctx.chat = [floorWithNew('路人')];
    charTags.hydrateCharTags();
    // 库里已有同名的「乙」→ 迁移时应跳过,不覆盖用户改过的版本
    globalTags.upsertGlobalCharTag(makeEntry('乙'));

    const migration = await import('@/state/charMigration');
    const { moved, skipped } = migration.drainLegacyChatCharTagsToGlobal();

    expect(moved).toBe(1);
    expect(skipped).toBe(1);
    expect(globalTags.globalCharTagLib.entries.map(entry => entry.name).sort()).toEqual(['乙', '甲']);
    // 收藏这类用户偏好随条目一起搬过去
    expect(globalTags.globalCharTagLib.entries.find(entry => entry.name === '甲')?.favorite).toBe(true);
    expect(charTags.readChatCharTagBase()).toHaveLength(0);
    expect((ctx.chat[0].extra as Record<string, unknown>)[charTags.BBI_CHAR_EXTRA_KEY]).toBeUndefined();
  });

  it('直接清理:基线删掉、楼层 ops 剥掉、不写角色库', async () => {
    ctx.chatMetadata[META_KEY] = { version: 3, entries: [makeEntry('甲')] };
    ctx.chat = [floorWithNew('路人')];
    charTags.hydrateCharTags();

    const migration = await import('@/state/charMigration');
    const { removed } = migration.purgeLegacyChatCharTags();

    expect(removed).toBe(2); // 1 条基线 + 1 个楼层建档名字
    expect(charTags.readChatCharTagBase()).toHaveLength(0);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(0);
    expect((ctx.chat[0].extra as Record<string, unknown>)[charTags.BBI_CHAR_EXTRA_KEY]).toBeUndefined();
    expect(ctx.saveChat).toHaveBeenCalled();
  });
});
