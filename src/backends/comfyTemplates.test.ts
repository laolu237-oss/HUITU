import { describe, expect, it } from 'vitest';

import {
  buildSimpleWorkflow,
  comfySimpleParams,
  normalizeSimpleConfig,
  simpleDefaults,
  templateSupportsNegative,
  validateSimpleConfig,
  type ComfySimpleConfig,
  type SimpleWorkflowNode,
} from '@/backends/comfyTemplates';

const VALUES = { prompt: '1girl, silver hair', seed: 42, width: 832, height: 1216 };

function config(patch: Partial<ComfySimpleConfig>): ComfySimpleConfig {
  return { ...simpleDefaults(), ...patch };
}

function node(workflow: Record<string, SimpleWorkflowNode>, id: string): SimpleWorkflowNode {
  const found = workflow[id];
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

describe('validateSimpleConfig', () => {
  it('未选模型时报错', () => {
    expect(validateSimpleConfig(simpleDefaults())).toContain('模型');
  });

  it('flux/anima 缺 VAE 或 CLIP 时报对应字段;checkpoint 外置 VAE 可留空', () => {
    const flux = { ...simpleDefaults('flux'), model: 'flux1-dev.safetensors' };
    expect(validateSimpleConfig(flux)).toContain('VAE');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors' })).toContain('T5-XXL');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors' })).toContain('CLIP-L');
    expect(
      validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors', clip2: 'clip_l.safetensors' }),
    ).toBeNull();

    const anima = { ...simpleDefaults('anima'), model: 'anima.safetensors', vae: 'qwen_image_vae.safetensors' };
    expect(validateSimpleConfig(anima)).toContain('Qwen');
    expect(validateSimpleConfig({ ...anima, clip1: 'qwen_2.5_vl_7b.safetensors' })).toBeNull();

    expect(validateSimpleConfig(config({ model: 'illustrious.safetensors' }))).toBeNull();
  });
});

describe('buildSimpleWorkflow - checkpoint', () => {
  const simple = config({ model: 'illustrious_xl.safetensors', positive: 'masterpiece, best quality', negative: 'worst quality' });

  it('组出经典五节点链路,正负面按「固定+生成」拼接', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'extra people' });
    expect(node(wf, '1').class_type).toBe('CheckpointLoaderSimple');
    expect(node(wf, '1').inputs.ckpt_name).toBe('illustrious_xl.safetensors');
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, 1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('worst quality, extra people');
    expect(node(wf, '5').inputs).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, '6').inputs).toMatchObject({
      seed: 42,
      steps: 28,
      cfg: 5,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      model: ['1', 0],
      positive: ['3', 0],
      negative: ['4', 0],
    });
    // 无外置 VAE → 用 checkpoint 内置(槽位 2)
    expect(node(wf, '7').inputs.vae).toEqual(['1', 2]);
    expect(node(wf, '8').class_type).toBe('SaveImage');
  });

  it('nl 存在时优先于 tag 作为正向生成内容', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, nl: 'A girl with silver hair.' });
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, A girl with silver hair.');
  });

  it('固定词留空时只剩生成内容(不多逗号)', () => {
    const wf = buildSimpleWorkflow(config({ model: 'm.safetensors' }), VALUES);
    expect(node(wf, '3').inputs.text).toBe('1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('');
  });

  it('外置 VAE 走 VAELoader;LoRA 串联在底模与编码之间', () => {
    const wf = buildSimpleWorkflow(
      config({
        model: 'm.safetensors',
        vae: 'fix_vae.safetensors',
        loras: [
          { name: 'style.safetensors', strength: 0.8 },
          { name: '', strength: 1 }, // 未填完的行被忽略
          { name: 'detail.safetensors', strength: 0.5 },
        ],
      }),
      VALUES,
    );
    expect(node(wf, '2').class_type).toBe('VAELoader');
    expect(node(wf, '7').inputs.vae).toEqual(['2', 0]);
    expect(node(wf, '300').inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0.8, model: ['1', 0], clip: ['1', 1] });
    expect(node(wf, '301').inputs).toMatchObject({ lora_name: 'detail.safetensors', model: ['300', 0], clip: ['300', 1] });
    expect(node(wf, '6').inputs.model).toEqual(['301', 0]);
    expect(node(wf, '3').inputs.clip).toEqual(['301', 1]);
    expect(wf['302']).toBeUndefined();
  });
});

describe('buildSimpleWorkflow - flux', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('flux'),
    model: 'flux1-dev.safetensors',
    vae: 'ae.safetensors',
    clip1: 't5xxl_fp8.safetensors',
    clip2: 'clip_l.safetensors',
  };

  it('UNet + DualCLIP + ae,负面恒空、cfg 恒 1、走 FluxGuidance', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'ignored' });
    expect(node(wf, '1').class_type).toBe('UNETLoader');
    expect(node(wf, '2').inputs).toMatchObject({ clip_name1: 't5xxl_fp8.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' });
    expect(node(wf, '5').inputs.text).toBe('');
    expect(node(wf, '6').inputs).toMatchObject({ guidance: 3.5, conditioning: ['4', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ cfg: 1, positive: ['6', 0], negative: ['5', 0] });
    expect(node(wf, '7').class_type).toBe('EmptySD3LatentImage');
  });

  it('guidance = 1 时跳过 FluxGuidance,直连编码输出', () => {
    const wf = buildSimpleWorkflow({ ...simple, guidance: 1 }, VALUES);
    expect(wf['6']).toBeUndefined();
    expect(node(wf, '8').inputs.positive).toEqual(['4', 0]);
  });

  it('GGUF 用 UnetLoaderGGUF;LoRA 只挂 model(LoraLoaderModelOnly)', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, gguf: true, loras: [{ name: 'flux_lora.safetensors', strength: 1 }] },
      VALUES,
    );
    expect(node(wf, '1').class_type).toBe('UnetLoaderGGUF');
    expect(node(wf, '300').class_type).toBe('LoraLoaderModelOnly');
    expect(node(wf, '300').inputs).not.toHaveProperty('clip');
    expect(node(wf, '8').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - anima', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('anima'),
    model: 'anima_pencil.safetensors',
    vae: 'qwen_image_vae.safetensors',
    clip1: 'qwen_2.5_vl_7b.safetensors',
  };

  it('CLIPLoader 用 qwen_image 类型,模型过 ModelSamplingAuraFlow(shift 可调)', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'blurry' });
    expect(node(wf, '2').inputs).toMatchObject({ clip_name: 'qwen_2.5_vl_7b.safetensors', type: 'qwen_image' });
    expect(node(wf, '6').inputs).toMatchObject({ shift: 3, model: ['1', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ model: ['6', 0], cfg: 4 });
    expect(node(wf, '5').inputs.text).toBe('blurry');
  });

  it('LoRA 链尾接进 AuraFlow 而不是采样器', () => {
    const wf = buildSimpleWorkflow({ ...simple, loras: [{ name: 'a.safetensors', strength: 1 }] }, VALUES);
    expect(node(wf, '6').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - anima2(双采样)', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('anima2'),
    model: 'animaDeltaMix29B.safetensors',
    vae: 'qwen_image_vae.safetensors',
    clip1: 'qwen_3_06b_base.safetensors',
    loras: [],
  };

  it('两段采样:第一段 0→splitStep 吃 shift 输出,第二段 splitStep→末尾接上一段 latent', () => {
    const wf = buildSimpleWorkflow(simple, VALUES);
    expect(node(wf, '6').inputs).toMatchObject({
      add_noise: 'enable',
      start_at_step: 0,
      end_at_step: 10,
      return_with_leftover_noise: 'enable',
      model: ['2', 0],
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      latent_image: ['8', 0],
    });
    expect(node(wf, '7').inputs).toMatchObject({
      add_noise: 'disable',
      start_at_step: 10,
      end_at_step: 10000,
      return_with_leftover_noise: 'disable',
      sampler_name: 'dpmpp_2m',
      scheduler: 'sgm_uniform',
      latent_image: ['6', 0],
    });
  });

  it('★ LoRA 链只喂第二段,第一段仍是纯底模', () => {
    const wf = buildSimpleWorkflow(
      {
        ...simple,
        loras: [
          { name: 'a.safetensors', strength: 0.5 },
          { name: 'b.safetensors', strength: 1 },
        ],
      },
      VALUES,
    );
    expect(node(wf, '300').inputs).toMatchObject({ lora_name: 'a.safetensors', strength_model: 0.5, model: ['1', 0] });
    expect(node(wf, '301').inputs).toMatchObject({ lora_name: 'b.safetensors', strength_model: 1, model: ['300', 0] });
    expect(node(wf, '7').inputs.model).toEqual(['301', 0]); // 第二段吃链尾
    expect(node(wf, '6').inputs.model).toEqual(['2', 0]); // 第一段吃 shift
  });

  it('CLIPLoader 用 stable_diffusion;画布用 EmptyLatentImage 并接尺寸', () => {
    const wf = buildSimpleWorkflow(simple, VALUES);
    expect(node(wf, '3').inputs).toMatchObject({ clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' });
    expect(node(wf, '8').class_type).toBe('EmptyLatentImage');
    expect(node(wf, '8').inputs).toMatchObject({ width: 832, height: 1216, batch_size: 1 });
  });

  it('VAE 走独立 VAELoader,VAEDecode 从它取 vae', () => {
    const wf = buildSimpleWorkflow(simple, VALUES);
    expect(node(wf, '10').class_type).toBe('VAELoader');
    expect(node(wf, '9').inputs).toMatchObject({ samples: ['7', 0], vae: ['10', 0] });
  });

  it('★ 两段各自独立的 CFG:第一段用 cfg,第二段用 cfg2', () => {
    const wf = buildSimpleWorkflow({ ...simple, cfg: 5, cfg2: 2 }, VALUES);
    expect(node(wf, '6').inputs.cfg).toBe(5);
    expect(node(wf, '7').inputs.cfg).toBe(2);
  });

  it('潜空间放大关闭(默认):无放大节点,VAEDecode 直接吃第二段', () => {
    const wf = buildSimpleWorkflow(simple, VALUES);
    expect(wf['12']).toBeUndefined();
    expect(wf['13']).toBeUndefined();
    expect(node(wf, '9').inputs.samples).toEqual(['7', 0]);
  });

  it('潜空间放大开启:插入 LatentUpscale(8 对齐尺寸)+ 精修 KSampler(denoise 0.5),VAEDecode 吃精修输出', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, latentUpscale: true, upscaleScale: 2, upscaleSteps: 10, cfg2: 3 },
      VALUES,
    );
    expect(node(wf, '12').class_type).toBe('LatentUpscale');
    // 832×1216 ×2 = 1664×2432,均为 8 的倍数
    expect(node(wf, '12').inputs).toMatchObject({ upscale_method: 'bilinear', width: 1664, height: 2432, samples: ['7', 0] });
    expect(node(wf, '13').class_type).toBe('KSampler');
    expect(node(wf, '13').inputs).toMatchObject({
      steps: 10,
      cfg: 3,
      denoise: 0.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'sgm_uniform',
      latent_image: ['12', 0],
    });
    expect(node(wf, '9').inputs.samples).toEqual(['13', 0]);
  });

  it('潜空间放大倍数非 8 对齐时仍把尺寸对齐到 8 的倍数', () => {
    const wf = buildSimpleWorkflow({ ...simple, latentUpscale: true, upscaleScale: 1.5 }, VALUES);
    // 832×1216 ×1.5 = 1248×1824,均整除 8
    expect(node(wf, '12').inputs).toMatchObject({ width: 1248, height: 1824 });
  });

  it('正面词是「固定正面 → tag → nl」三段换行(tag 与 nl 都发)', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, positive: 'masterpiece, best quality' },
      { ...VALUES, nl: 'A girl standing by the window.' },
    );
    expect(node(wf, '4').inputs.text).toBe(
      'masterpiece, best quality\n1girl, silver hair\nA girl standing by the window.',
    );
  });

  it('固定正面或 nl 为空时不产生多余换行', () => {
    expect(node(buildSimpleWorkflow({ ...simple, positive: '' }, { ...VALUES, nl: '' }), '4').inputs.text).toBe(
      '1girl, silver hair',
    );
    expect(node(buildSimpleWorkflow({ ...simple, positive: '' }, { ...VALUES, nl: 'nl only' }), '4').inputs.text).toBe(
      '1girl, silver hair\nnl only',
    );
  });

  it('负面 = 固定负面 + AI 动态负面', () => {
    const wf = buildSimpleWorkflow({ ...simple, negative: 'worst quality' }, { ...VALUES, negative: 'extra people' });
    expect(node(wf, '5').inputs.text).toBe('worst quality, extra people');
  });
});

describe('anima2 - 默认值/校验/元信息', () => {
  it('默认值带两段采样参数与推荐 LoRA 列表', () => {
    const d = simpleDefaults('anima2');
    expect(d.steps).toBe(30);
    expect(d.sampler).toBe('euler_ancestral');
    expect(d.sampler2).toBe('dpmpp_2m');
    expect(d.scheduler2).toBe('sgm_uniform');
    expect(d.splitStep).toBe(10);
    expect(d.loras.length).toBe(10);
    expect(d.loras[0]).toEqual({ name: 'Anima\\anima-turbo-lora-v0.2.safetensors', strength: 0.75 });
  });

  it('非两段模板:第二段参数跟随第一段,splitStep 等于总步数,推荐 LoRA 为空', () => {
    const d = simpleDefaults('checkpoint');
    expect(d.sampler2).toBe(d.sampler);
    expect(d.scheduler2).toBe(d.scheduler);
    expect(d.splitStep).toBe(d.steps);
    expect(d.loras).toEqual([]);
  });

  it('分段步数不在 (0, 总步数) 内时报错;合法时不报', () => {
    const base: ComfySimpleConfig = {
      ...simpleDefaults('anima2'),
      model: 'm.safetensors',
      vae: 'v.safetensors',
      clip1: 'c.safetensors',
    };
    expect(validateSimpleConfig(base)).toBeNull();
    expect(validateSimpleConfig({ ...base, splitStep: 0 })).toContain('分段步数');
    expect(validateSimpleConfig({ ...base, splitStep: base.steps })).toContain('分段步数');
    expect(validateSimpleConfig({ ...base, splitStep: base.steps + 5 })).toContain('分段步数');
  });

  it('潜空间放大开启时校验放大倍数(0~8)与步数(≥1)', () => {
    const base: ComfySimpleConfig = {
      ...simpleDefaults('anima2'),
      model: 'm.safetensors',
      vae: 'v.safetensors',
      clip1: 'c.safetensors',
      latentUpscale: true,
    };
    expect(validateSimpleConfig(base)).toBeNull();
    expect(validateSimpleConfig({ ...base, upscaleScale: 0 })).toContain('放大倍数');
    expect(validateSimpleConfig({ ...base, upscaleScale: 9 })).toContain('放大倍数');
    expect(validateSimpleConfig({ ...base, upscaleSteps: 0 })).toContain('放大后步数');
  });

  it('normalize 保留两段参数,缺失项按模板默认兜底', () => {
    expect(normalizeSimpleConfig({ template: 'anima2' })).toMatchObject({
      template: 'anima2',
      steps: 30,
      sampler2: 'dpmpp_2m',
      scheduler2: 'sgm_uniform',
      splitStep: 10,
    });
    expect(normalizeSimpleConfig({ template: 'anima2', sampler2: 'euler', splitStep: '12' })).toMatchObject({
      sampler2: 'euler',
      splitStep: 12,
    });
  });

  it('出图元信息只在 anima2 记录两段参数', () => {
    expect(comfySimpleParams(simpleDefaults('anima2'))).toMatchObject({
      sampler2: 'dpmpp_2m',
      scheduler2: 'sgm_uniform',
      splitStep: 10,
      cfg2: 1,
      latentUpscale: false,
      upscaleScale: 1.5,
      upscaleSteps: 12,
    });
    const single = comfySimpleParams(simpleDefaults('anima'));
    expect(single.sampler2).toBeUndefined();
    expect(single.splitStep).toBeUndefined();
    expect(single.cfg2).toBeUndefined();
  });
});

describe('buildSimpleWorkflow - 尺寸', () => {
  it('尺寸无效时报错(简易模式的画布节点是必建的,没有「工作流写死尺寸」的豁免)', () => {
    const simple = config({ model: 'm.safetensors' });
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, width: 0 })).toThrow('尺寸');
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, height: 0 })).toThrow('尺寸');
  });
});

describe('normalizeSimpleConfig', () => {
  it('空输入给 checkpoint 默认值', () => {
    expect(normalizeSimpleConfig(undefined)).toEqual(simpleDefaults());
  });

  it('非法 template 回 checkpoint;脏字段逐项归位', () => {
    const normalized = normalizeSimpleConfig({
      template: 'qwen-whatever',
      model: 42,
      steps: 'not a number',
      loras: [{ name: 'a.safetensors', strength: '0.7' }, null, 'junk'],
    });
    expect(normalized.template).toBe('checkpoint');
    expect(normalized.model).toBe('');
    expect(normalized.steps).toBe(28);
    expect(normalized.loras).toEqual([
      { name: 'a.safetensors', strength: 0.7 },
      { name: '', strength: 1 },
      { name: '', strength: 1 },
    ]);
  });

  it('合法 template 的采样参数按该模板默认值兜底', () => {
    expect(normalizeSimpleConfig({ template: 'flux' })).toEqual(simpleDefaults('flux'));
    expect(normalizeSimpleConfig({ template: 'anima' }).shift).toBe(3);
  });
});

describe('templateSupportsNegative', () => {
  it('flux 无真实负面输入,其余有', () => {
    expect(templateSupportsNegative('flux')).toBe(false);
    expect(templateSupportsNegative('checkpoint')).toBe(true);
    expect(templateSupportsNegative('anima')).toBe(true);
  });
});
