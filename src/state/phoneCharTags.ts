/**
 * 手机UI『角色形象』的只读镜像层(state)。
 *
 * 定位:**影子库**不是副本库 —— 内容不落盘到柏宝绘,每次从手机UI 现读(带指纹短路),
 * 因此手机UI 那边改/删/清空,这边自动跟着变,不存在两份数据打架。
 *
 * 为什么做成「影子」而不是「导入」:
 * 之前点「一键导入手机UI」是把手机UI 的快照 upsert 进**全局库**(跨聊天),
 * 而手机UI 的缓存是 chatMetadata(**按聊天**)——一部聊天的角色被固化进跨聊天的库,
 * 攒几次就变成几十条永远不删的拷贝(现场:66 条)。影子层把作用域还回去:
 * 手机UI 的角色只出现在「本聊天角色」里,换聊天自动换一套。
 *
 * 界面口径(见 更新文档/2026-10-20-*):
 * - 全部并入「本聊天角色」分区,带「手机UI」徽标、只读;
 * - **全局库已有的同名角色一律跳过**(全局是用户手动固定的,不能被影子盖住,
 *   也不允许复制成本聊天副本——那会让固定失效);
 * - 影子条目锁定,AI 的 changes 一律不收(且 2026-10-20 起 changes 已整体关闭)。
 */

import { getContext } from '@/st/context';
import {
  readPhoneRoles,
  describePhoneRoleOrigin,
  type PhoneRoleMeta,
  type PhoneRoleOrigin,
} from '@/st/phoneRoles';
import {
  recomputeCharTags,
  setPhoneCharTagSource,
  type CharTagEntry,
} from '@/state/charTags';
import { globalCharTagLib } from '@/state/globalCharTags';
import { reactive } from 'vue';

interface PhoneCharTagState {
  /** 已排除「全局库同名」之后、真正要显示在「本聊天角色」里的影子条目。 */
  entries: CharTagEntry[];
  meta: Record<string, PhoneRoleMeta>;
  origin: PhoneRoleOrigin | null;
  /** 手机UI 的「角色形象」总开关。 */
  enabled: boolean;
  /** 上次真正读到数据的时间戳(0 = 从没读到过)。 */
  updatedAt: number;
  /** 手机UI 有、但因全局库同名被跳过的条数(界面用它解释「为什么少了几个人」)。 */
  skippedByGlobal: number;
  /** 一句人话的来源说明,直接显示在状态条上。 */
  originLabel: string;
}

export const phoneCharTagLib = reactive<PhoneCharTagState>({
  entries: [],
  meta: {},
  origin: null,
  enabled: true,
  updatedAt: 0,
  skippedByGlobal: 0,
  originLabel: '',
});

/** 指纹:名字 + 整串 + 11 字段的稳定序列化;没变就不重算派生库(2s 轮询靠它压开销)。 */
function fingerprintOf(entries: CharTagEntry[], origin: PhoneRoleOrigin | null, enabled: boolean): string {
  return JSON.stringify([
    origin,
    enabled,
    entries.map(entry => [entry.name, entry.raw, entry.fields]),
  ]);
}

let fingerprint = '';
let watcher: ReturnType<typeof setInterval> | null = null;
let boundChatChanged = false;

/**
 * 现读一次手机UI 并把结果灌进响应式状态。
 * @param force true = 无视指纹,强制刷新(用户点「刷新」/切聊天时用)。
 * @returns 是否真的变了(变了才需要重算派生库,调用方可据此省掉一次全量重放)。
 */
export function refreshPhoneCharTags(force = false): boolean {
  let snapshot;
  try {
    snapshot = readPhoneRoles();
  } catch (error) {
    console.warn('[柏宝绘] 读取手机UI 角色形象失败', error);
    return false;
  }
  const globalNames = new Set(globalCharTagLib.entries.map(entry => entry.name));
  const kept = snapshot.entries.filter(entry => !globalNames.has(entry.name));
  const next = fingerprintOf(kept, snapshot.origin, snapshot.enabled);
  const changed = next !== fingerprint;
  phoneCharTagLib.skippedByGlobal = snapshot.entries.length - kept.length;
  phoneCharTagLib.origin = snapshot.origin;
  phoneCharTagLib.enabled = snapshot.enabled;
  phoneCharTagLib.originLabel = describePhoneRoleOrigin(snapshot);
  if (!changed && !force) return false;
  fingerprint = next;
  phoneCharTagLib.entries = kept;
  phoneCharTagLib.meta = snapshot.meta;
  if (kept.length || snapshot.origin) phoneCharTagLib.updatedAt = Date.now();
  return changed;
}

/** 影子库当前的名字集(界面判断「这条是手机UI 的、只读」)。 */
export function phoneCharTagNames(): ReadonlySet<string> {
  return new Set(phoneCharTagLib.entries.map(entry => entry.name));
}

/**
 * 启动接线:注入派生库来源 + 跟随切聊天刷新 + 先读一次。
 * 必须在 `bindCharTagSync()` 之前调用——首次重算就要带上影子条目。
 */
export function initPhoneCharTags(): void {
  setPhoneCharTagSource(() => phoneCharTagLib.entries);
  refreshPhoneCharTags(true);
  if (boundChatChanged) return;
  const context = getContext();
  const events = context?.eventTypes;
  if (!context?.eventSource || !events?.CHAT_CHANGED) return;
  boundChatChanged = true;
  context.eventSource.on(events.CHAT_CHANGED, () => {
    // 影子是「按聊天」的:切聊天先清空再读,避免把上一部聊天的角色带进新聊天
    resetPhoneCharTags();
    if (refreshPhoneCharTags(true)) notifyReseed();
  });
}

/** 清空影子(切聊天时用);同时让派生库重算一次,免得旧条目残留。 */
export function resetPhoneCharTags(): void {
  fingerprint = '';
  phoneCharTagLib.entries = [];
  phoneCharTagLib.meta = {};
  phoneCharTagLib.origin = null;
  phoneCharTagLib.updatedAt = 0;
  phoneCharTagLib.skippedByGlobal = 0;
  phoneCharTagLib.originLabel = describePhoneRoleOrigin({
    entries: [],
    meta: {},
    origin: null,
    enabled: true,
  });
}

/** 派生库重算:影子条目进了种子链,内容一变就要重放一次(与全局库同口径)。 */
function notifyReseed(): void {
  recomputeCharTags();
}

/**
 * 角色管理页打开期间的准实时轮询:手机UI 那边一生成,这里 2s 内就能看到。
 * 只读对象 + 指纹短路,成本远低于手机UI 自己 30s 的「跨 realm 调用 + 缓存」口径。
 * @returns 停止函数(onUnmounted 调用)。
 */
export function watchPhoneCharTags(intervalMs = 2000): () => void {
  if (watcher) clearInterval(watcher);
  watcher = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (refreshPhoneCharTags()) notifyReseed();
  }, intervalMs);
  return () => stopPhoneCharTagWatch();
}

export function stopPhoneCharTagWatch(): void {
  if (!watcher) return;
  clearInterval(watcher);
  watcher = null;
}
