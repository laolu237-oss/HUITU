import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 服装库(state/closet.ts)集成测试。
 * 以假 window.SillyTavern.getContext 喂一个内存 extensionSettings,
 * 验证:领养已有数据、CRUD 落盘与广播、分类删除时条目落「未分类」、脏数据清洗、
 * 以及「没有用户数据就不建仓」这条硬约束。
 *
 * 与角色库的差异(设计如此,不是遗漏):AI 永远不写这个库,故没有 changes 相关用例。
 */

const CLOSET_KEY = 'baibai_image_closet';

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
}

let ctx: FakeCtx;
let events: unknown[];
let closet: typeof import('@/state/closet');

/** 起一个干净模块实例:可先塞入既有 store,再 initCloset 领养。 */
async function boot(store?: unknown): Promise<typeof import('@/state/closet')> {
  vi.resetModules();
  ctx = {
    extensionSettings: store === undefined ? {} : { [CLOSET_KEY]: store },
    saveSettingsDebounced: vi.fn(),
  };
  events = [];
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    dispatchEvent: (e: unknown) => {
      events.push(e);
      return true;
    },
  };
  closet = await import('@/state/closet');
  closet.initCloset();
  return closet;
}

function saved(): { categories: Array<Record<string, unknown>>; outfits: Array<Record<string, unknown>>; revision: number } {
  return ctx.extensionSettings[CLOSET_KEY] as ReturnType<typeof saved>;
}

beforeEach(async () => {
  await boot();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('服装库 · 启动与领养', () => {
  it('没有用户数据时不建仓(initCloset 只读不写)', () => {
    expect(ctx.extensionSettings).toEqual({});
    expect(closet.closetLib.categories).toEqual([]);
    expect(closet.closetLib.outfits).toEqual([]);
  });

  it('领养 v2 数据:分类与条目都进内存库', async () => {
    await boot({
      schemaVersion: 2,
      revision: 7,
      categories: [{ id: 'c1', name: '校服', parentId: '' }],
      outfits: [{ id: 'o1', name: '夏制服', tags: 'navy blazer', nl: '', character: '', note: '', categoryId: 'c1' }],
    });
    expect(closet.closetLib.categories).toEqual([{ id: 'c1', name: '校服', parentId: '' }]);
    expect(closet.closetLib.outfits.length).toBe(1);
    expect(closet.closetLib.outfits[0].tags).toBe('navy blazer');
    expect(closet.closetLib.outfits[0].categoryId).toBe('c1');
  });

  it('v1 数据(只有 outfits、没有 categories)不炸,分类按空数组兜住', async () => {
    await boot({ schemaVersion: 1, outfits: [{ id: 'o1', name: '旧款', tags: 'dress' }] });
    expect(closet.closetLib.categories).toEqual([]);
    expect(closet.closetLib.outfits.length).toBe(1);
    expect(closet.closetLib.outfits[0].categoryId).toBe('');
  });

  it('缺 id 的条目补 id 保留;tags 或 name 为空的条目丢弃;重复 id 去重', async () => {
    await boot({
      outfits: [
        { name: '无id款', tags: 'dress' },
        { id: 'o1', name: '缺词串', tags: '' },
        { id: 'o2', name: '', tags: 'dress' },
        { id: 'o3', name: '正常', tags: 'skirt' },
        { id: 'o3', name: '重复id', tags: 'skirt' },
      ],
    });
    expect(closet.closetLib.outfits.length).toBe(2);
    expect(closet.closetLib.outfits[0].name).toBe('无id款');
    expect(closet.closetLib.outfits[0].id).toBeTruthy();
    expect(closet.closetLib.outfits[1].name).toBe('正常');
  });

  it('字段清洗:换行压成空格;含 bbi_image 系子标签字面量的字段被清空', async () => {
    await boot({
      outfits: [
        { id: 'o1', name: '多行', tags: 'a\nb\r\nc' },
        { id: 'o2', name: '注入<tag>尝试', tags: 'dress' },
      ],
    });
    expect(closet.closetLib.outfits.length).toBe(1);
    expect(closet.closetLib.outfits[0].tags).toBe('a b c');
  });
});

describe('服装库 · 条目 CRUD 与落盘', () => {
  it('upsertOutfit 落盘 extensionSettings、广播事件并防抖保存', () => {
    const ok = closet.upsertOutfit(closet.createOutfit(''));
    expect(ok).toBe(false); // 空名/空词串不合法
    expect(ctx.extensionSettings).toEqual({});

    const draft = { ...closet.createOutfit(''), name: '通用校服', tags: 'sailor collar, pleated skirt' };
    expect(closet.upsertOutfit(draft)).toBe(true);
    expect(saved().outfits.length).toBe(1);
    expect(saved().revision).toBeGreaterThan(0);
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
    expect(events.length).toBe(1);
  });

  it('upsertOutfit 按 id 覆盖而不是追加', () => {
    const draft = { ...closet.createOutfit(''), name: 'A', tags: 't1' };
    closet.upsertOutfit(draft);
    closet.upsertOutfit({ ...draft, tags: 't2' });
    expect(saved().outfits.length).toBe(1);
    expect(saved().outfits[0].tags).toBe('t2');
  });

  it('removeOutfit 删除条目', () => {
    const draft = { ...closet.createOutfit(''), name: 'A', tags: 't' };
    closet.upsertOutfit(draft);
    expect(closet.removeOutfit(draft.id)).toBe(true);
    expect(saved().outfits.length).toBe(0);
    expect(closet.removeOutfit('不存在')).toBe(false);
  });

  it('findOutfit / findCategory / createOutfit / createCategory 基本行为', () => {
    const cat = closet.createCategory();
    expect(cat.id).toBeTruthy();
    expect(cat.name).toBe('');
    expect(cat.parentId).toBe('');
    const outfit = closet.createOutfit('c9');
    expect(outfit.categoryId).toBe('c9');
    expect(outfit.name).toBe('');
    expect(closet.findOutfit('无')).toBeUndefined();
  });
});

describe('服装库 · 分类', () => {
  it('upsertCategory 名称为空返回 false;按 id 覆盖', () => {
    expect(closet.upsertCategory({ id: 'c1', name: '  ', parentId: '' })).toBe(false);
    closet.upsertCategory({ id: 'c1', name: '校服', parentId: '' });
    closet.upsertCategory({ id: 'c1', name: '制服', parentId: '' });
    expect(saved().categories.length).toBe(1);
    expect(saved().categories[0].name).toBe('制服');
  });

  it('removeCategory 只删分类,条目落「未分类」而不是被删掉', () => {
    closet.upsertCategory({ id: 'c1', name: '校服', parentId: '' });
    const outfit = { ...closet.createOutfit('c1'), name: '夏制服', tags: 'navy blazer' };
    closet.upsertOutfit(outfit);
    expect(closet.removeCategory('c1')).toBe(true);
    expect(saved().categories.length).toBe(0);
    expect(saved().outfits.length).toBe(1); // 用户攒的词串不跟着一起没
    expect(saved().outfits[0].categoryId).toBe('');
    expect(closet.removeCategory('不存在')).toBe(false);
  });

  it('分类名会带进落盘数据(空分类允许存在)', () => {
    closet.upsertCategory({ id: 'c1', name: '空分类', parentId: '' });
    expect(saved().categories).toEqual([{ id: 'c1', name: '空分类', parentId: '' }]);
    expect(saved().outfits).toEqual([]);
  });
});
