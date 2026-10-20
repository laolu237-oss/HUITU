import { describe, expect, it } from 'vitest';
import { parsePromptPresetFile } from './promptPreset';

/**
 * 随仓库分发的预设必须能通过导入校验 —— 否则用户点「导入」才看到报错,
 * 而那时我们已经把它当成品发出去了。构建脚本改完跑一次测试即可兜住。
 */
const shipped = import.meta.glob('../../docs/presets/*.json', { eager: true }) as Record<
  string,
  { default: unknown }
>;

describe('随仓库分发的预设文件', () => {
  it('至少存在一份', () => {
    expect(Object.keys(shipped).length).toBeGreaterThan(0);
  });

  for (const [file, mod] of Object.entries(shipped)) {
    it(`${file} 能通过导入校验`, () => {
      const r = parsePromptPresetFile(JSON.stringify(mod.default));
      if (!r.ok) throw new Error(r.error);
      expect(r.preset.backend).toBe('comfyui');
      expect(r.preset.prompts.comfySpec.length).toBeGreaterThan(1000);
      expect(r.preset.prompts.comfyThinking.length).toBeGreaterThan(300);
    });
  }
});
