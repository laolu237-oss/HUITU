import { randomUuid } from '@/randomUuid';
import { getContext } from '@/st/context';
import { reactive } from 'vue';

/**
 * 服装库 —— 一份跨聊天复用的**共享服装池**，按用户自建分类分组。
 *
 * 定位:与「角色固定外貌库」并列的第二份档案,但归属方式完全不同——
 * 角色库按角色建档(一个角色一条),服装库是**一个池子**,不按角色分区,
 * 用户往里攒各种款式并自己分类,生成时由 AI 从中挑一套贴合正文情境的。
 *
 * 分类为什么是独立实体、而不是条目上的一个字符串字段:
 * - 空分类要能存在(用户建了「校服」还没往里放东西);
 * - 改分类名不该逐条遍历条目;
 * - 删分类要能问「里面的衣服怎么办」(本实现:移到未分类,不删衣服)。
 *
 * 存储:extensionSettings[CLOSET_KEY](→ 服务器 settings.json,跨设备同步),
 * 带 revision + 广播事件,协议与 globalCharTags.ts / settings.ts 的共享渠道同构。
 *
 * 硬约束一:**AI 永远不能写它**。服装是临时状态,若允许 AI 自动入库,
 * 每换一次装就多一条,库会迅速失控。本模块只暴露给界面层的增删改。
 *
 * 硬约束二:**没有用户数据就不建仓**(沿袭 settings.ts 的共享存储事故教训,
 * 见 sharedStoreGuard.test.ts):initCloset 只读不写,首次落盘只发生在
 * 用户真的增删条目时。否则每个装了插件却没用过衣柜的用户,
 * settings.json 里都会多出一坨空壳。
 */

const CLOSET_KEY = 'baibai_image_closet';
const CLOSET_EVENT = 'st-baibai-image:closet-changed';
/** v2 起加 categories(分类)与 outfit.categoryId。旧数据靠 normalize 补默认值,无需显式迁移。 */
const SCHEMA_VERSION = 2;

export interface ClosetCategory {
  id: string;
  name: string;
  /**
   * 父分类 id;空串 = 顶层分类。
   *
   * **当前界面只渲染顶层**(见 pages/characters 的 closetGroups)。
   * 留这个字段是为了将来的子分类:真要做时只需改界面,数据不用迁移。
   * 按用户给的量级(池子 50 套封顶),一层分类已经够用——两层会让每个叶子只剩两三套。
   */
  parentId: string;
}

export interface ClosetOutfit {
  /** 稳定 id。改名不破坏引用,也是界面列表的 key(与角色库按名索引用法不同)。 */
  id: string;
  /** 显示名,如「夏制服」。 */
  name: string;
  /** 英文 danbooru 词串 —— 生成时被照抄进提示词的就是它。 */
  tags: string;
  /** 自然语言模式备用(当前工作流 nl 关闭,可留空)。 */
  nl: string;
  /**
   * 仅限角色;空串 = 通用款,任何角色都能挑。
   * 存在的意义:池子里若混入某角色的标志性造型(如某人的专属甲胄),
   * 没有这个字段 AI 就可能把它穿到别人身上。
   */
  character: string;
  /** 备注,只给用户看,不进请求。 */
  note: string;
  /** 所属分类 id;空串 = 未分类。指向已删分类时也按未分类处理(见界面层的分组)。 */
  categoryId: string;
}

interface ClosetStore {
  schemaVersion: number;
  revision: number;
  categories: ClosetCategory[];
  outfits: ClosetOutfit[];
}

export const closetLib = reactive<{
  categories: ClosetCategory[];
  outfits: ClosetOutfit[];
}>({ categories: [], outfits: [] });

let fingerprint = '';
let revision = 0;
let listenerBound = false;

/** 单行化 + 剥掉 bbi_image 系子标签字面量(防止污染注入格式,与 charAnchors 同口径)。 */
function sanitizeText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!text) return '';
  if (/<\/?(?:bbi_image|tag|nl|size)\b/i.test(text)) return '';
  return text;
}

function normalizeCategory(raw: unknown): ClosetCategory | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ClosetCategory>;
  const name = sanitizeText(value.name);
  if (!name) return null;
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : randomUuid(),
    name,
    parentId: typeof value.parentId === 'string' ? value.parentId.trim() : '',
  };
}

function normalizeCategories(raw: unknown): ClosetCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: ClosetCategory[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = normalizeCategory(item);
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

function normalizeOutfit(raw: unknown): ClosetOutfit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ClosetOutfit>;
  const tags = sanitizeText(value.tags);
  if (!tags) return null; // 没有词串的条目没有任何意义
  const name = sanitizeText(value.name);
  if (!name) return null;
  return {
    // 旧数据/手改数据可能缺 id,补一个,不因为缺 id 丢条目
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : randomUuid(),
    name,
    tags,
    nl: sanitizeText(value.nl),
    character: sanitizeText(value.character),
    note: sanitizeText(value.note),
    categoryId: typeof value.categoryId === 'string' ? value.categoryId.trim() : '',
  };
}

function normalizeOutfits(raw: unknown): ClosetOutfit[] {
  if (!Array.isArray(raw)) return [];
  const out: ClosetOutfit[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = normalizeOutfit(item);
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/** 指纹要覆盖分类与条目两部分:只比条目的话,单改分类名不会触发广播同步。 */
function fingerprintOf(categories: ClosetCategory[], outfits: ClosetOutfit[]): string {
  return JSON.stringify([categories, outfits]);
}

function readStore(raw: unknown): ClosetStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<ClosetStore>;
  // v1 只有 outfits、没有 categories;这里用默认值兜住,不额外写迁移代码
  if (!Array.isArray(store.outfits)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    categories: normalizeCategories(store.categories),
    outfits: normalizeOutfits(store.outfits),
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: ClosetStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    categories: JSON.parse(JSON.stringify(closetLib.categories)) as ClosetCategory[],
    outfits: JSON.parse(JSON.stringify(closetLib.outfits)) as ClosetOutfit[],
  };
  ctx.extensionSettings[CLOSET_KEY] = store;
  fingerprint = fingerprintOf(store.categories, store.outfits);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(CLOSET_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: ClosetStore): void {
  const next = fingerprintOf(store.categories, store.outfits);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  closetLib.categories = store.categories;
  closetLib.outfits = store.outfits;
  fingerprint = next;
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(CLOSET_EVENT, () => {
    const ctx = getContext();
    const store = readStore(ctx?.extensionSettings?.[CLOSET_KEY]);
    if (store) applyStore(store);
  });
}

/** 启动初始化:从 extensionSettings 领养已有数据并挂上广播监听。**不写盘**。 */
export function initCloset(): void {
  const ctx = getContext();
  if (ctx?.extensionSettings) {
    const store = readStore(ctx.extensionSettings[CLOSET_KEY]);
    if (store) applyStore(store);
  }
  bindListener();
}

/* ============ 分类 ============ */

export function createCategory(): ClosetCategory {
  return { id: randomUuid(), name: '', parentId: '' };
}

export function findCategory(id: string): ClosetCategory | undefined {
  return closetLib.categories.find(entry => entry.id === id);
}

/** 新增或按 id 覆盖一个分类。返回 false 表示名称为空。 */
export function upsertCategory(entry: ClosetCategory): boolean {
  const normalized = normalizeCategory(entry);
  if (!normalized) return false;
  const index = closetLib.categories.findIndex(candidate => candidate.id === normalized.id);
  if (index >= 0) closetLib.categories[index] = normalized;
  else closetLib.categories.push(normalized);
  persist();
  return true;
}

/**
 * 删除分类。**只删分类,不动条目**——属于它的服装落到「未分类」,
 * 用户辛苦攒的词串不会跟着一起没。界面在确认框里要说明这一点。
 */
export function removeCategory(id: string): boolean {
  const index = closetLib.categories.findIndex(entry => entry.id === id);
  if (index < 0) return false;
  closetLib.categories.splice(index, 1);
  for (const outfit of closetLib.outfits) {
    if (outfit.categoryId === id) outfit.categoryId = '';
  }
  persist();
  return true;
}

/* ============ 服装 ============ */

/** 新建一条空草稿(尚未落盘,由界面填完后调 upsertOutfit 保存)。 */
export function createOutfit(categoryId = ''): ClosetOutfit {
  return { id: randomUuid(), name: '', tags: '', nl: '', character: '', note: '', categoryId };
}

/** 新增或按 id 覆盖一条。返回 false 表示数据不合法(名称或词串为空)。 */
export function upsertOutfit(entry: ClosetOutfit): boolean {
  const normalized = normalizeOutfit(entry);
  if (!normalized) return false;
  const index = closetLib.outfits.findIndex(candidate => candidate.id === normalized.id);
  if (index >= 0) closetLib.outfits[index] = normalized;
  else closetLib.outfits.push(normalized);
  persist();
  return true;
}

export function removeOutfit(id: string): boolean {
  const index = closetLib.outfits.findIndex(entry => entry.id === id);
  if (index < 0) return false;
  closetLib.outfits.splice(index, 1);
  persist();
  return true;
}

export function findOutfit(id: string): ClosetOutfit | undefined {
  return closetLib.outfits.find(entry => entry.id === id);
}
