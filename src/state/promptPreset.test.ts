import { describe, expect, it } from 'vitest';
import {
  PROMPT_PRESET_KIND,
  PROMPT_PRESET_SCHEMA,
  buildPromptPresetFile,
  checkNlSections,
  emptyPrompts,
  normalizePromptPresets,
  normalizePresetPrompts,
  parsePromptPresetFile,
  presetSlotSummary,
  promptsEqual,
  type PromptPreset,
} from './promptPreset';

/** 最小可用文件:comfyui 口径,规范与思维链都有内容。 */
function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: PROMPT_PRESET_SCHEMA,
    kind: PROMPT_PRESET_KIND,
    name: '分镜导演',
    backend: 'comfyui',
    basedOn: '分镜师系统',
    prompts: {
      comfySpec: '一图一事。',
      comfyThinking: '检查人数与景别。',
    },
    notes: ['账本已丢弃'],
    ...overrides,
  });
}

function preset(overrides: Partial<PromptPreset> = {}): PromptPreset {
  return {
    id: 'pp_test',
    name: '测试预设',
    backend: 'comfyui',
    prompts: { ...emptyPrompts(), comfySpec: '一图一事。' },
    basedOn: '来源',
    notes: [],
    createdAt: '',
    ...overrides,
  };
}

describe('parsePromptPresetFile', () => {
  it('接受最小可用文件并补齐未用槽位', () => {
    const r = parsePromptPresetFile(file());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preset.name).toBe('分镜导演');
    expect(r.preset.backend).toBe('comfyui');
    expect(r.preset.prompts.comfySpec).toBe('一图一事。');
    expect(r.preset.prompts.naiV5Spec).toBe('');
    expect(r.preset.basedOn).toBe('分镜师系统');
    expect(r.preset.notes).toEqual(['账本已丢弃']);
    expect(r.preset.id).toMatch(/^pp_/);
  });

  it('拒绝非 JSON 与数组', () => {
    expect(parsePromptPresetFile('not json').ok).toBe(false);
    expect(parsePromptPresetFile('[]').ok).toBe(false);
  });

  it('拒绝配置备份文件并给出可执行提示', () => {
    const r = parsePromptPresetFile(JSON.stringify({ app: 'baibai-image', kind: 'config-transfer' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('配置导入导出');
  });

  it('拒绝错误的 kind 与 schemaVersion', () => {
    expect(parsePromptPresetFile(file({ kind: 'other' })).ok).toBe(false);
    expect(parsePromptPresetFile(file({ schemaVersion: 2 })).ok).toBe(false);
    expect(parsePromptPresetFile(file({ schemaVersion: undefined })).ok).toBe(false);
  });

  it('拒绝非法 backend', () => {
    expect(parsePromptPresetFile(file({ backend: 'webui' })).ok).toBe(false);
  });

  it('拒绝未知槽位,防止拼错键静默丢内容', () => {
    const r = parsePromptPresetFile(file({ prompts: { comfySpecc: '拼错', comfySpec: '正常' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未知槽位');
  });

  it('拒绝块协议与 ST 宏', () => {
    const cases = ['image###', '<shot>#1</shot>', '<ledger>x</ledger>', '{{user}}', '{{getvar::x}}', '<% y %>', '<START>'];
    for (const bad of cases) {
      const r = parsePromptPresetFile(file({ prompts: { comfySpec: bad } }));
      expect(r.ok, bad).toBe(false);
    }
  });

  it('允许在否定句里提到块协议(内置思维链就有这种句子)', () => {
    const r = parsePromptPresetFile(
      file({ prompts: { comfySpec: '不得包含 <bbi_image> 标签,也不要输出 <shot> 行。', comfyThinking: '检查。' } }),
    );
    expect(r.ok).toBe(true);
  });

  it('允许把历史标记当连续性线索引用(内置思维链原文如此)', () => {
    const r = parsePromptPresetFile(
      file({
        prompts: {
          comfySpec: '正常规范。',
          comfyThinking: '历史 <bbi_image> 只作连续性线索,不能覆盖正文。',
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('同一份文本里既否定又要求时,按要求拦下', () => {
    const r = parsePromptPresetFile(
      file({ prompts: { comfySpec: '不要输出 <ledger>。\n每张图后面输出 <ledger> 记录状态。', comfyThinking: '检查。' } }),
    );
    expect(r.ok).toBe(false);
  });

  it('拒绝不成对与嵌套的自然语言条件段', () => {
    const unpaired = parsePromptPresetFile(file({ prompts: { comfySpec: '{{#nl}}只开不关' } }));
    expect(unpaired.ok).toBe(false);
    const nested = parsePromptPresetFile(
      file({ prompts: { comfySpec: '{{#nl}}a{{#nl}}b{{/nl}}{{/nl}}' } }),
    );
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error).toContain('嵌套');
  });

  it('允许成对的自然语言条件段', () => {
    const r = parsePromptPresetFile(
      file({ prompts: { comfySpec: '{{#nl}}有句{{/nl}}{{^nl}}只有 tag{{/nl}}', comfyThinking: '检查。' } }),
    );
    expect(r.ok).toBe(true);
  });

  it('拒绝把 {{nl}} 宏写进非 comfySpec 槽位', () => {
    const r = parsePromptPresetFile(
      file({ prompts: { comfyThinking: '{{nl}}', comfySpec: '正常' } }),
    );
    expect(r.ok).toBe(false);
  });

  it('拒绝 backend 与所填槽位不匹配(导入后不会生效)', () => {
    const r = parsePromptPresetFile(file({ prompts: { naiV5Spec: 'NAI 规范' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('comfySpec');
  });

  it('拒绝全空预设', () => {
    expect(parsePromptPresetFile(file({ prompts: {} })).ok).toBe(false);
    expect(parsePromptPresetFile(file({ prompts: { comfySpec: '   ' } })).ok).toBe(false);
  });

  it('超长槽位被拒', () => {
    const r = parsePromptPresetFile(file({ prompts: { comfySpec: 'x'.repeat(12001), comfyThinking: 'ok' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('超长');
  });

  it('缺名字时给默认名', () => {
    const r = parsePromptPresetFile(file({ name: '   ' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preset.name).toBe('导入预设');
  });
});

describe('normalizePresetPrompts / normalizePromptPresets', () => {
  it('逐键兜底成字符串,忽略未知键', () => {
    const p = normalizePresetPrompts({ comfySpec: 'a', unknown: 'b', comfyThinking: 42 });
    expect(p.comfySpec).toBe('a');
    expect(p.comfyThinking).toBe('');
    expect(Object.keys(p)).toHaveLength(7);
  });

  it('丢掉无名条目、修掉重复 id、非法 backend 回退 comfyui', () => {
    const list = normalizePromptPresets([
      { id: 'same', name: 'A', backend: 'nai', prompts: { naiV5Spec: 'x' } },
      { id: 'same', name: 'B', backend: 'weird', prompts: { comfySpec: 'y' } },
      { id: 'x', name: '   ' },
      null,
    ]);
    expect(list).toHaveLength(2);
    expect(list[0].id).not.toBe(list[1].id);
    expect(list[0].backend).toBe('nai');
    expect(list[1].backend).toBe('comfyui');
  });

  it('非数组一律当空', () => {
    expect(normalizePromptPresets(undefined)).toEqual([]);
    expect(normalizePromptPresets({})).toEqual([]);
  });
});

describe('promptsEqual / checkNlSections / presetSlotSummary', () => {
  it('缺失键按空串比较', () => {
    expect(promptsEqual({ comfySpec: 'a' }, { comfySpec: 'a' })).toBe(true);
    expect(promptsEqual({ comfySpec: 'a' }, { comfySpec: 'b' })).toBe(false);
  });

  it('条件段配对判定', () => {
    expect(checkNlSections('{{#nl}}a{{/nl}}')).toBeNull();
    expect(checkNlSections('{{^nl}}a{{/nl}}{{#nl}}b{{/nl}}')).toBeNull();
    expect(checkNlSections('{{/nl}}a')).not.toBeNull();
    expect(checkNlSections('{{#nl}}a')).not.toBeNull();
  });

  it('摘要只列非空槽位', () => {
    const s = presetSlotSummary(preset({ prompts: { ...emptyPrompts(), comfySpec: '12345' } }));
    expect(s).toContain('comfySpec 5 字符');
    expect(s).not.toContain('naiV5Spec');
  });
});

describe('buildPromptPresetFile', () => {
  it('导出后可被自身解析回来(往返一致)', () => {
    const p = preset({
      prompts: { ...emptyPrompts(), comfySpec: '一图一事。', comfyThinking: '检查人数。' },
      notes: ['说明'],
    });
    const file = buildPromptPresetFile(p);
    // 空槽位不写,保持文件可读
    expect(Object.keys(file.prompts as Record<string, string>)).toEqual(['comfySpec', 'comfyThinking']);
    const back = parsePromptPresetFile(JSON.stringify(file));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.preset.prompts.comfySpec).toBe('一图一事。');
    expect(back.preset.backend).toBe('comfyui');
    expect(back.preset.notes).toEqual(['说明']);
  });
});
