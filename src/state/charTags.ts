import { getContext, type STMessage } from '@/st/context';
import { reactive } from 'vue';

/**
 * 角色固定外貌库。
 *
 * 真源分三层:
 * - 全局库(跨聊天):extensionSettings,由 globalCharTags.ts 管理,仅用户手动维护,
 *   AI 的 changes 对锁定名一律无效;经 setGlobalCharTagSource 注入,本模块不反向依赖它。
 * - 手动条目/旧版快照:chatMetadata[META_KEY],不随楼层删除。
 * - 自动建档与变化:目标消息 extra[BBI_CHAR_EXTRA_KEY],随消息/swipe 一起保存和删除。
 *
 * charTagLib 只是响应式派生缓存:合并基线(本聊天优先,全局补同名空缺) + 按楼层物理顺序重放自动变化。
 */

// [v11·2026-10-14] 外貌字段从 8 字段(同人身份/性别/头发/眼睛/肤色/体型/标志特征/固定着装)
//   切换为手机UI对齐的 11 字段(角色特征 + 面部正/背 + 上身SFW正/背 + 下身SFW正/背 +
//   上身NSFW正/背 + 下身NSFW正/背)。
//   玩家以后走『外貌字段』路线,不再用『整串+lora』。
//   字段顺序即为 tag 拼接顺序;raw(整串)/nl(自然语言)仍为可选,与字段互斥优先 raw。
export type CharTagField =
  | 'characterTraits'
  | 'facialFeatures'
  | 'facialFeaturesBack'
  | 'upperBodySFW'
  | 'upperBodySFWBack'
  | 'fullBodySFW'
  | 'fullBodySFWBack'
  | 'upperBodyNSFW'
  | 'upperBodyNSFWBack'
  | 'fullBodyNSFW'
  | 'fullBodyNSFWBack';

export const CHAR_TAG_FIELDS: readonly CharTagField[] = [
  'characterTraits',
  'facialFeatures',
  'facialFeaturesBack',
  'upperBodySFW',
  'upperBodySFWBack',
  'fullBodySFW',
  'fullBodySFWBack',
  'upperBodyNSFW',
  'upperBodyNSFWBack',
  'fullBodyNSFW',
  'fullBodyNSFWBack',
];

export const CHAR_TAG_FIELD_LABELS: Record<CharTagField, string> = {
  characterTraits: '角色特征',
  facialFeatures: '面部(正)',
  facialFeaturesBack: '面部(背)',
  upperBodySFW: '上身SFW(正)',
  upperBodySFWBack: '上身SFW(背)',
  fullBodySFW: '下身SFW(正)',
  fullBodySFWBack: '下身SFW(背)',
  upperBodyNSFW: '上身NSFW(正)',
  upperBodyNSFWBack: '上身NSFW(背)',
  fullBodyNSFW: '下身NSFW(正)',
  fullBodyNSFWBack: '下身NSFW(背)',
};

export type CharTagSource = 'book' | 'manual' | 'ai';
export type CharTagHistoryField = CharTagField | 'new' | 'raw' | 'nl';

export interface CharTagChangeRecord {
  field: CharTagHistoryField;
  from: string;
  to: string;
  reason: string;
  /** 自动变化在重放时按当前物理楼号生成;手动编辑/回滚为 -1。 */
  floor: number;
  at: number;
}

/**
 * 角色专属 LoRA 绑定。
 *
 * 为什么挂在角色而不是渠道:角色 LoRA 只在该角色**出现在画面里**时才有意义。
 * 全挂在渠道里会让同框的每个角色互相污染(白发角色莫名带上紫发特征),
 * 动态挂载要解决的就是这件事。
 *
 * 仅 ComfyUI「简易参数」模式生效:自定义工作流的节点是用户自己连的,
 * 插件无法安全地往里插 LoRA 节点。
 */
export interface CharTagLora {
  /** LoRA 文件名(相对 models/loras);空串/缺省 = 未绑定。 */
  name: string;
  /** 强度,默认 1,夹在 0–2 之间。 */
  strength: number;
  /** 触发词:挂载该 LoRA 时拼进正向提示词最前面;可空。 */
  trigger: string;
}

export interface CharTagEntry {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  source: CharTagSource;
  desc: string;
  history: CharTagChangeRecord[];
  /** 角色专属 LoRA(可空);AI 永远不会写它,只由用户在角色管理页维护。 */
  lora?: CharTagLora;
  /** 收藏:角色列表里置顶显示;纯用户偏好,AI 不碰。 */
  favorite?: boolean;
}

export interface CharTagNewOp {
  kind: 'new';
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  source: 'book' | 'ai';
  desc: string;
  reason: string;
  at: number;
}

export interface CharTagSetOp {
  kind: 'set';
  name: string;
  field: CharTagField | 'raw' | 'nl';
  value: string;
  reason: string;
  at: number;
}

export type CharTagAutoOp = CharTagNewOp | CharTagSetOp;

export interface CharTagFloorDelta {
  v: 1;
  swipe: number;
  ops: CharTagAutoOp[];
}

export const BBI_CHAR_EXTRA_KEY = 'bbiCharChanges';
const META_KEY = 'baibai_image_char_tags';
const HISTORY_CAP = 50;

interface CharTagStore {
  version: 3;
  entries: CharTagEntry[];
}

export const charTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
/** 本聊天基线(手动层)里的名字,响应式——UI 用它判断「本聊天覆盖全局」。随 recompute 同步。 */
export const charTagBaseNames = reactive<Set<string>>(new Set());
let baseEntries: CharTagEntry[] = [];

/**
 * 全局角色库(跨聊天)的条目来源,由 globalCharTags.ts 启动时注入。
 * 走注入而不是 import:全局模块要用这里的 normalize/CRUD,直接互转会成模块环。
 */
let globalCharTagSource: () => CharTagEntry[] = () => [];

export function setGlobalCharTagSource(provider: () => CharTagEntry[]): void {
  globalCharTagSource = provider;
}

/**
 * 派生种子 = 本聊天基线 + 全局库补同名空缺(本聊天同名条目优先,即「本聊天覆盖全局」)。
 */
export function mergeCharTagSeed(
  chatBaseEntries: CharTagEntry[],
  globalEntries: CharTagEntry[],
): CharTagEntry[] {
  if (!globalEntries.length) return chatBaseEntries;
  const chatNames = new Set(chatBaseEntries.map(entry => entry.name));
  return [...chatBaseEntries, ...globalEntries.filter(entry => !chatNames.has(entry.name))];
}

/**
 * 锁定名集:全局库里有、且本聊天基线没有同名条目的角色。
 * AI 的 changes 对锁定名一律无效——全局条目只由用户手动维护,tag 有问题用户自己改。
 * 本聊天手动建同名条目即移出锁定(用户明确要的「本聊天覆盖」,AI 可照常变更它)。
 */
export function computeLockedCharTagNames(
  chatBaseEntries: CharTagEntry[],
  globalEntries: CharTagEntry[],
): Set<string> {
  if (!globalEntries.length) return new Set();
  const chatNames = new Set(chatBaseEntries.map(entry => entry.name));
  return new Set(
    globalEntries.filter(entry => !chatNames.has(entry.name)).map(entry => entry.name),
  );
}

function mergedSeedEntries(): CharTagEntry[] {
  return mergeCharTagSeed(baseEntries, globalCharTagSource());
}

/** 当前生效的锁定名集(全局 ⊖ 本聊天基线)。 */
export function lockedCharTagNames(): ReadonlySet<string> {
  return computeLockedCharTagNames(baseEntries, globalCharTagSource());
}

export function emptyCharFields(): Record<CharTagField, string> {
  return {
    characterTraits: '',
    facialFeatures: '',
    facialFeaturesBack: '',
    upperBodySFW: '',
    upperBodySFWBack: '',
    fullBodySFW: '',
    fullBodySFWBack: '',
    upperBodyNSFW: '',
    upperBodyNSFWBack: '',
    fullBodyNSFW: '',
    fullBodyNSFWBack: '',
  };
}

export function charFieldsEmpty(fields: Record<CharTagField, string>): boolean {
  return CHAR_TAG_FIELDS.every(field => !(fields[field] ?? '').trim());
}

/**
 * 条目的「可出图外貌串」。**三选一,优先级固定**:
 *   1. LoRA 绑定 → 触发词串(外貌由 LoRA 决定,字段/整串一律不下发)
 *   2. 整串(raw)非空 → 整串
 *   3. 否则 → 11 字段按固定顺序拼接
 * 三者同时有值时只取最高优先级那一份,不混拼——混拼会让模型收到两套互相冲突的外貌。
 */
export function buildEntryTag(
  entry: Pick<CharTagEntry, 'fields' | 'raw'> & { lora?: CharTagLora },
): string {
  if (entry.lora?.name.trim()) return entry.lora.trigger.trim();
  if (entry.raw.trim()) return entry.raw.trim();
  return CHAR_TAG_FIELDS.map(field => (entry.fields[field] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function isHistoryField(value: string): value is CharTagHistoryField {
  return (CHAR_TAG_FIELDS as readonly string[]).includes(value) || value === 'new' || value === 'raw' || value === 'nl';
}

function isSetField(value: string): value is CharTagSetOp['field'] {
  return (CHAR_TAG_FIELDS as readonly string[]).includes(value) || value === 'raw' || value === 'nl';
}

function normalizeHistory(raw: unknown): CharTagChangeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: CharTagChangeRecord[] = [];
  for (const item of raw.slice(-HISTORY_CAP)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<CharTagChangeRecord>;
    const field = typeof record.field === 'string' ? record.field : '';
    if (!isHistoryField(field)) continue;
    out.push({
      field,
      from: typeof record.from === 'string' ? record.from : '',
      to: typeof record.to === 'string' ? record.to : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      floor: typeof record.floor === 'number' && Number.isFinite(record.floor) ? record.floor : -1,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
    });
  }
  return out;
}

function normalizeFields(raw: unknown): Record<CharTagField, string> {
  const fields = emptyCharFields();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fields;
  for (const field of CHAR_TAG_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string') fields[field] = value.trim();
  }
  return fields;
}

/** LoRA 绑定的宽容归一:名字为空即视为未绑定;强度缺省 1,夹在 0–2。 */
function normalizeLora(raw: unknown): CharTagLora | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Partial<CharTagLora>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return undefined;
  const strength =
    typeof value.strength === 'number' && Number.isFinite(value.strength)
      ? Math.min(2, Math.max(0, value.strength))
      : 1;
  return {
    name,
    strength,
    trigger: typeof value.trigger === 'string' ? value.trigger.trim() : '',
  };
}

function normalizeEntry(raw: unknown): CharTagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CharTagEntry> & { tags?: unknown };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const fields = normalizeFields(value.fields);
  const legacyTags = typeof value.tags === 'string' ? value.tags.trim() : '';
  const rawTag = typeof value.raw === 'string' ? value.raw.trim() : legacyTags;
  if (!rawTag && charFieldsEmpty(fields)) return null;
  return {
    name,
    fields,
    raw: rawTag,
    nl: typeof value.nl === 'string' ? value.nl.trim() : '',
    source: value.source === 'book' || value.source === 'ai' ? value.source : 'manual',
    desc: typeof value.desc === 'string' ? value.desc : '',
    history: normalizeHistory(value.history),
    lora: normalizeLora(value.lora),
    // 未收藏不产生该键:与存量解析结果逐字段一致
    ...(value.favorite === true ? { favorite: true } : {}),
  };
}

function cloneEntry(entry: CharTagEntry): CharTagEntry {
  return {
    ...entry,
    fields: { ...entry.fields },
    history: entry.history.map(record => ({ ...record })),
    lora: entry.lora ? { ...entry.lora } : undefined,
  };
}

export function normalizeCharTagStore(raw: unknown): CharTagEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = (raw as Partial<CharTagStore>).entries;
  if (!Array.isArray(entries)) return [];
  const out: CharTagEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const entry = normalizeEntry(item);
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

function normalizeAutoOp(raw: unknown): CharTagAutoOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
  if (!name) return null;
  if (value.kind === 'new') {
    const fields = normalizeFields(value.fields);
    const rawTag = typeof value.raw === 'string' ? value.raw.trim() : '';
    if (!rawTag && charFieldsEmpty(fields)) return null;
    return {
      kind: 'new',
      name,
      fields,
      raw: rawTag,
      nl: typeof value.nl === 'string' ? value.nl.trim() : '',
      source: value.source === 'book' ? 'book' : 'ai',
      desc: typeof value.desc === 'string' ? value.desc : '',
      reason: typeof value.reason === 'string' ? value.reason : '',
      at,
    };
  }
  const field = typeof value.field === 'string' ? value.field : '';
  const next = typeof value.value === 'string' ? value.value.trim() : '';
  if (value.kind !== 'set' || !isSetField(field) || !next) return null;
  return {
    kind: 'set',
    name,
    field,
    value: next,
    reason: typeof value.reason === 'string' ? value.reason : '',
    at,
  };
}

export function readCharTagFloorDelta(message: STMessage | undefined): CharTagFloorDelta | null {
  const raw = message?.extra?.[BBI_CHAR_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CharTagFloorDelta>;
  if (value.v !== 1 || !Array.isArray(value.ops)) return null;
  const swipe = typeof value.swipe === 'number' && Number.isInteger(value.swipe) ? value.swipe : 0;
  const ops = value.ops.map(normalizeAutoOp).filter((op): op is CharTagAutoOp => !!op);
  return { v: 1, swipe, ops };
}

function activeSwipe(message: STMessage): number {
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function pushHistory(entry: CharTagEntry, record: CharTagChangeRecord): void {
  entry.history.push(record);
  if (entry.history.length > HISTORY_CAP) entry.history.splice(0, entry.history.length - HISTORY_CAP);
}

export function createCharTagNewOp(
  entry: Pick<CharTagEntry, 'name' | 'fields' | 'raw' | 'nl' | 'source' | 'desc'>,
  reason = '',
  at = Date.now(),
): CharTagNewOp | null {
  const normalized = normalizeEntry({ ...entry, history: [] });
  if (!normalized) return null;
  return {
    kind: 'new',
    name: normalized.name,
    fields: normalized.fields,
    raw: normalized.raw,
    nl: normalized.nl,
    source: normalized.source === 'book' ? 'book' : 'ai',
    desc: normalized.desc,
    reason,
    at,
  };
}

export function createCharTagSetOp(
  name: string,
  field: CharTagSetOp['field'],
  value: string,
  reason = '',
  at = Date.now(),
): CharTagSetOp | null {
  const cleanName = name.trim();
  const cleanValue = value.trim();
  if (!cleanName || !cleanValue) return null;
  return { kind: 'set', name: cleanName, field, value: cleanValue, reason, at };
}

export function applyCharTagOps(
  entries: CharTagEntry[],
  ops: CharTagAutoOp[],
  floor: number,
  locked?: ReadonlySet<string>,
): CharTagEntry[] {
  const out = entries.map(cloneEntry);
  for (const op of ops) {
    // 锁定角色(全局库)不接受 AI changes:无论 new 还是 set 一律丢弃
    if (locked?.has(op.name)) continue;
    if (op.kind === 'new') {
      if (out.some(entry => entry.name === op.name)) continue;
      const entry: CharTagEntry = {
        name: op.name,
        fields: { ...op.fields },
        raw: op.raw,
        nl: op.nl,
        source: op.source,
        desc: op.desc,
        history: [],
      };
      pushHistory(entry, {
        field: 'new',
        from: '',
        to: buildEntryTag(entry),
        reason: op.reason,
        floor,
        at: op.at,
      });
      out.push(entry);
      continue;
    }

    const entry = out.find(candidate => candidate.name === op.name);
    if (!entry) continue;
    // 整串优先于字段:整串非空时,字段级 changes 不会影响最终出图串,直接丢弃
    if (op.field !== 'raw' && op.field !== 'nl' && entry.raw.trim()) continue;
    const current = op.field === 'raw' ? entry.raw : op.field === 'nl' ? entry.nl : entry.fields[op.field];
    if (current === op.value) continue;
    if (op.field === 'raw') entry.raw = op.value;
    else if (op.field === 'nl') entry.nl = op.value;
    else entry.fields[op.field] = op.value;
    entry.source = 'ai';
    entry.desc = '';
    pushHistory(entry, {
      field: op.field,
      from: current,
      to: op.value,
      reason: op.reason,
      floor,
      at: op.at,
    });
  }
  return out;
}

export function deriveCharTags(
  seedEntries: CharTagEntry[],
  chat: STMessage[],
  upToExclusive = chat.length,
  locked?: ReadonlySet<string>,
): CharTagEntry[] {
  let entries = seedEntries.map(cloneEntry);
  const end = Math.min(Math.max(0, upToExclusive), chat.length);
  for (let floor = 0; floor < end; floor += 1) {
    const message = chat[floor];
    const delta = readCharTagFloorDelta(message);
    if (!delta || delta.swipe !== activeSwipe(message)) continue;
    entries = applyCharTagOps(entries, delta.ops, floor, locked);
  }
  return entries;
}

export function charTagsBeforeFloor(floor: number): CharTagEntry[] {
  const chat = getContext()?.chat ?? [];
  return deriveCharTags(mergedSeedEntries(), chat, floor, lockedCharTagNames());
}

export function makeCharTagFloorDelta(ops: CharTagAutoOp[], swipe: number): CharTagFloorDelta | undefined {
  return ops.length ? { v: 1, swipe, ops } : undefined;
}

export function recomputeCharTags(): void {
  const chat = getContext()?.chat ?? [];
  charTagLib.entries = deriveCharTags(mergedSeedEntries(), chat, chat.length, lockedCharTagNames());
  charTagBaseNames.clear();
  for (const entry of baseEntries) charTagBaseNames.add(entry.name);
}

export function hydrateCharTags(): void {
  const raw = getContext()?.chatMetadata?.[META_KEY];
  // v2 的整库快照无法可靠反推来源楼层,迁移时作为基线保留,避免丢用户现有数据。
  baseEntries = normalizeCharTagStore(raw);
  recomputeCharTags();
}

function persistBase(): void {
  const context = getContext();
  if (!context?.chatMetadata) return;
  const store: CharTagStore = {
    version: 3,
    entries: baseEntries.map(cloneEntry),
  };
  context.chatMetadata[META_KEY] = store;
  context.saveMetadataDebounced?.();
}

function stripOpsFromExtra(extra: Record<string, unknown> | undefined, names: Set<string>): boolean {
  if (!extra) return false;
  const raw = extra[BBI_CHAR_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Partial<CharTagFloorDelta>;
  if (value.v !== 1 || !Array.isArray(value.ops)) return false;
  const nextOps = value.ops
    .map(normalizeAutoOp)
    .filter((op): op is CharTagAutoOp => !!op && !names.has(op.name));
  if (nextOps.length === value.ops.length) return false;
  if (nextOps.length) {
    extra[BBI_CHAR_EXTRA_KEY] = {
      v: 1,
      swipe: typeof value.swipe === 'number' ? value.swipe : 0,
      ops: nextOps,
    } satisfies CharTagFloorDelta;
  } else {
    delete extra[BBI_CHAR_EXTRA_KEY];
  }
  return true;
}

/**
 * 手动编辑/删除意味着用户接管当前结果:把该角色过去的自动楼层操作压进手动基线,
 * 并清掉已有消息里的同名操作。之后的新楼层仍可继续由 AI 变更。
 */
function detachFromExistingFloors(...rawNames: Array<string | undefined>): void {
  const names = new Set(rawNames.map(name => name?.trim()).filter((name): name is string => !!name));
  const context = getContext();
  if (!names.size || !context?.chat) return;
  let changed = false;
  for (const message of context.chat) {
    changed = stripOpsFromExtra(message.extra, names) || changed;
    for (const swipeInfo of message.swipe_info ?? []) {
      changed = stripOpsFromExtra(swipeInfo?.extra, names) || changed;
    }
  }
  if (changed) {
    void context.saveChat?.().catch(error => {
      console.warn('[柏宝绘] 手动角色变更已生效,但清理旧楼层角色记录保存失败', error);
    });
  }
}

export function findCharTag(name: string): CharTagEntry | undefined {
  return charTagLib.entries.find(entry => entry.name === name);
}

export interface UpsertOptions {
  recordChanges?: boolean;
}

export function upsertCharTag(
  entry: CharTagEntry,
  oldName?: string,
  opts: UpsertOptions = {},
): boolean {
  const name = entry.name.trim();
  // LoRA 模式下没有外貌字段/整串是合法的:外貌由 LoRA 决定
  if (!name || (!buildEntryTag(entry) && !entry.lora?.name)) return false;
  const previous = findCharTag(oldName ?? name);
  const next: CharTagEntry = {
    name,
    fields: normalizeFields(entry.fields),
    raw: entry.raw.trim(),
    nl: entry.nl.trim(),
    source: entry.source,
    desc: entry.desc,
    history: entry.history.length
      ? entry.history.map(record => ({ ...record }))
      : (previous?.history.map(record => ({ ...record })) ?? []),
    // LoRA 绑定只由角色管理页维护:这里以入参为准(不传 = 解绑)。
    // 内部调用方(回滚/提升全局/复制回本聊天)都是基于现有条目展开,会自带 lora。
    lora: entry.lora ? { ...entry.lora } : undefined,
    ...(entry.favorite === true ? { favorite: true } : {}),
  };
  if (opts.recordChanges && previous) {
    const at = Date.now();
    for (const field of CHAR_TAG_FIELDS) {
      if (previous.fields[field] !== next.fields[field]) {
        pushHistory(next, {
          field,
          from: previous.fields[field],
          to: next.fields[field],
          reason: '手动编辑',
          floor: -1,
          at,
        });
      }
    }
    if (previous.raw !== next.raw && (previous.raw || next.raw)) {
      pushHistory(next, { field: 'raw', from: previous.raw, to: next.raw, reason: '手动编辑', floor: -1, at });
    }
    if (previous.nl !== next.nl && (previous.nl || next.nl)) {
      pushHistory(next, { field: 'nl', from: previous.nl, to: next.nl, reason: '手动编辑', floor: -1, at });
    }
  }

  detachFromExistingFloors(oldName, name);
  if (oldName && oldName !== name) {
    const oldIndex = baseEntries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) baseEntries.splice(oldIndex, 1);
  }
  const index = baseEntries.findIndex(candidate => candidate.name === name);
  if (index >= 0) baseEntries[index] = next;
  else baseEntries.push(next);
  persistBase();
  recomputeCharTags();
  return true;
}

export function removeCharTag(name: string): boolean {
  const cleanName = name.trim();
  if (!cleanName || !findCharTag(cleanName)) return false;
  detachFromExistingFloors(cleanName);
  const index = baseEntries.findIndex(entry => entry.name === cleanName);
  if (index >= 0) baseEntries.splice(index, 1);
  persistBase();
  recomputeCharTags();
  return true;
}

export function rollbackCharTag(name: string, record: CharTagChangeRecord): boolean {
  const current = findCharTag(name);
  if (!current) return false;
  if (record.field === 'new') return removeCharTag(name);
  const next = cloneEntry(current);
  if (record.field === 'raw') next.raw = record.from;
  else if (record.field === 'nl') next.nl = record.from;
  else next.fields[record.field] = record.from;
  next.source = 'manual';
  next.desc = '';
  pushHistory(next, {
    field: record.field,
    from: record.to,
    to: record.from,
    reason: '手动回滚',
    floor: -1,
    at: Date.now(),
  });
  return upsertCharTag(next, name);
}

let bound = false;

export function bindCharTagSync(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, hydrateCharTags);
  const recomputeLater = () => setTimeout(recomputeCharTags, 0);
  if (context.eventTypes.MESSAGE_DELETED) {
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, recomputeLater);
  }
  if (context.eventTypes.MESSAGE_SWIPED) {
    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, recomputeLater);
  }
  hydrateCharTags();
}
