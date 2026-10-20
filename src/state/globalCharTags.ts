import { getContext } from '@/st/context';
import { reactive } from 'vue';
import {
  normalizeCharTagStore,
  recomputeCharTags,
  setGlobalCharTagSource,
  type CharTagEntry,
} from '@/state/charTags';

/**
 * 角色库(跨所有聊天) —— 柏宝绘唯一的可写角色档案层。
 *
 * [2026-10-20] 本聊天层已下线:角色形象只有两个地方 —— 柏宝绘(本库)与手机UI(只读镜像)。
 * 硬约束:**AI 永远不写它**;只有用户在角色管理页手动增删改、或从手机UI 影子
 * 「添加到角色库」会写。tag 有问题用户自己改。
 *
 * 存储:extensionSettings[GLOBAL_KEY](→ 服务器 settings.json,跨设备同步),
 * 带 revision + 广播事件,协议与 settings.ts 的共享渠道/排除名单同构。
 * 条目结构复用 CharTagEntry,但**不记 history**(跨聊天没有楼层概念,也没有可回滚的 AI 变更)。
 *
 * 依赖方向:本模块 → charTags(normalize/CRUD/重算);charTags → 本模块只经
 * setGlobalCharTagSource 注入的只读 getter,不成模块环。
 */

const GLOBAL_KEY = 'baibai_image_char_global';
const GLOBAL_EVENT = 'st-baibai-image:char-global-changed';
const SCHEMA_VERSION = 1;

interface GlobalCharTagStore {
  schemaVersion: number;
  revision: number;
  entries: CharTagEntry[];
}

export const globalCharTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
let fingerprint = '';
let revision = 0;
let listenerBound = false;

function fingerprintOf(entries: CharTagEntry[]): string {
  return JSON.stringify(entries);
}

/** 全局条目一律不带 history(没有可回滚的自动变更,手动编辑也不留痕,保持简单)。 */
function normalizeGlobalEntries(raw: unknown): CharTagEntry[] {
  return normalizeCharTagStore(raw).map(entry => ({ ...entry, history: [] }));
}

function readStore(raw: unknown): GlobalCharTagStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<GlobalCharTagStore>;
  if (!Array.isArray(store.entries)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    entries: normalizeGlobalEntries({ version: 3, entries: store.entries }),
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: GlobalCharTagStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    entries: JSON.parse(JSON.stringify(globalCharTagLib.entries)) as CharTagEntry[],
  };
  ctx.extensionSettings[GLOBAL_KEY] = store;
  fingerprint = fingerprintOf(store.entries);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(GLOBAL_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: GlobalCharTagStore): void {
  const next = fingerprintOf(store.entries);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  globalCharTagLib.entries = store.entries;
  fingerprint = next;
  // 派生库(合并种子 + 锁定名)随全局库变化即时刷新
  recomputeCharTags();
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(GLOBAL_EVENT, () => {
    const ctx = getContext();
    const store = readStore(ctx?.extensionSettings?.[GLOBAL_KEY]);
    if (store) applyStore(store);
  });
}

/**
 * 启动初始化:注入条目来源(必须在 bindCharTagSync 之前,首次重算就要带上全局库),
 * 再从 extensionSettings 领养已有数据并挂上广播监听。
 */
export function initGlobalCharTags(): void {
  setGlobalCharTagSource(() => globalCharTagLib.entries);
  const ctx = getContext();
  if (ctx?.extensionSettings) {
    const store = readStore(ctx.extensionSettings[GLOBAL_KEY]);
    if (store) applyStore(store);
  }
  bindListener();
}

export function findGlobalCharTag(name: string): CharTagEntry | undefined {
  const clean = name.trim();
  return globalCharTagLib.entries.find(entry => entry.name === clean);
}

/** 新增/覆盖全局条目(仅用户手动路径调用;oldName 用于改名)。 */
export function upsertGlobalCharTag(entry: CharTagEntry, oldName?: string): boolean {
  const name = entry.name.trim();
  const [normalized] = normalizeGlobalEntries({ version: 3, entries: [{ ...entry, name }] });
  if (!normalized) return false;
  if (oldName && oldName !== name) {
    const oldIndex = globalCharTagLib.entries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) globalCharTagLib.entries.splice(oldIndex, 1);
  }
  const index = globalCharTagLib.entries.findIndex(candidate => candidate.name === name);
  if (index >= 0) globalCharTagLib.entries[index] = normalized;
  else globalCharTagLib.entries.push(normalized);
  persist();
  recomputeCharTags();
  return true;
}

export function removeGlobalCharTag(name: string): boolean {
  const clean = name.trim();
  const index = globalCharTagLib.entries.findIndex(entry => entry.name === clean);
  if (index < 0) return false;
  globalCharTagLib.entries.splice(index, 1);
  persist();
  recomputeCharTags();
  return true;
}

/**
 * 批量删除全局条目,**一次**落盘 + 一次重算。
 *
 * 与 removeGlobalCharTag 同口径,只是不逐条写盘:全局库动辄几十条(从手机UI 导入过一次
 * 就是几十),循环调用等于几十次 extensionSettings 序列化 + saveSettingsDebounced,
 * 还会连带几十次 recomputeCharTags(整段楼层重放)。
 * @returns 实际删除的条数。
 */
export function removeGlobalCharTagsByNames(names: readonly string[]): number {
  const wanted = new Set(names.map(name => name.trim()).filter(Boolean));
  if (!wanted.size) return 0;
  const before = globalCharTagLib.entries.length;
  globalCharTagLib.entries = globalCharTagLib.entries.filter(entry => !wanted.has(entry.name));
  const removed = before - globalCharTagLib.entries.length;
  if (removed > 0) {
    persist();
    recomputeCharTags();
  }
  return removed;
}

/**
 * 批量收藏/取消收藏全局条目。全局条目本来就整条存在 extensionSettings 里,不需要像本聊天
 * 那样先「沉进基线」;一次落盘 + 一次重算即可。
 * @returns 收藏状态真正发生变化的条数。
 */
export function setGlobalCharTagsFavoriteByNames(
  names: readonly string[],
  favorite: boolean,
): number {
  const wanted = new Set(names.map(name => name.trim()).filter(Boolean));
  if (!wanted.size) return 0;
  let changed = 0;
  for (const entry of globalCharTagLib.entries) {
    if (!wanted.has(entry.name)) continue;
    if ((entry.favorite === true) === favorite) continue;
    if (favorite) entry.favorite = true;
    else delete entry.favorite;
    changed += 1;
  }
  if (changed > 0) {
    persist();
    recomputeCharTags();
  }
  return changed;
}

/* 「提升为全局 / 复制到本聊天」两条层间迁移随本聊天层下线删除:
 * 现在只有一层(角色库),手机UI 的角色通过「添加到角色库」进来。 */
