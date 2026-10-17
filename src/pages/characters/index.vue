<script setup lang="ts">
import BbiCombo from '@/components/BbiCombo.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { readBookMemory } from '@/autoTag/bookMemory';
import { generateImage, decideSeed } from '@/generate';
import { prepareImageForStorage } from '@/floor/storage';
import { AVATAR_FILE_STEM, buildAvatarPrompt, isAvatarFile } from '@/characterAvatar';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charFieldsEmpty,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
  type CharTagLora,
} from '@/state/charTags';
import {
  closetLib,
  createCategory,
  createOutfit,
  removeCategory,
  removeOutfit,
  upsertCategory,
  upsertOutfit,
  type ClosetCategory,
  type ClosetOutfit,
} from '@/state/closet';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { fetchComfyModelLists } from '@/backends/comfyObjectInfo';
import { settings } from '@/state/settings';
import { listUserImageFolders, listUserImages, uploadUserImage } from '@/st/images';
import { phoneAppearanceMissHint, readPhoneAppearance } from '@/st/phoneAppearance';
import { computed, onMounted, reactive, ref, watch } from 'vue';

/**
 * 角色管理 —— 两层固定外貌库:
 * - 全局库:跨所有聊天生效的只读模板,AI 永不修改,仅手动维护(适合玩家角色等固定形象)。
 * - 本聊天库:仅当前聊天,柏宝书自动建档、AI 随剧情变更;同名时优先于全局。
 * 外貌按 11 字段记录(characterTraits/facialFeatures/... 与手机UI角色外观缓存同构),
 * 拼接结果即最终 tag;生成 tag 时 AI 照抄库中字段,
 * 残留的 @角色名 占位符由插件兜底替换 —— 外貌稳定不漂移。
 * [v11·2026-10-14] 新增「一键导入手机UI」:读手机UI 的角色外观缓存,
 * 三级来源依次回退 —— 本窗口 window.PhoneCharacterAppearance → 同源 iframe 内的同名对象
 * → ST 共享上下文 chatMetadata.yinqi_phone.character_appearances(手机UI 是酒馆助手脚本,
 * 跑在独立 iframe,主文档 window 上取不到,必须下钻或走共享存储)。
 * 同名条目按字段合并(手机UI有值的覆盖,没值的保留原值)。
 */

type Scope = 'chat' | 'global';

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

// editingName:正在编辑的已有条目名;null = 新建。弹窗开关以 draft 是否存在为准。
const editingName = ref<string | null>(null);
// editingScope:被编辑条目所在层;draftScope:草稿保存到哪层(仅新建时可选)。
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
// 草稿来源:手改内容即转 manual;「从柏宝书重新生成」后转 book。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
// 收藏:列表里置顶显示,纯用户偏好
const draftFavorite = ref(false);
// 外貌字段分组:SFW 两列平铺,NSFW 单独一页
const SFW_FIELDS = CHAR_TAG_FIELDS.filter(field => !field.includes('NSFW'));
const NSFW_FIELDS = CHAR_TAG_FIELDS.filter(field => field.includes('NSFW'));
/** 弹窗分组页签:外貌字段 / NSFW / LoRA。最终预览固定底部,不随页签切换。 */
const DIALOG_TABS = [
  { key: 'fields', label: '外貌字段' },
  { key: 'nsfw', label: 'NSFW' },
  { key: 'lora', label: 'LoRA' },
] as const;
type DialogTab = (typeof DIALOG_TABS)[number]['key'];
const dialogTab = ref<DialogTab>('fields');
/* 「更多」下拉:选中即执行,执行完立刻清空(不清的话同一项连点第二次不会触发 change)。 */
const moreAction = ref('');
const moreOptions = computed(() => {
  const items: Array<{ value: string; label: string; icon?: string }> = [
    { value: 'clear', label: '清空所有提示词', icon: 'edit' },
    { value: 'import-phone', label: '从手机 UI 导入', icon: 'download' },
    { value: 'regen', label: '从柏宝书生成', icon: 'refresh' },
  ];
  if (editingName.value && editingScope.value === 'chat') {
    items.unshift({ value: 'promote', label: '提升为全局', icon: 'star' });
  }
  if (editingName.value && editingScope.value === 'global') {
    items.unshift({ value: 'copy', label: '复制到本聊天', icon: 'copy' });
  }
  return items;
});
watch(moreAction, value => {
  if (!value) return;
  moreAction.value = '';
  if (value === 'clear') askClearAll();
  else if (value === 'import-phone') void importFromPhoneUI();
  else if (value === 'regen') void regenerateFromBook();
  else if (value === 'promote') askPromote();
  else if (value === 'copy') copyToChat();
});

/* —— 角色专属 LoRA ——
 * 绑定挂在角色条目上:只有该角色出现在画面里时,出图才挂载这个 LoRA 并把触发词拼进
 * 正向提示词(见 generate.ts / characterLora.ts)。渠道里同名 LoRA 会被自动剔除,
 * 避免同框角色互相污染。仅 ComfyUI「简易参数」模式生效。 */
const draftLoraName = ref('');
const draftLoraStrength = ref(1);
const draftLoraTrigger = ref('');
// 候选来自 ComfyUI 的 LoRA 目录;服务未启动/走服务端代理时为空,此时仍可手填文件名。
const loraOptions = ref<string[]>([]);
const loraLoading = ref(false);
async function ensureLoraOptions(): Promise<void> {
  if (loraOptions.value.length || loraLoading.value) return;
  const url = settings.comfyui.url.trim();
  if (!url) return;
  loraLoading.value = true;
  try {
    const lists = await fetchComfyModelLists(url);
    loraOptions.value = lists.loras ?? [];
  } catch {
    // ComfyUI 没开时静默:输入框退化为普通文本框,不影响手动填写
  } finally {
    loraLoading.value = false;
  }
}
// 弹窗内历史面板开关
const historyOpen = ref(false);
// 回滚确认
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

/* —— 服装库 ——
   列表是**页内视图**(点标题右侧入口整页切过去);而**表单是弹窗**。
   这个分工的理由:列表要能一屏看很多条、还要能边看边对照,塞进弹窗太憋屈;
   而表单有五个字段、高度固定且不短,内联展开会把列表越推越远、操作按钮掉出屏幕,
   弹窗反而更利落。 */
const closetView = ref(false);
/** 编辑草稿:非 null = 表单弹窗打开(与角色编辑弹窗同款约定)。 */
const closetDraft = ref<ClosetOutfit | null>(null);
/** 草稿是否为本次新建(决定题头文案与是否显示「删除」)。 */
const closetDraftIsNew = ref(false);
// 删除服装确认(用声明式 ConfirmDialog,与回滚确认同款——命令式 confirmDialog
// 要挂进插件 shadow host,预览环境里没有,会静默失败)
const confirmDeleteOutfitOpen = ref(false);
const pendingDeleteOutfit = ref<ClosetOutfit | null>(null);

/* —— 服装分类 ——
   分类是独立实体(见 state/closet.ts 文件头):可以建了先空着、可以改名、可以删。
   界面上按「折叠分组」呈现,与同页的「全局角色库 / 本聊天角色」同一套动作。 */
const categoryDraft = ref<ClosetCategory | null>(null);
const categoryDraftIsNew = ref(false);
const confirmDeleteCategoryOpen = ref(false);
const pendingDeleteCategory = ref<ClosetCategory | null>(null);

/**
 * 分类折叠态。分类是用户随时增删的,写不进固定的 ref,
 * 故整份折叠表存成一个对象持久化到本机 localStorage。
 * 未分类组用空串作 key(与 ClosetGroup.key 同一口径)。
 */
const CLOSET_FOLD_KEY = 'bbi.closet.fold.v1';

function loadClosetFold(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CLOSET_FOLD_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

const closetFold = reactive<Record<string, boolean>>(loadClosetFold());

function persistClosetFold() {
  try {
    localStorage.setItem(CLOSET_FOLD_KEY, JSON.stringify({ ...closetFold }));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  characterTraits: '如 athletic, energetic, gym bro, candid, confident, muscular',
  facialFeatures: '如 defined square jaw, handsome masculine face, eyebrow slit on left eyebrow',
  facialFeaturesBack: '如 short crew cut, clean high skin fade, neat hairline at the nape',
  upperBodySFW: '如 tall athletic build, wide broad shoulders, developed chest muscles',
  upperBodySFWBack: '如 V-taper torso, wide latissimus dorsi, defined rhomboids',
  fullBodySFW: '如 muscular athletic male physique, narrow waist, sculpted oblique veins',
  fullBodySFWBack: '如 firm compact muscular glutes, thick hamstrings separation, strong calves',
  upperBodyNSFW: '如 broad bare muscular chest, prominent square pectoral muscles',
  upperBodyNSFWBack: '如 deep spinal furrow, massive detailed back muscles',
  fullBodyNSFW: '如 chiseled adonis belt, trim groomed dark pubic hair',
  fullBodyNSFWBack: '如 firm rounded muscular glutes, thick powerful thighs',
};

/** 全局库名字集(响应式),用于分区与「覆盖」徽标。 */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * 本聊天分区 = 派生库里「属于本聊天」的条目:
 * 本聊天基线里的(含覆盖全局的同名条目)+ 非全局的(AI 楼层建档等)。
 * 纯全局条目只出现在全局分区。
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/* —— 角色头像 ——
 * 一个角色一个正方形格子:有头像显示头像(`柏宝绘_<角色名>/avatar.*`),
 * 没有头像但目录里有出图的显示最新一张,都没有则显示首字色块。
 * 只列**实际存在**的目录(服务端对不存在的目录会 mkdir 递归创建),成本 = 有图的角色数。 */
const AVATAR_PREFIX = '柏宝绘_';
const AVATAR_COLORS: Array<[string, string]> = [
  ['#fdeaf1', '#c2416d'],
  ['#f3edff', '#6b4fa8'],
  ['#eaf4ee', '#3f7a5a'],
  ['#fdf3e3', '#a06a1f'],
  ['#e8f1fb', '#2f6fa8'],
  ['#fbeceb', '#a8443f'],
];
interface CharacterImages {
  /** 头像文件(src);没有则空。 */
  avatar?: string;
  /** 目录里最新的一张出图(src);没有则空。 */
  latest?: string;
}
const imageMap = ref<Record<string, CharacterImages>>({});

/** 格子里显示的图:头像优先,退回最新出图,再退回空(首字色块)。 */
function tileSrc(name: string): string {
  const images = imageMap.value[name];
  return images?.avatar ?? images?.latest ?? '';
}

/** 首字色块:按名字哈希取一组固定配色,同一角色每次刷新颜色一致。 */
function avatarStyle(name: string): Record<string, string> {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  const [background, color] = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return { background, color };
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return /^[a-z]/i.test(trimmed) ? trimmed[0].toUpperCase() : trimmed[0];
}

function imageSrc(folder: string, file: string): string {
  return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

async function loadAvatars(): Promise<void> {
  try {
    const folders = await listUserImageFolders();
    const wanted = new Set<string>([
      ...globalCharTagLib.entries.map(entry => entry.name),
      ...chatEntries.value.map(entry => entry.name),
    ]);
    const next: Record<string, CharacterImages> = {};
    await Promise.all(
      folders.map(async folder => {
        if (!folder.startsWith(AVATAR_PREFIX)) return;
        const name = folder.slice(AVATAR_PREFIX.length);
        if (!wanted.has(name)) return;
        try {
          // 服务端按日期倒序:第一张就是最新的
          const files = await listUserImages(folder, { sortOrder: 'desc' });
          if (!files.length) return;
          const avatar = files.find(isAvatarFile);
          const latest = files.find(file => !isAvatarFile(file));
          next[name] = {
            ...(avatar ? { avatar: imageSrc(folder, avatar) } : {}),
            ...(latest ? { latest: imageSrc(folder, latest) } : {}),
          };
        } catch {
          // 单个目录读取失败不影响其它角色
        }
      }),
    );
    imageMap.value = next;
  } catch {
    // 图库不可用:所有格子退回首字色块
  }
}

onMounted(() => {
  void loadAvatars();
});

/* —— 格子里的「生成」按钮 ——
 * 用当前出图渠道(ComfyUI / NAI 都走 generateImage 这一条路)按该角色的外貌串出一张**头像**:
 * 提示词 = 角色外貌串 + 内置头像提示词(characterAvatar.ts),LoRA 绑定的角色走 characterNames,
 * 由 generate.ts 负责挂 LoRA 与拼触发词串。存成该角色目录下固定文件名 avatar.*(同名覆盖),
 * 所以「重新生成」就是换头像,不会在目录里越攒越多。 */
const genBusy = ref<Record<string, boolean>>({});

async function generateFor(entry: CharTagEntry): Promise<void> {
  const tag = buildEntryTag(entry);
  if (!tag) {
    toastr.warning('这个角色还没有可用的外貌(LoRA 触发词 / 整串 / 字段至少填一个)', '柏宝绘');
    return;
  }
  if (genBusy.value[entry.name]) return;
  genBusy.value = { ...genBusy.value, [entry.name]: true };
  try {
    const { result, seed } = await generateImage(
      {
        prompt: buildAvatarPrompt(tag),
        size: 'portrait',
        characterNames: [entry.name],
        seed: decideSeed(settings.defaultBackend),
      },
      undefined,
    );
    // 头像固定文件名(同名覆盖),不走 saveExternalImage:那张是给楼层/公开接口用的唯一名 + 侧写
    const { base64, format } = await prepareImageForStorage(result);
    await uploadUserImage(`${AVATAR_PREFIX}${entry.name}`, AVATAR_FILE_STEM, base64, format);
    toastr.success('头像已生成', '柏宝绘');
    await loadAvatars();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toastr.error(`生成失败:${message}`, '柏宝绘');
  } finally {
    genBusy.value = { ...genBusy.value, [entry.name]: false };
  }
}

/* —— 搜索 ——
 * 全局/本聊天库长起来一格一格翻太慢:按角色名 + 任一外貌字段 + 整串 + nl 匹配,
 * 大小写不敏感。空查询=不过滤。计数标仍显总条目数,匹配数在搜索框后单独标。 */
const globalSearch = ref('');
const chatSearch = ref('');
/** 把条目捏成一段串便于一次性 includes:跑下面的字段循环是 O(11) 而非每次 trim 再串一遍。 */
function entryMatchesSearch(entry: CharTagEntry, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (entry.name.toLowerCase().includes(q)) return true;
  if (entry.raw.toLowerCase().includes(q)) return true;
  if (entry.nl.toLowerCase().includes(q)) return true;
  for (const f of CHAR_TAG_FIELDS) {
    const v = entry.fields[f];
    if (v && v.toLowerCase().includes(q)) return true;
  }
  return false;
}
/** 收藏优先,其余保持原顺序(Array.sort 在现代引擎里稳定)。 */
function favoriteFirst(entries: CharTagEntry[]): CharTagEntry[] {
  return [...entries].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
}

const filteredGlobalEntries = computed(() =>
  favoriteFirst(globalCharTagLib.entries.filter(entry => entryMatchesSearch(entry, globalSearch.value))),
);
const filteredChatEntries = computed(() =>
  favoriteFirst(chatEntries.value.filter(entry => entryMatchesSearch(entry, chatSearch.value))),
);

/** 三选一优先级:LoRA 触发词 > 整串 > 字段(与 state/charTags.buildEntryTag 同口径)。 */
const draftLora = computed<CharTagLora | undefined>(() => {
  const name = draftLoraName.value.trim();
  if (!name) return undefined;
  return {
    name,
    strength: Math.min(2, Math.max(0, Number(draftLoraStrength.value) || 0)),
    trigger: draftLoraTrigger.value.trim(),
  };
});
const draftLoraMode = computed(() => !!draftLora.value);

/** 是否整串模式:整串非空且没有绑 LoRA(绑了 LoRA 时整串不参与)。 */
const draftIsRaw = computed(
  () => !!draft.value && !draftLoraMode.value && !!draft.value.raw.trim(),
);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw, lora: draftLora.value });
});

/** 正在编辑的本聊天条目的实时历史(回滚后随之刷新);全局条目不记历史。 */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/**
 * 表单能否保存:名称与词串是必填。
 *
 * 之所以要有这个 computed 而不是只靠 saveClosetOutfit 里 return:
 * 光 return + toastr 的话,按钮看起来照样可点、点了没反应,用户会当成按钮坏了
 * (实测反馈)。禁用态是可见的,再配一句原因就说得通了。
 * 词串必填的理由:它才是生成时被照抄进提示词的那串 tag,空词串的条目没有意义。
 */
const closetCanSave = computed(
  () => !!closetDraft.value?.name.trim() && !!closetDraft.value?.tags.trim(),
);

/** 分类表单能否保存:只有名称一项,非空即可。 */
const categoryCanSave = computed(() => !!categoryDraft.value?.name.trim());

/** 服装表单里的「分类」下拉选项;首项是未分类。 */
const closetCategoryOptions = computed(() => [
  { value: '', label: '未分类' },
  ...closetLib.categories.map(category => ({ value: category.id, label: category.name })),
]);

interface ClosetGroup {
  /** 折叠态与 v-for 的 key;未分类组为空串 */
  key: string;
  /** 分类对象;未分类组为 null(它不可改名、不可删除) */
  category: ClosetCategory | null;
  name: string;
  outfits: ClosetOutfit[];
}

/**
 * 按分类分组。
 *
 * 「未分类」不是存出来的分类,而是**兜底桶**:categoryId 为空、或指向一个已删分类的条目
 * 都落进来。只在真有这类条目时才显示,免得空占一行。
 */
const closetGroups = computed<ClosetGroup[]>(() => {
  const groups: ClosetGroup[] = closetLib.categories.map(category => ({
    key: category.id,
    category,
    name: category.name,
    outfits: closetLib.outfits.filter(outfit => outfit.categoryId === category.id),
  }));
  const known = new Set(closetLib.categories.map(category => category.id));
  const loose = closetLib.outfits.filter(outfit => !outfit.categoryId || !known.has(outfit.categoryId));
  if (loose.length) {
    groups.push({ key: '', category: null, name: '未分类', outfits: loose });
  }
  return groups;
});

/** 分类展开态:空分类无可折叠,强制展开(否则删空后卡在收拢的空态)。 */
function isClosetGroupShown(group: ClosetGroup): boolean {
  return group.outfits.length === 0 || !closetFold[group.key];
}

function toggleClosetGroup(group: ClosetGroup) {
  if (!group.outfits.length) return;
  closetFold[group.key] = !closetFold[group.key];
  persistClosetFold();
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  draftLoraName.value = entry.lora?.name ?? '';
  draftLoraStrength.value = entry.lora?.strength ?? 1;
  draftLoraTrigger.value = entry.lora?.trigger ?? '';
  draftFavorite.value = entry.favorite === true;
  dialogTab.value = 'fields';
  void ensureLoraOptions();
  historyOpen.value = false;
}

function addEntry(scope: Scope = 'chat') {
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), raw: '', nl: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
  draftLoraName.value = '';
  draftLoraStrength.value = 1;
  draftLoraTrigger.value = '';
  draftFavorite.value = false;
  dialogTab.value = 'fields';
  void ensureLoraOptions();
  historyOpen.value = false;
}

/* —— 分区折叠(参照柏宝书「计划/悬念」)——
 * 标题行兼作折叠开关;折叠态是本机视图偏好,走 localStorage、不进设置(跨设备同步没意义)。 */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// 无条目即无可折叠:不显示箭头与计数,也强制展开(避免删空后卡在收拢的空态)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/** 手动编辑过的字段 → 条目归手动(但仍可被 AI 变更接管) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('角色名不能为空', '柏宝绘');
    return;
  }
  if (!previewTag.value && !draftLora.value) {
    toastr.warning('至少填一个外貌字段、整串 tag，或绑定一个 LoRA', '柏宝绘');
    return;
  }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
    // 名字留空 = 解绑;强度夹在 0–2,与 normalizeLora 同口径
    lora: draftLora.value,
    favorite: draftFavorite.value,
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  // 失败必须给反馈:静默失败在界面上就是「点了完成没反应」,查不出原因
  if (!ok) {
    toastr.error('保存失败:角色名重复或条目为空', '柏宝绘');
    return;
  }
  closeEntry();
}

/* —— 删除:二次确认 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value) return;
  if (editingScope.value === 'global') removeGlobalCharTag(editingName.value);
  else removeCharTag(editingName.value);
  closeEntry();
}

/* —— 提升为全局 / 复制到本聊天 —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`「${editingName.value}」已提升为全局角色,所有聊天生效`, '柏宝绘');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`已把「${name}」复制到本聊天,之后本聊天以副本为准`, '柏宝绘');
  }
  closeEntry();
}

/* —— 从柏宝书最新状态建档:取最新楼的角色参考,找到同名角色的外貌记录,批量转换接口转字段 —— */
async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填写角色名', '柏宝绘');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('当前没有打开的聊天', '柏宝绘');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(r => r.name === name);
    if (!role?.desc) {
      toastr.info('柏宝书最新状态里没有该角色的外貌记录,可手动填写', '柏宝绘');
      return;
    }
    const [result] = await generateCharTags([{ name, desc: role.desc }]);
    if (!result) {
      toastr.warning('模型没有返回该角色的 tag,请重试或手动填写', '柏宝绘');
      return;
    }
    const fields = { ...emptyCharFields(), ...result.fields };
    d.fields = fields;
    d.raw = '';
    draftSource.value = 'book';
    draftDesc.value = role.desc;
    toastr.success('已按柏宝书最新外貌生成,点「完成」保存', '柏宝绘');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '柏宝绘');
  } finally {
    regenerating.value = false;
  }
}

/* —— 历史展示与回滚(仅本聊天条目) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return '建档';
  if (field === 'raw') return '整串';
  if (field === 'nl') return '自然语言';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`已回滚「${p.name}」的${fieldLabel(p.record.field)}变更`, '柏宝绘');
  } else {
    toastr.warning('回滚失败:条目可能已删除', '柏宝绘');
  }
}

/* ============ 服装库 ============ */

function openCloset() {
  closetView.value = true;
}

function closeCloset() {
  closetView.value = false;
  closeClosetDraft();
  closeCategoryDraft();
}

/** 点列表行 → 打开编辑弹窗。 */
function editClosetOutfit(entry: ClosetOutfit) {
  closetDraft.value = { ...entry };
  closetDraftIsNew.value = false;
}

/**
 * 「添加一套」→ 打开空表单。
 * categoryId 决定新建的条目落在哪个分类(分类标题右侧的「+」会带上它);
 * 不传则落到未分类。模板里必须写成 addClosetOutfit() —— 直接写函数名会把
 * MouseEvent 当成 categoryId 传进来。
 */
function addClosetOutfit(categoryId = '') {
  closetDraft.value = createOutfit(categoryId);
  closetDraftIsNew.value = true;
}

function closeClosetDraft() {
  closetDraft.value = null;
  closetDraftIsNew.value = false;
}

function saveClosetOutfit() {
  const d = closetDraft.value;
  if (!d) return;
  if (!d.name.trim()) {
    toastr.warning('先给这套衣服起个名', '柏宝绘');
    return;
  }
  if (!d.tags.trim()) {
    toastr.warning('词串不能为空——它才是生成时被照抄的那串 tag', '柏宝绘');
    return;
  }
  if (!upsertOutfit(d)) {
    toastr.warning('保存失败:名称与词串都不能为空', '柏宝绘');
    return;
  }
  toastr.success(`已保存「${d.name.trim()}」`, '柏宝绘');
  closeClosetDraft();
}

/** 删除当前草稿。不直接从模板传 closetDraft:那里是可能为 null 的 ref,守卫放函数里更省心。 */
function askDeleteCurrentClosetOutfit() {
  const d = closetDraft.value;
  if (!d) return;
  pendingDeleteOutfit.value = { ...d };
  confirmDeleteOutfitOpen.value = true;
}

function confirmDeleteClosetOutfit() {
  confirmDeleteOutfitOpen.value = false;
  const entry = pendingDeleteOutfit.value;
  pendingDeleteOutfit.value = null;
  if (!entry) return;
  if (!removeOutfit(entry.id)) return;
  toastr.success(`已删除「${entry.name}」`, '柏宝绘');
  // 删的就是正在编辑的那条 → 表单弹窗一并收掉,不然它变成改一个已不存在的条目
  if (closetDraft.value?.id === entry.id) closeClosetDraft();
}

/* ============ 服装分类 ============ */

function addClosetCategory() {
  categoryDraft.value = createCategory();
  categoryDraftIsNew.value = true;
}

function editClosetCategory(category: ClosetCategory) {
  categoryDraft.value = { ...category };
  categoryDraftIsNew.value = false;
}

function closeCategoryDraft() {
  categoryDraft.value = null;
  categoryDraftIsNew.value = false;
}

function saveClosetCategory() {
  const d = categoryDraft.value;
  if (!d) return;
  if (!upsertCategory(d)) {
    toastr.warning('分类名不能为空', '柏宝绘');
    return;
  }
  toastr.success(`已保存分类「${d.name.trim()}」`, '柏宝绘');
  closeCategoryDraft();
}

function askDeleteCurrentCategory() {
  const d = categoryDraft.value;
  if (!d) return;
  pendingDeleteCategory.value = { ...d };
  confirmDeleteCategoryOpen.value = true;
}

function confirmDeleteClosetCategory() {
  confirmDeleteCategoryOpen.value = false;
  const category = pendingDeleteCategory.value;
  pendingDeleteCategory.value = null;
  if (!category) return;
  if (!removeCategory(category.id)) return;
  toastr.success(`已删除分类「${category.name}」,里面的服装移到「未分类」`, '柏宝绘');
  if (categoryDraft.value?.id === category.id) closeCategoryDraft();
}

/** 删除确认框里要报出「里面有几套」——用户得知道会牵动多少条目。 */
function countOutfitsInCategory(categoryId: string): number {
  return closetLib.outfits.filter(outfit => outfit.categoryId === categoryId).length;
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? '柏宝书' : entry.source === 'ai' ? 'AI 维护' : '手动';
}

/* —— [v11·2026-10-14] 一键导入手机UI —— */
/*
 * 手机UI 是酒馆助手脚本,跑在独立 iframe;柏宝绘在主文档,两者 window 互不可见
 * (这就是「手机UI未挂载或角色外观缓存为空」的根因)。读取走三级回退,
 * 见 `@/st/phoneAppearance` —— 本窗口 → 同源 iframe → ST 共享 chatMetadata。
 */


/** 把手机UI单条角色数据映射成 CharTagEntry(11 字段)。无 phone 数据时返回 null。 */
function _phoneEntryToCharTag(phoneName: string, phoneData: Record<string, unknown>): {
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
} {
  const fields = emptyCharFields();
  for (const f of CHAR_TAG_FIELDS) {
    const v = phoneData[f];
    if (typeof v === 'string') fields[f] = v.trim();
  }
  // 整串:手机UI 的整串存在 wholeFrontSFW(另有 wholeBackSFW/wholeFrontNSFW/wholeBackNSFW
  // 三个变体,柏宝绘只有一个 raw 槽位,只搬正面 SFW)。旧实现读 phoneData.raw ——
  // 该键在手机UI 的外观条目里并不存在(其白名单是 11 字段 + nameCN/nameEN/gender),
  // 会导致整串静默丢失。
  const pickStr = (k: string): string =>
    typeof phoneData[k] === 'string' ? (phoneData[k] as string).trim() : '';
  const raw = pickStr('wholeFrontSFW') || pickStr('raw');
  const nl = pickStr('nl');
  return { fields, raw, nl };
}

/** 单角色导入:从手机UI同步到当前 draft。同名覆盖,不同名追加。
 *  把手机UI的 11 字段映射进 draft;手机UI里的 nameCN/nameEN/wholeFrontSFW 也一并灌入。 */
function importFromPhoneUI(): void {
  const d = draft.value;
  if (!d) return;
  const target = d.name.trim();
  if (!target) {
    toastr.warning('先填角色名才能从手机UI导入', '柏宝绘');
    return;
  }
  const all = readPhoneAppearance();
  if (!all) {
    toastr.warning(`手机UI未挂载或角色外观缓存为空（${phoneAppearanceMissHint()}）`, '柏宝绘');
    return;
  }
  const phoneData = all[target];
  if (!phoneData) {
    toastr.warning(`手机UI没有「${target}」`, '柏宝绘');
    return;
  }
  const mapped = _phoneEntryToCharTag(target, phoneData);
  let changed = 0;
  for (const f of CHAR_TAG_FIELDS) {
    if (mapped.fields[f] && !d.fields[f]) {
      d.fields[f] = mapped.fields[f];
      changed++;
    }
  }
  if (mapped.raw && !d.raw) {
    d.raw = mapped.raw;
    changed++;
  }
  if (mapped.nl && !d.nl) {
    d.nl = mapped.nl;
    changed++;
  }
  markManual();
  if (changed > 0) {
    toastr.success(`已从手机UI导入 ${changed} 个字段(已有值不覆盖)`, '柏宝绘');
  } else {
    toastr.info('手机UI里该角色所有字段在当前草稿里都已填,无需导入', '柏宝绘');
  }
}

/* —— 批量导入 v11.1 · 模式选择 ——
 * 旧版 importAllFromPhoneUI 永远「同名覆盖」,会把用户精修过的全局条目洗成手机UI的快照。
 * 新版先弹模式选择,再走 runImportAll;两个模式共用同一份循环逻辑,
 * 差异只在「命中同名条目时是覆盖还是跳过」。 */
type ImportAllMode = 'overwrite' | 'addOnly';
const importAllModeOpen = ref(false);
const importAllBusy = ref(false);
function askImportAll(): void {
  importAllModeOpen.value = true;
}
function closeImportAllMode(): void {
  importAllModeOpen.value = false;
}
function runImportAll(mode: ImportAllMode): void {
  if (importAllBusy.value) return;
  importAllBusy.value = true;
  importAllModeOpen.value = false;
  try {
    const all = readPhoneAppearance();
    if (!all) {
      toastr.warning(`手机UI未挂载或角色外观缓存为空(${phoneAppearanceMissHint()})`, '柏宝绘');
      return;
    }
    const names = Object.keys(all).filter(n => {
      const d = all[n];
      return d && !d._aliasOf;
    });
    if (!names.length) {
      toastr.warning('手机UI角色外观缓存为空', '柏宝绘');
      return;
    }
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const nm of names) {
      const phoneData = all[nm];
      const mapped = _phoneEntryToCharTag(nm, phoneData);
      if (!mapped.raw && charFieldsEmpty(mapped.fields)) {
        skipped++;
        continue;
      }
      const existing = globalCharTagLib.entries.find(item => item.name === nm);
      // 「只导入新角色」= 命中同名直接跳;ui 上要让用户清楚这是为了保留手动修过的细节。
      if (mode === 'addOnly' && existing) {
        skipped++;
        continue;
      }
      // 同名合并:手机UI有值的字段覆盖,手机UI没值的字段保留库里原有值,
      // 避免把已有条目的 raw/nl 洗成空。
      const fields = existing ? { ...existing.fields } : emptyCharFields();
      for (const f of CHAR_TAG_FIELDS) {
        if (mapped.fields[f]) fields[f] = mapped.fields[f];
      }
      const entry: CharTagEntry = {
        name: nm,
        fields,
        raw: mapped.raw || existing?.raw || '',
        nl: mapped.nl || existing?.nl || '',
        source: existing?.source ?? 'manual',
        desc: existing?.desc || '从手机UI一键导入',
        history: existing?.history ?? [],
      };
      if (upsertGlobalCharTag(entry)) {
        if (existing) updated++;
        else added++;
      } else {
        skipped++;
      }
    }
    const modeLabel = mode === 'addOnly' ? '只导入新角色' : '全部覆盖+加导入新角色';
    toastr.success(
      `[${modeLabel}] 完成 · 新增 ${added} · 更新 ${updated} · 跳过 ${skipped}`,
      '柏宝绘',
    );
  } finally {
    importAllBusy.value = false;
  }
}

/* —— 清空所有提示词 ——
 * 「一键清空」编辑弹窗里的所有提示词字段(11 字段 + 整串 + 自然语言 + 描述),
 * 角色名保留 —— 它是主键,清掉会把条目变成无名草稿;
 * 用 ConfirmDialog 二次确认,误触一下不会丢所有字段。 */
const confirmClearAllOpen = ref(false);
function askClearAll(): void {
  confirmClearAllOpen.value = true;
}
function confirmClearAll(): void {
  confirmClearAllOpen.value = false;
  const d = draft.value;
  if (!d) return;
  d.fields = emptyCharFields();
  d.raw = '';
  d.nl = '';
  draftDesc.value = '';
  markManual();
  toastr.info('已清空所有提示词(角色名保留)', '柏宝绘');
}
</script>

<template>
  <section class="bbi-page">
    <!-- ===== 角色库视图 ===== -->
    <template v-if="!closetView">
      <div class="bbi-page-head">
        <h2 class="bbi-title bbi-title-sub">角色管理</h2>
        <button
          class="bbi-btn bbi-btn-import-all"
          type="button"
          title="把手机UI『角色外观缓存』里所有角色一键导入到柏宝绘全局角色库(弹窗选择全部覆盖 或 只导入新角色)"
          @click="askImportAll"
        >
          <Icon name="download" /> 一键导入手机UI
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" title="打开服装库" @click="openCloset">
          <Icon name="wardrobe" />
          服装库
          <span class="bbi-closet-count">{{ closetLib.outfits.length }}</span>
        </button>
      </div>
      <hr class="bbi-rule" />
  
      <p class="bbi-field-hint">
        角色固定外貌库:生成 tag 时 AI 照抄库中字段,稳定不漂移。服装库见右上角。
      </p>
  
      <!-- ===== 全局角色库 ===== -->
      <div class="bbi-char-section">
        <div class="bbi-char-section-head">
          <button
            class="bbi-fold-head"
            type="button"
            :class="{ 'is-static': !globalFoldable }"
            :disabled="!globalFoldable"
            :aria-expanded="globalShown"
            :title="globalFoldable ? (globalShown ? '收起全局角色库' : '展开全局角色库') : ''"
            @click="toggleFold('global')"
          >
            <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
            <span class="bbi-field-label">全局角色库</span>
            <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
          </button>
          <!-- 库长了翻起来费劲 —— 模糊搜角色名或任一外貌字段,
               实时过滤卡片;计数标仍显总数,匹配数在搜索框后单独提示。 -->
          <div v-if="globalFoldable" class="bbi-char-search">
            <Icon name="search" class="bbi-char-search-icon" />
            <input
              v-model="globalSearch"
              type="search"
              class="bbi-char-search-input"
              placeholder="搜索角色名 / 外貌字段"
              aria-label="搜索全局角色"
              @keydown.esc="globalSearch = ''"
            />
            <span v-if="globalSearch" class="bbi-char-search-meta">
              匹配 {{ filteredGlobalEntries.length }}
            </span>
            <button
              v-if="globalSearch"
              class="bbi-char-search-clear"
              type="button"
              title="清空搜索"
              @click="globalSearch = ''"
            >
              <Icon name="close" />
            </button>
          </div>
          <button class="bbi-add-mini" type="button" title="添加全局角色" @click="addEntry('global')">
            <Icon name="plus" />
          </button>
        </div>
        <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height -->
        <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
          <div class="bbi-fold-inner">
            <p class="bbi-field-hint">
              所有聊天生效,仅手动维护——AI 不会修改全局角色,适合玩家角色等固定形象。本聊天有同名角色时以本聊天为准。
            </p>
            <ul v-if="filteredGlobalEntries.length" class="bbi-char-tiles">
            <li v-for="entry in filteredGlobalEntries" :key="entry.name" class="bbi-char-tile">
              <div
                class="bbi-char-tile-box"
                role="button"
                tabindex="0"
                @click="openEntry(entry, 'global')"
                @keydown.enter.prevent="openEntry(entry, 'global')"
                @keydown.space.prevent="openEntry(entry, 'global')"
              >
                <img v-if="tileSrc(entry.name)" :src="tileSrc(entry.name)" alt="" loading="lazy" />
                <span v-else class="bbi-char-tile-empty" :style="avatarStyle(entry.name)">{{ initialOf(entry.name) }}</span>
                <button
                  class="bbi-char-tile-gen"
                  type="button"
                  :disabled="genBusy[entry.name]"
                  :title="genBusy[entry.name] ? '生成中…' : '生成头像(角色外貌串 + 内置头像提示词)'"
                  @click.stop="generateFor(entry)"
                >
                  <Icon name="generate" /> {{ genBusy[entry.name] ? '生成中' : '生成' }}
                </button>
              </div>
              <span class="bbi-char-tile-name">{{ entry.name }}</span>
              <span class="bbi-char-tile-badges">
                <span v-if="entry.favorite" class="bbi-char-pill is-fav" title="已收藏,排在列表最前">★</span>
                <span class="bbi-char-pill is-global">全局</span>
                <span v-if="entry.lora?.name" class="bbi-char-pill is-lora" :title="`LoRA: ${entry.lora.name}`">L</span>
              </span>
            </li>
            </ul>
            <p v-else-if="globalCharTagLib.entries.length && globalSearch" class="bbi-char-empty">
              没有匹配「{{ globalSearch }}」的全局角色。
              <button class="bbi-btn bbi-btn-sm" type="button" @click="globalSearch = ''">清空搜索</button>
            </p>
            <p v-else class="bbi-char-empty">
              还没有全局角色。在本聊天角色的编辑弹窗里点「提升为全局」,或点右上角「+」添加。
            </p>
          </div>
        </div>
      </div>
  
      <!-- ===== 本聊天角色 ===== -->
      <div class="bbi-char-section">
        <div class="bbi-char-section-head">
          <button
            class="bbi-fold-head"
            type="button"
            :class="{ 'is-static': !chatFoldable }"
            :disabled="!chatFoldable"
            :aria-expanded="chatShown"
            :title="chatFoldable ? (chatShown ? '收起本聊天角色' : '展开本聊天角色') : ''"
            @click="toggleFold('chat')"
          >
            <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
            <span class="bbi-field-label">本聊天角色</span>
            <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
          </button>
          <div v-if="chatFoldable" class="bbi-char-search">
            <Icon name="search" class="bbi-char-search-icon" />
            <input
              v-model="chatSearch"
              type="search"
              class="bbi-char-search-input"
              placeholder="搜索角色名 / 外貌字段"
              aria-label="搜索本聊天角色"
              @keydown.esc="chatSearch = ''"
            />
            <span v-if="chatSearch" class="bbi-char-search-meta">
              匹配 {{ filteredChatEntries.length }}
            </span>
            <button
              v-if="chatSearch"
              class="bbi-char-search-clear"
              type="button"
              title="清空搜索"
              @click="chatSearch = ''"
            >
              <Icon name="close" />
            </button>
          </div>
          <button class="bbi-add-mini" type="button" title="添加本聊天角色" @click="addEntry('chat')">
            <Icon name="plus" />
          </button>
        </div>
        <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
          <div class="bbi-fold-inner">
            <p class="bbi-field-hint">
              仅当前聊天生效:柏宝书角色自动建档,AI 随剧情报告永久变化;可查看历史并回滚。
            </p>
            <ul v-if="filteredChatEntries.length" class="bbi-char-tiles">
            <li v-for="entry in filteredChatEntries" :key="entry.name" class="bbi-char-tile">
              <div
                class="bbi-char-tile-box"
                role="button"
                tabindex="0"
                @click="openEntry(entry, 'chat')"
                @keydown.enter.prevent="openEntry(entry, 'chat')"
                @keydown.space.prevent="openEntry(entry, 'chat')"
              >
                <img v-if="tileSrc(entry.name)" :src="tileSrc(entry.name)" alt="" loading="lazy" />
                <span v-else class="bbi-char-tile-empty" :style="avatarStyle(entry.name)">{{ initialOf(entry.name) }}</span>
                <button
                  class="bbi-char-tile-gen"
                  type="button"
                  :disabled="genBusy[entry.name]"
                  :title="genBusy[entry.name] ? '生成中…' : '生成头像(角色外貌串 + 内置头像提示词)'"
                  @click.stop="generateFor(entry)"
                >
                  <Icon name="generate" /> {{ genBusy[entry.name] ? '生成中' : '生成' }}
                </button>
              </div>
              <span class="bbi-char-tile-name">{{ entry.name }}</span>
              <span class="bbi-char-tile-badges">
                <span v-if="entry.favorite" class="bbi-char-pill is-fav" title="已收藏,排在列表最前">★</span>
                <span class="bbi-char-pill" :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }">
                  {{ sourceLabel(entry) }}
                </span>
                <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="与全局库同名,当前聊天以本条为准">覆</span>
                <span v-if="entry.lora?.name" class="bbi-char-pill is-lora" :title="`LoRA: ${entry.lora.name}`">L</span>
                <span v-if="entry.history.length" class="bbi-char-history-badge" :title="`${entry.history.length} 条变更记录`">
                  <Icon name="history" />{{ entry.history.length }}
                </span>
              </span>
            </li>
            </ul>
            <p v-else-if="chatEntries.length && chatSearch" class="bbi-char-empty">
              没有匹配「{{ chatSearch }}」的本聊天角色。
              <button class="bbi-btn bbi-btn-sm" type="button" @click="chatSearch = ''">清空搜索</button>
            </p>
            <p v-else class="bbi-char-empty">
              本聊天还没有角色。生成 tag 时柏宝书角色会自动建档,也可点右上角「+」手动补。
            </p>
          </div>
        </div>
      </div>
    </template>

    <!-- ===== 服装库视图 ===== -->
    <template v-else>
      <div class="bbi-page-head">
        <h2 class="bbi-title bbi-title-sub bbi-closet-title">
          服装库
          <span class="bbi-closet-count">{{ closetLib.outfits.length }}</span>
        </h2>
        <button class="bbi-btn bbi-btn-sm" type="button" title="回到角色库" @click="closeCloset">
          <Icon name="back" />返回角色库
        </button>
      </div>
      <hr class="bbi-rule" />

      <p class="bbi-field-hint">
        按分类整理。生成 tag 时 AI 会读到全部分类与条目,从中挑一套最贴合正文情境的,照抄其词串。
        分类名也一并发给 AI,起成能看懂的情境词更好用。
      </p>

      <div class="bbi-closet-add">
        <button class="bbi-btn bbi-btn-sm" type="button" @click="addClosetCategory()">
          <Icon name="plus" />新建分类
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="addClosetOutfit()">
          <Icon name="plus" />添加一套
        </button>
      </div>

      <div v-if="closetGroups.length" class="bbi-closet-groups">
        <div v-for="group in closetGroups" :key="group.key || '__loose__'" class="bbi-char-section">
          <div class="bbi-char-section-head">
            <button
              class="bbi-fold-head"
              type="button"
              :class="{ 'is-static': !group.outfits.length }"
              :disabled="!group.outfits.length"
              :aria-expanded="isClosetGroupShown(group)"
              :title="group.outfits.length ? (isClosetGroupShown(group) ? '收起' : '展开') : ''"
              @click="toggleClosetGroup(group)"
            >
              <Icon
                v-if="group.outfits.length"
                name="chevron"
                class="bbi-fold-caret"
                :class="{ 'is-collapsed': !isClosetGroupShown(group) }"
              />
              <span class="bbi-field-label">{{ group.name }}</span>
              <span class="bbi-count">{{ group.outfits.length }}</span>
            </button>
            <button
              v-if="group.category"
              class="bbi-add-mini"
              type="button"
              :title="`编辑分类「${group.name}」`"
              @click="editClosetCategory(group.category)"
            >
              <Icon name="more" />
            </button>
            <button
              class="bbi-add-mini"
              type="button"
              :title="`往「${group.name}」添加一套`"
              @click="addClosetOutfit(group.key)"
            >
              <Icon name="plus" />
            </button>
          </div>
          <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !isClosetGroupShown(group) }">
            <div class="bbi-fold-inner">
              <ul v-if="group.outfits.length" class="bbi-closet-list">
                <li v-for="entry in group.outfits" :key="entry.id" class="bbi-closet-item">
                  <button class="bbi-closet-row" type="button" @click="editClosetOutfit(entry)">
                    <span class="bbi-closet-name">{{ entry.name }}</span>
                    <span class="bbi-closet-pill" :class="{ 'is-generic': !entry.character }">
                      {{ entry.character || '通用' }}
                    </span>
                    <code class="bbi-closet-tags">{{ entry.tags }}</code>
                  </button>
                </li>
              </ul>
              <p v-else class="bbi-char-empty">这个分类还是空的,点右上角「+」加一套。</p>
            </div>
          </div>
        </div>
      </div>
      <p v-else class="bbi-char-empty">
        服装库还是空的。先点「新建分类」建一个(比如「校服」「日常」),再往里加衣服。
      </p>
    </template>

    <!-- ===== 服装表单弹窗 ===== -->
    <ModalMask :open="!!closetDraft" @close="closeClosetDraft">
      <div
        v-if="closetDraft"
        class="bbi-modal bbi-closet-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="closetDraftIsNew ? '添加服装' : '编辑服装'"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ closetDraftIsNew ? '添加服装' : '编辑服装' }}
            <span
              class="bbi-closet-pill"
              :class="{ 'is-generic': !closetDraft.character }"
            >
              {{ closetDraft.character || '通用' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeClosetDraft">
            <Icon name="close" />
          </button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">名称<em class="bbi-closet-req">必填</em></span>
          <input v-model="closetDraft.name" class="bbi-input" placeholder="如 夏制服" />
        </label>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">分类</span>
          <BbiSelect v-model="closetDraft.categoryId" :options="closetCategoryOptions" aria-label="分类" />
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">词串<em class="bbi-closet-req">必填</em>（照抄进提示词的就是它）</span>
          <BbiTextarea
            v-model="closetDraft.tags"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="如 navy sailor uniform, white sailor collar, red neckerchief"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">自然语言(可选)</span>
          <BbiTextarea
            v-model="closetDraft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="一句连贯英文描述,自然语言模式下用;当前工作流关着 nl,可留空"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">仅限角色(可选)</span>
          <input
            v-model="closetDraft.character"
            class="bbi-input"
            placeholder="留空 = 通用款;填角色名则只给该角色挑"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">备注(可选)</span>
          <input v-model="closetDraft.note" class="bbi-input" placeholder="只给你自己看,不进请求" />
        </label>

        <div class="bbi-closet-form-foot">
          <button
            v-if="!closetDraftIsNew"
            class="bbi-btn bbi-btn-sm bbi-closet-del"
            type="button"
            @click="askDeleteCurrentClosetOutfit"
          >
            <Icon name="trash" />删除
          </button>
          <span class="bbi-closet-spacer"></span>
          <span v-if="!closetCanSave" class="bbi-closet-warn">名称与词串都要填</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="closeClosetDraft">取消</button>
          <button
            class="bbi-btn bbi-btn-sm bbi-btn-primary"
            type="button"
            :disabled="!closetCanSave"
            @click="saveClosetOutfit"
          >
            完成
          </button>
        </div>
      </div>
    </ModalMask>

    <!-- ===== 角色编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? '编辑角色' : '添加角色' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? '全局' : '本聊天' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <!-- 行动栏:原本挂在弹窗底部,编辑长字段(11 外貌 + 整串 + nl)时
             滑到底才能点「完成 / 清空 / 删除」,来回滚动成本太高。
             整组提到标题正下方, position: sticky 让滚长表单时也常驻视口顶部,
             关闭按钮移到 header 右上保留,避免双重动作区。
             [v13·2026-10-17] 七个按钮一行放不下、换成两行更挤:只留高频的
             「收藏 / 删除 / 完成」,其余全收进「更多」下拉(BbiSelect 菜单走
             modalHost,不会被弹窗裁掉)。 -->
        <div class="bbi-char-edit-toolbar">
          <div class="bbi-modal-foot">
            <button
              class="bbi-btn bbi-char-fav-btn"
              :class="{ 'is-fav': draftFavorite }"
              type="button"
              :title="draftFavorite ? '取消收藏' : '收藏后排在角色列表最前面'"
              @click="draftFavorite = !draftFavorite"
            >
              {{ draftFavorite ? '★ 已收藏' : '☆ 收藏' }}
            </button>
            <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
              <Icon name="trash" /> 删除
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <BbiSelect
              v-model="moreAction"
              :options="moreOptions"
              placeholder="更多"
              aria-label="更多操作"
              class="bbi-char-more"
            />
            <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">完成</button>
          </div>
        </div>

        <!-- 作用域:仅新建时可选;已有条目换层用顶部「提升为全局 / 复制到本聊天」 -->
        <div v-if="!editingName" class="bbi-modal-field">
          <span class="bbi-modal-label">保存到</span>
          <div class="bbi-segmented">
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'chat' }"
              type="button"
              @click="draftScope = 'chat'"
            >
              本聊天
            </button>
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'global' }"
              type="button"
              @click="draftScope = 'global'"
            >
              全局
            </button>
          </div>
          <span class="bbi-field-hint">
            {{ draftScope === 'global' ? '全局:所有聊天生效,AI 不会修改,tag 有问题需手动改。' : '本聊天:仅当前聊天,AI 可随剧情自动变更。' }}
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">角色名</span>
          <input v-model="draft.name" class="bbi-input" placeholder="与正文/柏宝书中的名字一致" @input="markManual" />
        </label>
        <span class="bbi-field-hint">按这个名字去正文和柏宝书角色参考里匹配;AI 引用时也用它(@角色名)。改名不会自动跟随。</span>

        <!-- 分组页签:外貌字段 / NSFW / LoRA 三选一显示,点一下切换。
             最终预览固定在弹窗底部,不随页签切换(见文件末尾)。 -->
        <nav class="bbi-char-tabs" aria-label="编辑分组">
          <button
            v-for="tab in DIALOG_TABS"
            :key="tab.key"
            class="bbi-char-tab"
            :class="{ 'is-on': dialogTab === tab.key }"
            type="button"
            :aria-selected="dialogTab === tab.key"
            @click="dialogTab = tab.key"
          >
            {{ tab.label }}
            <span v-if="tab.key === 'nsfw'" class="bbi-char-tab-count">{{ NSFW_FIELDS.length }}</span>
          </button>
        </nav>

        <!-- 页签一:外貌字段 + 整串 + 自然语言 -->
        <template v-if="dialogTab === 'fields'">
          <div class="bbi-modal-field">
            <span class="bbi-modal-label">
              外貌字段
              <span v-if="draftLoraMode" class="bbi-char-pill is-lora" title="已绑定 LoRA:外貌字段不会发送给 AI">不发送</span>
            </span>
            <div class="bbi-char-form bbi-char-form--grid">
              <label v-for="f in SFW_FIELDS" :key="f" class="bbi-char-form-cell">
                <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
                <BbiTextarea
                  v-model="draft.fields[f]"
                  :rows="2"
                  :max-rows="6"
                  mono
                  :placeholder="FIELD_PLACEHOLDERS[f]"
                  @input="markManual"
                />
              </label>
            </div>
          </div>
          <span class="bbi-field-hint">只写固定基础特征;服装、表情、动作不入库,每次按剧情生成。</span>

          <label class="bbi-modal-field">
            <span class="bbi-modal-label">
              整串模式(可选)
              <span v-if="draftLoraMode" class="bbi-char-pill is-lora" title="已绑定 LoRA:整串不会发送给 AI">不发送</span>
            </span>
            <BbiTextarea
              v-model="draft.raw"
              :rows="2"
              :max-rows="6"
              mono
              placeholder="留空则用上面的字段拼接;整串模式优先于字段,填了整串字段就不发送"
              @input="markManual"
            />
          </label>

          <label class="bbi-modal-field">
            <span class="bbi-modal-label">自然语言外貌(可选)</span>
            <BbiTextarea
              v-model="draft.nl"
              :rows="2"
              :max-rows="4"
              mono
              placeholder="一句连贯英文外貌描述,自然语言模式下替换 nl 里的 @角色名 用;留空则用 tag 串替换"
              @input="markManual"
            />
          </label>
        </template>

        <!-- 页签二:NSFW 字段 -->
        <template v-else-if="dialogTab === 'nsfw'">
          <div class="bbi-modal-field">
            <span class="bbi-modal-label">NSFW 字段</span>
            <div class="bbi-char-form bbi-char-form--grid">
              <label v-for="f in NSFW_FIELDS" :key="f" class="bbi-char-form-cell">
                <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
                <BbiTextarea
                  v-model="draft.fields[f]"
                  :rows="2"
                  :max-rows="6"
                  mono
                  :placeholder="FIELD_PLACEHOLDERS[f]"
                  @input="markManual"
                />
              </label>
            </div>
          </div>
          <span class="bbi-field-hint">只写固定基础特征;服装、表情、动作不入库,每次按剧情生成。</span>
        </template>

        <!-- 页签三:角色专属 LoRA -->
        <template v-else>
          <div class="bbi-modal-field">
            <span class="bbi-modal-label">LoRA 挂载(可选)</span>
            <div class="bbi-char-form bbi-char-form--list">
              <label class="bbi-char-form-row bbi-char-form-row--full">
                <span class="bbi-char-form-label">LoRA 文件</span>
                <BbiCombo
                  v-model="draftLoraName"
                  :options="loraOptions"
                  placeholder="留空 = 不绑定;可从 ComfyUI 的 models/loras 里选"
                  aria-label="LoRA 文件"
                />
              </label>
              <label class="bbi-char-form-row bbi-char-form-row--full">
                <span class="bbi-char-form-label">强度</span>
                <input
                  v-model.number="draftLoraStrength"
                  class="bbi-input"
                  type="number"
                  min="0"
                  max="2"
                  step="0.05"
                />
              </label>
              <label class="bbi-char-form-row bbi-char-form-row--full">
                <span class="bbi-char-form-label">触发词</span>
                <input
                  v-model="draftLoraTrigger"
                  class="bbi-input"
                  placeholder="如 adnim, 1girl, long hair, grey eyes;整串会完整写入,不会省略"
                />
              </label>
            </div>
          </div>
          <span class="bbi-field-hint">
            只有该角色出现在画面里时才挂载这个 LoRA;触发词串会<strong>完整写入</strong>正向提示词(缺失的词自动补齐,已有的不重复)。
            渠道里同名的 LoRA 会被自动剔除。仅 ComfyUI「简易参数」模式生效(自定义工作流请在渠道页自行挂载)。
          </span>
          <p v-if="draftLoraMode" class="bbi-field-hint bbi-char-lora-active">
            当前为 <strong>LoRA 模式</strong>:外貌字段与整串<strong>不会发送</strong>给 AI,只发送触发词串(优先级:LoRA &gt; 整串 &gt; 外貌字段)。
          </p>
        </template>

        <!-- 最终预览:固定在底部,不随页签切换 -->
        <div class="bbi-char-preview">
          <span class="bbi-field-label">最终 tag 预览</span>
          <code class="bbi-char-preview-tag">{{ previewTag || '(空)' }}</code>
          <span v-if="draftLoraMode" class="bbi-char-preview-mode">LoRA 模式</span>
          <span v-else-if="draftIsRaw" class="bbi-char-preview-mode">整串模式</span>
        </div>

        <!-- 变更历史:仅本聊天条目;全局条目无历史(AI 不可改,手动编辑不留痕) -->
        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            变更历史({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">{{ record.floor >= 0 ? `第${record.floor}楼` : '手动' }}·{{ new Date(record.at).toLocaleString() }}</span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="把该字段回滚到变更前的值" @click="askRollback(record)">
                回滚
              </button>
            </li>
          </ul>
        </div>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除角色"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          确定删除「{{ editingName }}」的固定外貌 tag 吗?之后生成时该角色的外貌将不再锚定。
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="提升为全局"
          confirm-text="提升"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          把「{{ editingName }}」的当前外貌快照进全局库?之后所有聊天(包括本聊天)都以全局值为准,
          AI 不能再修改它;本聊天的副本与变更记录将被清除。
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmClearAllOpen"
          title="清空所有提示词"
          confirm-text="清空"
          confirm-icon="edit"
          tone="danger"
          top-layer
          @confirm="confirmClearAll"
        >
          清空「{{ draft?.name || '当前草稿' }}」的所有提示词(11 外貌字段 + 整串 + 自然语言 + 描述)吗?
          <strong style="color: var(--bbi-ink);">角色名会保留</strong>,方便你重新填入;操作无法撤销,已填字段需手动重打。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 分类表单弹窗 ===== -->
    <ModalMask :open="!!categoryDraft" @close="closeCategoryDraft">
      <div
        v-if="categoryDraft"
        class="bbi-modal bbi-category-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="categoryDraftIsNew ? '新建分类' : '编辑分类'"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ categoryDraftIsNew ? '新建分类' : '编辑分类' }}
            <span v-if="!categoryDraftIsNew" class="bbi-closet-count">
              {{ countOutfitsInCategory(categoryDraft.id) }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeCategoryDraft">
            <Icon name="close" />
          </button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">分类名<em class="bbi-closet-req">必填</em></span>
          <input
            v-model="categoryDraft.name"
            class="bbi-input"
            placeholder="如 校服 / 日常 / 宴会 / 战斗"
          />
        </label>
        <span class="bbi-field-hint">
          起成能看懂的情境词。生成时这个分类名会连同它下面的服装一起发给 AI,
          名字越具体，AI 越容易在对应场景里挑到它。
        </span>

        <div class="bbi-closet-form-foot">
          <button
            v-if="!categoryDraftIsNew"
            class="bbi-btn bbi-btn-sm bbi-closet-del"
            type="button"
            @click="askDeleteCurrentCategory"
          >
            <Icon name="trash" />删除
          </button>
          <span class="bbi-closet-spacer"></span>
          <span v-if="!categoryCanSave" class="bbi-closet-warn">分类名不能为空</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="closeCategoryDraft">取消</button>
          <button
            class="bbi-btn bbi-btn-sm bbi-btn-primary"
            type="button"
            :disabled="!categoryCanSave"
            @click="saveClosetCategory"
          >
            完成
          </button>
        </div>
      </div>
    </ModalMask>

    <!-- ===== 删除分类确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmDeleteCategoryOpen"
      title="删除分类"
      confirm-text="删除"
      tone="danger"
      top-layer
      @confirm="confirmDeleteClosetCategory"
    >
      <template v-if="pendingDeleteCategory">
        删除分类「{{ pendingDeleteCategory.name }}」?它下面的
        {{ countOutfitsInCategory(pendingDeleteCategory.id) }} 套服装会移到「未分类」,不会跟着一起删。
      </template>
    </ConfirmDialog>

    <!-- ===== 删除服装确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmDeleteOutfitOpen"
      title="删除服装"
      confirm-text="删除"
      tone="danger"
      top-layer
      @confirm="confirmDeleteClosetOutfit"
    >
      <template v-if="pendingDeleteOutfit">
        删除「{{ pendingDeleteOutfit.name }}」?生成时 AI 就不会再挑到它了。
      </template>
    </ConfirmDialog>

    <!-- ===== 回滚确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="回滚变更"
      confirm-text="回滚"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        把「{{ pendingRollback.name }}」的「{{ fieldLabel(pendingRollback.record.field) }}」从
        <code>{{ pendingRollback.record.to }}</code> 回滚到
        <code>{{ pendingRollback.record.from || '(空)' }}</code> ?
        建档记录的回滚会删除整个条目。
      </template>
    </ConfirmDialog>

    <!-- ===== 一键导入手机UI · 模式选择 ===== -->
    <ModalMask :open="importAllModeOpen" @close="closeImportAllMode">
      <div
        v-if="importAllModeOpen"
        class="bbi-modal bbi-import-mode-modal"
        role="dialog"
        aria-modal="true"
        aria-label="一键导入手机UI"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            <Icon name="download" />
            一键导入手机UI
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeImportAllMode">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-confirm-text">
          手机UI「角色外观缓存」里所有角色都会处理一次。两种模式区别只在「遇到库里已有同名角色时」怎么办:
        </p>
        <div class="bbi-import-mode-options">
          <button
            class="bbi-import-mode-opt"
            type="button"
            :disabled="importAllBusy"
            @click="runImportAll('overwrite')"
          >
            <span class="bbi-import-mode-opt-head">
              <Icon name="upload" />
              <span class="bbi-import-mode-opt-title">全部覆盖 + 加导入新角色</span>
            </span>
            <span class="bbi-import-mode-opt-desc">
              同名条目按手机UI当前值更新字段(没填的字段保留库里原值,避免被空值洗掉);手机UI里有但全局库里没的追加进来。
            </span>
          </button>
          <button
            class="bbi-import-mode-opt"
            type="button"
            :disabled="importAllBusy"
            @click="runImportAll('addOnly')"
          >
            <span class="bbi-import-mode-opt-head">
              <Icon name="plus" />
              <span class="bbi-import-mode-opt-title">只导入新角色</span>
            </span>
            <span class="bbi-import-mode-opt-desc">
              完全跳过同名条目,只把手机UI里有但全局库里没的角色追加进来。适合「保留手动精修过的全局模板,只补全新角色」。
            </span>
          </button>
        </div>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" :disabled="importAllBusy" @click="closeImportAllMode">
            取消
          </button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* —— 计数药丸:与设置页版本号同款观感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— 分区 —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— 折叠开关(参照柏宝书「计划/悬念」)——
 * 标题行整体可点:左箭头 + 标题 + 计数标。无框透明,折叠是辅助操作,标题仍是主体。 */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右。描边继承 currentColor(muted),hover 整行点亮强调色。 */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 区头右侧小「+」:透明底,hover 才点亮,不喷宾夺主 */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}

/* —— 角色库搜索框 —— 整段窄长,塞进折叠开关与「+」按钮之间;
   flex 让 fold-head 主标题优先占空间,搜索框自适应收窄到 100px 仍可用。 */
.bbi-char-search {
  flex: 0 1 220px;
  min-width: 100px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-search:focus-within {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-search-icon {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
}
.bbi-char-search:focus-within .bbi-char-search-icon {
  color: var(--bbi-accent);
}
.bbi-char-search-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 12.5px;
  padding: 0;
}
.bbi-char-search-input::placeholder {
  color: var(--bbi-ink-muted);
}
/* 关掉浏览器 type=search 自带的 ×(样式不可控、改 background 也不统一),
   改用自己的「×」按钮 —— 要么显示、要么完全不显示,二选一。 */
.bbi-char-search-input::-webkit-search-cancel-button,
.bbi-char-search-input::-webkit-search-decoration {
  -webkit-appearance: none;
  appearance: none;
  display: none;
}
.bbi-char-search-meta {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  font-family: var(--bbi-font-mono);
}
.bbi-char-search-clear {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-muted);
  cursor: pointer;
}
.bbi-char-search-clear:hover {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
@media (max-width: 640px) {
  /* 窄屏标题区已经拥挤,搜索框独立占满第二行 —— 让 + 按钮进第三行 */
  .bbi-char-search {
    flex: 1 1 100%;
    order: 3;
  }
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}
.bbi-char-empty .bbi-btn {
  margin-left: 8px;
  vertical-align: middle;
}

/* —— 角色列表:单列长条(方形头像 + 名字 + 右侧徽标),点整行进编辑 —— */
/* —— 角色头像格子网格:一个角色一个正方形格子,名字在格子下面 —— */
.bbi-char-tiles {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 14px 12px;
}
.bbi-char-tile {
  min-width: 0;
}
.bbi-char-tile-box {
  position: relative;
  aspect-ratio: 1 / 1;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  overflow: hidden;
  background: var(--bbi-bg);
  color: var(--bbi-ink);
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-tile-box:hover {
  border-color: var(--bbi-accent);
}
.bbi-char-tile-box:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 1px;
}
.bbi-char-tile-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 空头像:名字首字 + 稳定色块 */
.bbi-char-tile-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 500;
  user-select: none;
}
/* 格内生成按钮:底部小药丸,默认半透明不抢图,悬停/聚焦时清晰;点击即用
   角色外貌串 + 内置头像提示词出图,存成该角色目录下的固定文件名 avatar.* */
.bbi-char-tile-gen {
  position: absolute;
  left: 50%;
  bottom: 6px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--bbi-line);
  border-radius: 999px;
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  opacity: 0.6;
  transition:
    opacity var(--bbi-dur) var(--bbi-ease),
    color var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-tile-gen:hover {
  opacity: 1;
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-char-tile-gen:disabled {
  opacity: 0.85;
  cursor: progress;
}
.bbi-char-tile-name {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-char-tile-badges {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
  flex-wrap: wrap;
  min-height: 18px;
}

/* —— 外貌字段:桌面两列,窄屏单列;NSFW 默认折叠 —— */
.bbi-char-form--grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.bbi-char-form-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
/* —— 弹窗表单:LoRA 页走列表行,外貌/NSFW 页走上面的两列网格 —— */
.bbi-char-modal {
  max-width: 680px;
}
.bbi-char-form--list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-label {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* —— 编辑弹窗分组页签:外貌字段 / NSFW / LoRA,点一下切换 —— */
.bbi-char-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--bbi-line);
}
.bbi-char-tab {
  position: relative;
  padding: 7px 12px;
  border: none;
  background: transparent;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.bbi-char-tab:hover {
  color: var(--bbi-ink);
}
.bbi-char-tab.is-on {
  color: var(--bbi-accent);
  border-bottom-color: var(--bbi-accent);
  font-weight: 500;
}
.bbi-char-tab-count {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bbi-line);
  color: var(--bbi-ink-muted);
  font-size: 11px;
}
.bbi-char-tab.is-on .bbi-char-tab-count {
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
}
/* 工具条里的「更多」下拉:和按钮同高、别把完成顶出去 */
.bbi-char-more {
  min-width: 92px;
}

.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* ============ 服装库 ============ */

/* 标题右侧入口与弹窗题头共用的小计数药丸(比 .bbi-count 更紧凑,要塞进按钮里) */
.bbi-closet-count {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  line-height: 1.6;
}

/* 服装库标题行:标题 + 计数药丸并排(计数是独立元素,不塞进 h2 文本流里) */
.bbi-closet-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bbi-closet-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bbi-closet-item {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  overflow: hidden;
}

/* —— 角色编辑弹窗 · 行动栏 ——
   整组动作按钮(删除/清空/提升/复制/生成/导入/完成)从弹窗底部挪到顶部,
   编辑长表单时不用反复滚到底。分隔线与 header 视觉断开,但仍属 .bbi-modal 的 flex 子项。 */
.bbi-char-edit-toolbar {
  padding-top: 4px;
  border-top: 1px dashed var(--bbi-line);
}
/* 顶部按钮组天然拥挤(最多 7 个),窄屏允许换行不溢出;
   保持 flex-end 走 .bbi-modal-foot-spacer 把「完成」顶到右端。 */
.bbi-char-edit-toolbar .bbi-modal-foot {
  flex-wrap: wrap;
  gap: 6px;
}

/* 收藏按钮:未收藏是中性描边,已收藏用强调色,一眼能看出状态 */
.bbi-char-fav-btn.is-fav {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-char-lora-active {
  color: var(--bbi-accent);
}

.bbi-closet-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--bbi-dur) var(--bbi-ease);
}

.bbi-closet-row:hover {
  background: var(--bbi-surface-2);
}

.bbi-closet-name {
  flex: 0 0 auto;
  font-weight: 600;
  white-space: nowrap;
}

.bbi-closet-pill {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  font-size: 11px;
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  white-space: nowrap;
}

/* 通用款用弱色:它是常态,不该抢眼 */
.bbi-closet-pill.is-generic {
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
}

/* 词串:等宽、单行截断——它可能很长,展开表单里才给全文 */
.bbi-closet-tags {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* 服装表单弹窗:五个字段比角色编辑弹窗长一点,给宽些更舒展 */
.bbi-closet-modal {
  max-width: 560px;
}

.bbi-closet-form-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 必填标记:跟在标签文字后面,小、弱,不喧宾夺主 */
.bbi-closet-req {
  margin-left: 6px;
  font-style: normal;
  font-size: 11px;
  color: var(--bbi-danger);
}

/* 不可保存时的原因说明:紧贴禁用按钮左侧,让「为什么点不动」当场有答案 */
.bbi-closet-warn {
  font-size: 12px;
  color: var(--bbi-danger);
}

/* 禁用态不该再给 hover 反馈——全局 .bbi-btn:hover 并不排除 :disabled,
   主色按钮悬停时还会被 .bbi-btn-primary:hover 提亮,看着像能点。这里按住。 */
.bbi-closet-form-foot .bbi-btn:disabled,
.bbi-closet-form-foot .bbi-btn:disabled:hover {
  opacity: 0.5;
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border-color: var(--bbi-line);
  cursor: not-allowed;
}

.bbi-closet-spacer {
  flex: 1 1 auto;
}

.bbi-closet-del {
  color: var(--bbi-danger);
}
.bbi-closet-del:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.bbi-closet-add {
  display: flex;
  justify-content: flex-start;
  gap: 8px;
}

/* 分类分组容器:复用角色分区的 .bbi-char-section,但要接管它自带的 margin-top,
   改由这里的 gap 统一控制间距,否则第一个分组会多出一截上边距。 */
.bbi-closet-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bbi-closet-groups .bbi-char-section {
  margin-top: 0;
}

/* 分类弹窗只有一个字段,窄一点更紧凑 */
.bbi-category-modal {
  max-width: 420px;
}

/* BbiSelect 的盒子写死 180px(设置页是「左标题右控件」的行布局);
   这里在弹窗表单里要撑满整行,与上面的 input 对齐。 */
.bbi-closet-modal :deep(.bbi-select-box) {
  width: 100%;
}

/* —— 一键导入模式选择弹窗 ——
   两个模式选项是「大按钮卡片」,左图标 + 标题 + 一行说明,
   hover/disabled 都有反馈,整张卡片可点(不只点文字)。 */
.bbi-import-mode-modal {
  max-width: 480px;
}
.bbi-import-mode-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 14px 0 4px;
}
.bbi-import-mode-opt {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-import-mode-opt:hover:not(:disabled) {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface-2);
  transform: translateY(-1px);
}
.bbi-import-mode-opt:active:not(:disabled) {
  transform: translateY(0);
}
.bbi-import-mode-opt:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.bbi-import-mode-opt-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--bbi-accent);
  font-weight: 700;
  font-size: 13.5px;
}
.bbi-import-mode-opt-title {
  color: var(--bbi-ink);
}
.bbi-import-mode-opt-desc {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--bbi-ink-soft);
}

@media (max-width: 640px) {
  .bbi-char-form--grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
  /* 窄屏放不下词串预览,行里只留名称 + 归属;全文在展开的表单里看 */
  .bbi-closet-tags {
    display: none;
  }
  /* 导入模式选项标题偏长,窄屏缩字号 */
  .bbi-import-mode-opt-head {
    font-size: 13px;
  }
}
</style>
