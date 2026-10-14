/**
 * ComfyUI 简易模式:选模型/LoRA + 填基础参数,插件把预设组装成 API 工作流。
 *
 * 与自定义模式(粘贴 API JSON + %占位符%)互斥:预设二选一,出图时在
 * comfyui.ts 的 generateComfyImage 里分叉,汇合点是「拿到可提交的 JSON」,
 * 之后的排队/轮询/取消完全共用。
 *
 * 模板按模型架构分族,不做「一个工作流打天下」——不同架构的加载节点、
 * latent 类型、负面词支持都不一样,硬揉在一起只会处处是特例。
 * 范围刻意收敛:checkpoint 系(SD1.5/SDXL/Pony/Illustrious)、Flux、Anima(Qwen 链路)。
 * Chroma/视频系等不见实际使用的一律不做,新架构 = 在 COMFY_TEMPLATES 加一条数据 + 一个组装分支。
 *
 * 本模块刻意不 import settings/comfyui:settings.ts 要拿这里的类型与默认值工厂,
 * comfyui.ts 要拿组装器,反向依赖会成环。错误用带中文信息的普通 Error,
 * 由 comfyui.ts 包成 ComfyUIError。
 */

import type { GenerationParams } from '@/generationMeta';

/** 节点引用:[节点 id, 输出槽位]。 */
type NodeRef = [string, number];

// 用 type 而非 interface:接口没有隐式索引签名,赋不进 comfyui.ts 的 ComfyWorkflow(Record<string, JsonObject>)
export type SimpleWorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type SimpleWorkflow = Record<string, SimpleWorkflowNode>;

export type ComfyPresetMode = 'custom' | 'simple';

export type ComfySimpleTemplateId = 'checkpoint' | 'flux' | 'anima' | 'anima2';

export interface ComfyLoraEntry {
  /** LoRA 文件名(相对 models/loras)。 */
  name: string;
  /** 强度;checkpoint 模板同时作用于 model 与 clip,Flux/Anima 只作用于 model。 */
  strength: number;
}

/**
 * 一套简易模式参数。全部字段都有默认值(normalize 保证),
 * 出图组装时只做「选没选模型/VAE/CLIP」这种存在性校验。
 */
export interface ComfySimpleConfig {
  template: ComfySimpleTemplateId;
  /** checkpoint 模板 = ckpt 文件名;flux/anima = diffusion_models 文件名。 */
  model: string;
  /** flux/anima 选了 GGUF 格式的模型 → 用 UnetLoaderGGUF 加载。 */
  gguf: boolean;
  /** 外置 VAE 文件名;checkpoint 模板留空 = 用模型内置 VAE,flux/anima 必填。 */
  vae: string;
  /** flux: t5xxl;anima: qwen_2.5_vl;checkpoint 不用。 */
  clip1: string;
  /** flux: clip_l;其余模板不用。 */
  clip2: string;
  loras: ComfyLoraEntry[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** flux 专用:FluxGuidance 强度;1 = 跳过该节点(直连编码输出)。 */
  guidance: number;
  /** anima 专用:ModelSamplingAuraFlow 的 shift。 */
  shift: number;
  /**
   * anima2 专用:第二段采样器。第一段用 sampler,第二段用 sampler2
   * (两段式就是靠「换采样器 + 换 LoRA」拉开差异)。
   */
  sampler2: string;
  /** anima2 专用:第二段调度器。第一段用 scheduler。 */
  scheduler2: string;
  /**
   * anima2 专用:两段的分界步数。第一段跑 0→splitStep,第二段跑 splitStep→末尾;
   * 两段共用 steps 作为总步数。必须满足 0 < splitStep < steps(见 validateSimpleConfig)。
   */
  splitStep: number;
  /**
   * anima2 专用:第二段(挂 LoRA 那一段)的 CFG。第一段用 cfg,第二段用 cfg2,
   * 两段各自独立可调(低 CFG 控构图、高 CFG 拉细节是常见搭配)。
   */
  cfg2: number;
  /**
   * anima2 专用:是否启用潜空间放大(HiRes)。开启后第二段输出先经 LatentUpscale
   * 放大到更高分辨率,再跑一段精修采样(KSampler,denoise 固定 0.5)补回清晰度,最后进 VAE 解码。
   */
  latentUpscale: boolean;
  /** 潜空间放大倍数;1.5 = 分辨率 ×1.5(内部会把放大后尺寸按 8 对齐到合法 latent 尺寸)。 */
  upscaleScale: number;
  /** 放大后精修采样步数;只在 latentUpscale 开启时生效。 */
  upscaleSteps: number;
  /** 固定正面,拼在 AI 生成内容之前。 */
  positive: string;
  /** 固定负面,AI 动态负面追加在后。 */
  negative: string;
}

export interface ComfyTemplateMeta {
  id: ComfySimpleTemplateId;
  label: string;
  /** 模型字段来自哪个文件列表。 */
  modelKind: 'checkpoint' | 'unet';
  modelLabel: string;
  vaeRequired: boolean;
  vaeLabel: string;
  /** VAE 输入框 placeholder(留空语义/推荐文件名)。 */
  vaePlaceholder: string;
  /** 需要用户选择的 CLIP 文件;checkpoint 内置故为空。 */
  clips: { key: 'clip1' | 'clip2'; label: string }[];
  /** 是否有真实负面输入(Flux 负面恒空,故也不请求 AI 动态负面词)。 */
  supportsNegative: boolean;
  /** 简易模式画幅默认尺寸(写入新预设的横竖尺寸)。 */
  portraitSize: string;
  landscapeSize: string;
  defaults: {
    steps: number;
    cfg: number;
    sampler: string;
    scheduler: string;
    guidance: number;
    shift: number;
    /** anima2 专用:第二段采样器/调度器与分段步数。 */
    sampler2?: string;
    scheduler2?: string;
    splitStep?: number;
    /** anima2 专用:第二段 CFG、潜空间放大开关与参数。 */
    cfg2?: number;
    latentUpscale?: boolean;
    upscaleScale?: number;
    upscaleSteps?: number;
    /**
     * 该模板的推荐 LoRA 列表。只被 simpleDefaults() 用来预填,
     * 面板切模板时若当前 LoRA 列表为空也采用它(用户已填的列表一律保留)。
     */
    loras?: ComfyLoraEntry[];
  };
}

export const COMFY_TEMPLATES: Record<ComfySimpleTemplateId, ComfyTemplateMeta> = {
  checkpoint: {
    id: 'checkpoint',
    label: 'Checkpoint 系(SD1.5/SDXL/Pony/Illustrious)',
    modelKind: 'checkpoint',
    modelLabel: '模型',
    vaeRequired: false,
    vaeLabel: 'VAE',
    vaePlaceholder: '可留空,用模型内置',
    clips: [],
    supportsNegative: true,
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', guidance: 1, shift: 3 },
  },
  flux: {
    id: 'flux',
    label: 'Flux 系',
    modelKind: 'unet',
    modelLabel: '模型',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'ae.safetensors',
    clips: [
      { key: 'clip1', label: 'T5-XXL' },
      { key: 'clip2', label: 'CLIP-L' },
    ],
    supportsNegative: false,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', guidance: 3.5, shift: 3 },
  },
  anima: {
    id: 'anima',
    label: 'Anima 系(Qwen 链路)',
    modelKind: 'unet',
    modelLabel: '模型',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'qwen_image_vae.safetensors',
    clips: [{ key: 'clip1', label: 'Qwen2.5-VL' }],
    supportsNegative: true,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 28, cfg: 4, sampler: 'euler', scheduler: 'simple', guidance: 1, shift: 3 },
  },
  /**
   * Anima 双采样(两段式)—— 从用户实际在用的工作流固化成模板。
   *
   * 与上面单段 anima 的三处结构差异(都是刻意的,不是遗漏):
   * - 采样拆两段:第一段 0→splitStep 用 sampler/scheduler,第二段 splitStep→末尾用 sampler2/scheduler2。
   *   两段共用 steps 作为总步数,第二段 add_noise=disable 接着第一段的噪声继续跑。
   * - **LoRA 只挂第二段**:第一段吃 ModelSamplingAuraFlow 的输出(纯底模跑构图),
   *   第二段才吃 LoRA 链尾。这与单段模板「LoRA 在 shift 之前、两段共用」的顺序不同,
   *   是这套工作流的要点,不能被模板的通用写法覆盖。
   * - CLIPLoader 的 type 用 stable_diffusion(单段 anima 模板用 qwen_image);
   *   画布节点用 EmptyLatentImage(单段用 EmptySD3LatentImage)。
   *
   * 正面词按「固定正面 → AI tag → AI 自然语言」三段换行拼接(见 composePositiveAppendNl),
   * 与单段模板「nl 优先替换 tag」的二选一口径不同 —— 这套工作流是 tag 与 nl 都发。
   */
  anima2: {
    id: 'anima2',
    label: 'Anima 双采样(两段式)',
    modelKind: 'unet',
    modelLabel: '模型',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'qwen_image_vae.safetensors',
    clips: [{ key: 'clip1', label: 'Qwen2.5-VL' }],
    supportsNegative: true,
    portraitSize: '1024×1536',
    landscapeSize: '1536×1024',
    defaults: {
      steps: 30,
      cfg: 1,
      sampler: 'euler_ancestral',
      scheduler: 'normal',
      guidance: 1,
      shift: 3,
      sampler2: 'dpmpp_2m',
      scheduler2: 'sgm_uniform',
      splitStep: 10,
      cfg2: 1,
      latentUpscale: false,
      upscaleScale: 1.5,
      upscaleSteps: 12,
      loras: [
        { name: 'Anima\\anima-turbo-lora-v0.2.safetensors', strength: 0.75 },
        { name: 'Anima\\Scenery_enchancer-Anima-P3.safetensors', strength: 1 },
        { name: 'Anima\\anima_base_slider_step800.safetensors', strength: 1 },
        { name: 'Anima\\anima_context_detailer_base10.safetensors', strength: 0.5 },
        { name: 'Anima\\zodaplus_v2_anima.safetensors', strength: 1 },
        { name: 'Anima\\anima-base-1-masterpiece-v51.safetensors', strength: 1 },
        { name: 'Anima\\gpt-image-2_anima-base1_v1-1.safetensors', strength: 0.3 },
        { name: 'Anima\\Detailer-AnimeBooster.safetensors', strength: 0.5 },
        { name: 'Anima\\zoda_anima_v2.safetensors', strength: 0.3 },
        { name: 'Anima\\S1_Dramatic Lighting Anima_V2.safetensors', strength: 0.3 },
      ],
    },
  },
};

export const COMFY_TEMPLATE_OPTIONS = (Object.keys(COMFY_TEMPLATES) as ComfySimpleTemplateId[]).map(id => ({
  value: id,
  label: COMFY_TEMPLATES[id].label,
}));

export function isComfyTemplateId(value: unknown): value is ComfySimpleTemplateId {
  return typeof value === 'string' && value in COMFY_TEMPLATES;
}

export function templateSupportsNegative(id: ComfySimpleTemplateId): boolean {
  return COMFY_TEMPLATES[id].supportsNegative;
}

/** 新预设的简易模式默认值:采样参数取模板推荐,其余留空待选。 */
export function simpleDefaults(template: ComfySimpleTemplateId = 'checkpoint'): ComfySimpleConfig {
  const meta = COMFY_TEMPLATES[template];
  return {
    template,
    model: '',
    gguf: false,
    vae: '',
    clip1: '',
    clip2: '',
    // 模板带推荐 LoRA 就预填(anima2 固化了用户那套 10 个),否则空列表
    loras: (meta.defaults.loras ?? []).map(lora => ({ ...lora })),
    steps: meta.defaults.steps,
    cfg: meta.defaults.cfg,
    sampler: meta.defaults.sampler,
    scheduler: meta.defaults.scheduler,
    guidance: meta.defaults.guidance,
    shift: meta.defaults.shift,
    // 非两段模板:第二段参数跟随第一段,splitStep 取总步数(等价于「只有一段」)
    sampler2: meta.defaults.sampler2 ?? meta.defaults.sampler,
    scheduler2: meta.defaults.scheduler2 ?? meta.defaults.scheduler,
    splitStep: meta.defaults.splitStep ?? meta.defaults.steps,
    cfg2: meta.defaults.cfg2 ?? meta.defaults.cfg,
    latentUpscale: meta.defaults.latentUpscale === true,
    upscaleScale: meta.defaults.upscaleScale ?? 1.5,
    upscaleSteps: meta.defaults.upscaleSteps ?? 12,
    positive: '',
    negative: '',
  };
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 逐字段清洗;template 非法回 checkpoint。loras 里名字为空的行保留(UI 正在编辑的空行),组装时忽略。 */
export function normalizeSimpleConfig(raw: unknown): ComfySimpleConfig {
  const o = (raw ?? {}) as Partial<ComfySimpleConfig>;
  const template = isComfyTemplateId(o.template) ? o.template : 'checkpoint';
  const base = simpleDefaults(template);
  const steps = Math.max(1, Math.round(asNumber(o.steps, base.steps)));
  return {
    template,
    model: asText(o.model),
    gguf: o.gguf === true,
    vae: asText(o.vae),
    clip1: asText(o.clip1),
    clip2: asText(o.clip2),
    loras: Array.isArray(o.loras)
      ? o.loras.map(entry => ({
          name: asText((entry as Partial<ComfyLoraEntry> | null)?.name),
          strength: asNumber((entry as Partial<ComfyLoraEntry> | null)?.strength, 1),
        }))
      : [],
    steps,
    cfg: asNumber(o.cfg, base.cfg),
    sampler: asText(o.sampler) || base.sampler,
    scheduler: asText(o.scheduler) || base.scheduler,
    guidance: asNumber(o.guidance, base.guidance),
    shift: asNumber(o.shift, base.shift),
    sampler2: asText(o.sampler2) || base.sampler2,
    scheduler2: asText(o.scheduler2) || base.scheduler2,
    // 只做下界保护(负数无意义);「必须小于总步数」由 validateSimpleConfig 报给用户
    splitStep: Math.max(0, Math.round(asNumber(o.splitStep, base.splitStep))),
    cfg2: asNumber(o.cfg2, base.cfg2),
    latentUpscale: o.latentUpscale === true,
    upscaleScale: asNumber(o.upscaleScale, base.upscaleScale),
    upscaleSteps: Math.max(1, Math.round(asNumber(o.upscaleSteps, base.upscaleSteps))),
    positive: asText(o.positive),
    negative: asText(o.negative),
  };
}

/**
 * 出图前校验;返回 null = 可出图,否则是给用户看的中文原因。
 * 面板的状态药丸与组装器共用同一口径,避免「面板说有效、出图才报错」。
 */
export function validateSimpleConfig(simple: ComfySimpleConfig): string | null {
  const meta = COMFY_TEMPLATES[simple.template] ?? COMFY_TEMPLATES.checkpoint;
  if (!simple.model.trim()) return `请选择${meta.modelLabel}`;
  if (meta.vaeRequired && !simple.vae.trim()) return `请选择 ${meta.vaeLabel}`;
  for (const clip of meta.clips) {
    if (!simple[clip.key].trim()) return `请选择 ${clip.label}`;
  }
  // 两段式:分界步数必须落在 (0, 总步数) 开区间内,否则必有一段是空跑
  if (simple.template === 'anima2') {
    if (!(simple.splitStep > 0) || !(simple.splitStep < simple.steps)) {
      return `分段步数要大于 0 且小于总步数（当前总步数 ${simple.steps}）`;
    }
    if (simple.latentUpscale) {
      if (!(simple.upscaleScale > 0) || !(simple.upscaleScale <= 8)) {
        return `放大倍数要在 0~8 之间（当前 ${simple.upscaleScale}）`;
      }
      if (!(simple.upscaleSteps >= 1)) {
        return `放大后步数至少要 1 步（当前 ${simple.upscaleSteps}）`;
      }
    }
  }
  return null;
}

/** 组装入参:与占位符体系同源,只是不走宏替换。 */
export interface SimpleGenValues {
  /** AI 生成的正向 tag。 */
  prompt: string;
  /** AI 生成的自然语言(预设开启「生成自然语言」时才有);简易模式下优先于 tag。 */
  nl?: string;
  /** AI 生成的动态负面 tag。 */
  negative?: string;
  seed: number;
  width: number;
  height: number;
}

/** 逗号拼接非空片段。 */
function joinParts(...parts: (string | undefined)[]): string {
  return parts.map(part => (part ?? '').trim()).filter(Boolean).join(', ');
}

/**
 * 正向 = 固定正面 + 生成内容;生成内容有 nl 优先用 nl(Flux/Anima 吃自然语言),
 * 没有才退回短 tag。开关在预设上,用户自己决定模板与开关的搭配。
 */
export function composePositive(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  return joinParts(simple.positive, (values.nl ?? '').trim() || values.prompt);
}

/** 负面 = 固定负面 + AI 动态负面追加。 */
export function composeNegative(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  return joinParts(simple.negative, values.negative);
}

/**
 * 简易模式的采样参数快照(供随图记录)。只收展示需要的标量;
 * 固定正/负面的实际全文由 composePositive/Negative 直接进 meta。
 */
export function comfySimpleParams(simple: ComfySimpleConfig): GenerationParams {
  const loras = simple.loras
    .filter(lora => lora.name.trim())
    .map(lora => `${lora.name.trim()}×${lora.strength}`)
    .join('、');
  return {
    mode: 'simple',
    template: simple.template,
    baseModel: simple.model,
    vae: simple.vae,
    clips: [simple.clip1, simple.clip2].filter(Boolean).join('、'),
    loras,
    sampler: simple.sampler,
    scheduler: simple.scheduler,
    steps: simple.steps,
    cfg: simple.cfg,
    guidance: simple.guidance,
    shift: simple.shift,
    // 只有双采样模板才有意义,其余模板填的是跟随第一段的等价默认值,不写进元信息
    ...(simple.template === 'anima2'
      ? {
          sampler2: simple.sampler2,
          scheduler2: simple.scheduler2,
          splitStep: simple.splitStep,
          cfg2: simple.cfg2,
          latentUpscale: simple.latentUpscale,
          upscaleScale: simple.upscaleScale,
          upscaleSteps: simple.upscaleSteps,
        }
      : {}),
  };
}

/**
 * LoRA 链:从底模(与 clip)出发逐个串联,返回链尾引用。
 * checkpoint 用 LoraLoader(model+clip 双头);Flux/Anima 的 LoRA 只挂在 UNet 上(LoraLoaderModelOnly)。
 * 名字为空的行是 UI 里没填完的,忽略。
 */
function applyLoras(
  nodes: SimpleWorkflow,
  loras: ComfyLoraEntry[],
  modelOnly: boolean,
  startModel: NodeRef,
  startClip: NodeRef | null,
): { model: NodeRef; clip: NodeRef | null } {
  let model = startModel;
  let clip = startClip;
  loras
    .filter(lora => lora.name.trim())
    .forEach((lora, index) => {
      const id = `30${index}`;
      if (modelOnly) {
        nodes[id] = {
          class_type: 'LoraLoaderModelOnly',
          inputs: { lora_name: lora.name.trim(), strength_model: lora.strength, model },
        };
        model = [id, 0];
      } else {
        nodes[id] = {
          class_type: 'LoraLoader',
          inputs: {
            lora_name: lora.name.trim(),
            strength_model: lora.strength,
            strength_clip: lora.strength,
            model,
            clip: clip!,
          },
        };
        model = [id, 0];
        clip = [id, 1];
      }
    });
  return { model, clip };
}

function unetLoader(simple: ComfySimpleConfig): SimpleWorkflowNode {
  return simple.gguf
    ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: simple.model.trim() } }
    : { class_type: 'UNETLoader', inputs: { unet_name: simple.model.trim(), weight_dtype: 'default' } };
}

function saveNode(images: NodeRef): SimpleWorkflowNode {
  return { class_type: 'SaveImage', inputs: { filename_prefix: 'BaiBai', images } };
}

function buildCheckpointWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: simple.model.trim() } };
  const externalVae = simple.vae.trim();
  if (externalVae) nodes['2'] = { class_type: 'VAELoader', inputs: { vae_name: externalVae } };

  const chain = applyLoras(nodes, simple.loras, false, ['1', 0], ['1', 1]);

  nodes['3'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: chain.clip },
  };
  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composeNegative(simple, values), clip: chain.clip },
  };
  nodes['5'] = {
    class_type: 'EmptyLatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['6'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: chain.model,
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: ['5', 0],
    },
  };
  nodes['7'] = {
    class_type: 'VAEDecode',
    inputs: { samples: ['6', 0], vae: externalVae ? ['2', 0] : ['1', 2] },
  };
  nodes['8'] = saveNode(['7', 0]);
  return nodes;
}

function buildFluxWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = unetLoader(simple);
  nodes['2'] = {
    class_type: 'DualCLIPLoader',
    inputs: { clip_name1: simple.clip1.trim(), clip_name2: simple.clip2.trim(), type: 'flux' },
  };
  nodes['3'] = { class_type: 'VAELoader', inputs: { vae_name: simple.vae.trim() } };

  const chain = applyLoras(nodes, simple.loras, true, ['1', 0], null);

  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: ['2', 0] },
  };
  // Flux 是蒸馏模型:负面恒空,cfg 恒 1,guidance 走 FluxGuidance
  nodes['5'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } };
  let positive: NodeRef = ['4', 0];
  if (simple.guidance !== 1) {
    nodes['6'] = { class_type: 'FluxGuidance', inputs: { guidance: simple.guidance, conditioning: ['4', 0] } };
    positive = ['6', 0];
  }
  nodes['7'] = {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['8'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: 1,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: chain.model,
      positive,
      negative: ['5', 0],
      latent_image: ['7', 0],
    },
  };
  nodes['9'] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } };
  nodes['10'] = saveNode(['9', 0]);
  return nodes;
}

function buildAnimaWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = unetLoader(simple);
  nodes['2'] = {
    class_type: 'CLIPLoader',
    inputs: { clip_name: simple.clip1.trim(), type: 'qwen_image' },
  };
  nodes['3'] = { class_type: 'VAELoader', inputs: { vae_name: simple.vae.trim() } };

  const chain = applyLoras(nodes, simple.loras, true, ['1', 0], null);

  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: ['2', 0] },
  };
  nodes['5'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composeNegative(simple, values), clip: ['2', 0] },
  };
  nodes['6'] = {
    class_type: 'ModelSamplingAuraFlow',
    inputs: { shift: simple.shift, model: chain.model },
  };
  nodes['7'] = {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['8'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: ['6', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['7', 0],
    },
  };
  nodes['9'] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } };
  nodes['10'] = saveNode(['9', 0]);
  return nodes;
}

/**
 * 两段式模板的正面词:固定正面 → AI tag → AI 自然语言,三段换行拼接。
 * 与 composePositive 的差别是「tag 与 nl 都发」(那边是 nl 优先替换 tag 的二选一)——
 * 这套工作流的提示词节点本来就是这么写的,不能沿用二选一口径。
 */
function composePositiveAppendNl(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  return [
    (simple.positive ?? '').trim(),
    (values.prompt ?? '').trim(),
    (values.nl ?? '').trim(),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Anima 双采样(两段式)。拓扑对齐用户实际在用的工作流:
 *
 *   1 UNETLoader ─┬─→ 2 ModelSamplingAuraFlow(shift) ─→ 6 KSamplerAdvanced(第一段)
 *                 └─→ 300.. LoraLoaderModelOnly 链 ───→ 7 KSamplerAdvanced(第二段)
 *   3 CLIPLoader ─┬─→ 4 CLIPTextEncode(正) ─→ 6/7.(13).positive
 *                 └─→ 5 CLIPTextEncode(负) ─→ 6/7.(13).negative
 *   8 EmptyLatentImage ─→ 6.latent_image;6 ─(latent)→ 7
 *   7 ─(可选)→ 12 LatentUpscale(放大) ─→ 13 KSampler(精修,denoise 0.5) ─→ 9 VAEDecode(← 10 VAELoader) ─→ 11 SaveImage
 *     （未开启潜空间放大时 7 直接 ─→ 9）
 *
 * 三处刻意的结构差异(见 COMFY_TEMPLATES.anima2 的注释):
 * ① LoRA 链只喂第二段,第一段走 shift 输出(纯底模跑构图);
 * ② 两段用不同 sampler/scheduler,分界由 splitStep 决定;CFG 也分两段(cfg / cfg2);
 * ③ CLIPLoader.type = stable_diffusion、画布用 EmptyLatentImage。
 * ④ 潜空间放大开启时,第二段之后插入 LatentUpscale + 一段精修 KSampler(HiRes fix),
 *    精修复用第二段采样器/scheduler 与 cfg2,denoise 固定 0.5。
 */
function buildAnima2Workflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = unetLoader(simple);
  nodes['2'] = {
    class_type: 'ModelSamplingAuraFlow',
    inputs: { shift: simple.shift, sampling: 'flow', model: ['1', 0] },
  };
  nodes['3'] = {
    class_type: 'CLIPLoader',
    inputs: { clip_name: simple.clip1.trim(), type: 'stable_diffusion', device: 'default' },
  };
  nodes['10'] = { class_type: 'VAELoader', inputs: { vae_name: simple.vae.trim() } };

  // ★ LoRA 链从 UNETLoader 出发(不经过 shift),链尾只喂第二段
  const chain = applyLoras(nodes, simple.loras, true, ['1', 0], null);

  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositiveAppendNl(simple, values), clip: ['3', 0] },
  };
  nodes['5'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composeNegative(simple, values), clip: ['3', 0] },
  };
  nodes['8'] = {
    class_type: 'EmptyLatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };

  // 第一段:纯底模(吃 shift 输出),带噪声起步,跑 0→splitStep
  nodes['6'] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      add_noise: 'enable',
      noise_seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      start_at_step: 0,
      end_at_step: simple.splitStep,
      return_with_leftover_noise: 'enable',
      model: ['2', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['8', 0],
    },
  };
  // 第二段:接第一段的 latent 继续,不再加噪声,跑 splitStep→末尾
  nodes['7'] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      add_noise: 'disable',
      noise_seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg2,
      sampler_name: simple.sampler2,
      scheduler: simple.scheduler2,
      start_at_step: simple.splitStep,
      end_at_step: 10000,
      return_with_leftover_noise: 'disable',
      model: chain.model,
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
    },
  };

  // 潜空间放大(HiRes):放大 latent + 一段精修采样补回清晰度,再进 VAE
  let decodeSource: NodeRef = ['7', 0];
  if (simple.latentUpscale) {
    // 放大后尺寸按 8 对齐 —— VAE 解码要求宽高均为 8 的倍数,否则会报尺寸错误
    const uw = Math.round((values.width * simple.upscaleScale) / 8) * 8;
    const uh = Math.round((values.height * simple.upscaleScale) / 8) * 8;
    nodes['12'] = {
      class_type: 'LatentUpscale',
      inputs: { upscale_method: 'bilinear', width: uw, height: uh, crop: 'disabled', samples: ['7', 0] },
    };
    // 精修:在更高分辨率上跑 KSampler(denoise 0.5),复用第二段采样器与 cfg2,把放大后的软边补成细节
    nodes['13'] = {
      class_type: 'KSampler',
      inputs: {
        seed: values.seed,
        steps: simple.upscaleSteps,
        cfg: simple.cfg2,
        sampler_name: simple.sampler2,
        scheduler: simple.scheduler2,
        denoise: 0.5,
        model: chain.model,
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['12', 0],
      },
    };
    decodeSource = ['13', 0];
  }

  nodes['9'] = { class_type: 'VAEDecode', inputs: { samples: decodeSource, vae: ['10', 0] } };
  nodes['11'] = saveNode(['9', 0]);
  return nodes;
}

/**
 * 把简易模式预设组装成可提交的 API 工作流(纯函数)。
 * 先跑与面板同口径的 validateSimpleConfig;尺寸异常也在这里报
 * (自定义模式是「工作流没用 %width% 就不查尺寸」,简易模式画布节点是必建的,没有豁免)。
 */
export function buildSimpleWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const invalid = validateSimpleConfig(simple);
  if (invalid) throw new Error(invalid);
  if (!(values.width > 0) || !(values.height > 0)) {
    throw new Error('请在 ComfyUI 渠道页填写竖屏与横屏尺寸（如 832×1216）');
  }
  switch (simple.template) {
    case 'flux':
      return buildFluxWorkflow(simple, values);
    case 'anima':
      return buildAnimaWorkflow(simple, values);
    case 'anima2':
      return buildAnima2Workflow(simple, values);
    default:
      return buildCheckpointWorkflow(simple, values);
  }
}
