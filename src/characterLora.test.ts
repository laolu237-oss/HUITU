import { describe, expect, it } from 'vitest';

import {
  collectBoundLoraNames,
  ensureVerbatimItems,
  mergeCharacterLoras,
  resolveCharacterLoras,
} from '@/characterLora';
import { emptyCharFields, type CharTagEntry, type CharTagLora } from '@/state/charTags';

function entry(name: string, lora?: CharTagLora): CharTagEntry {
  return {
    name,
    fields: emptyCharFields(),
    raw: '1girl',
    nl: '',
    source: 'manual',
    desc: '',
    history: [],
    lora,
  };
}

const TRIGGER =
  'adnim ,1girl, long hair, breasts, bangs, grey eyes, hair between eyes, eyes visible through hair, light purple hair';

describe('ensureVerbatimItems', () => {
  it('appends missing items, skips the ones already present', () => {
    const out = ensureVerbatimItems('2girls, long hair, light purple hair, kitchen', [
      { text: TRIGGER, prependFirst: true },
    ]);
    expect(out).toContain('adnim');
    expect(out).toContain('breasts');
    expect(out).toContain('eyes visible through hair');
    // 已有的不重复添加(大小写/下划线不敏感)
    expect(out.match(/long hair/g)?.length).toBe(1);
    // 人数 tag 从来源里剔除:否则 1girl 会和 2girls 打架
    expect(out).not.toContain('1girl');
  });

  it('puts a missing trigger at the very front', () => {
    const out = ensureVerbatimItems('2girls, kitchen', [
      { text: 'adnim, light purple hair', prependFirst: true },
    ]);
    expect(out.startsWith('adnim')).toBe(true);
  });

  it('is idempotent', () => {
    const once = ensureVerbatimItems('2girls, kitchen', [{ text: TRIGGER, prependFirst: true }]);
    expect(ensureVerbatimItems(once, [{ text: TRIGGER, prependFirst: true }])).toBe(once);
  });

  it('appends raw-mode strings in place without moving the first item', () => {
    const out = ensureVerbatimItems('1girl, smile', [
      { text: 'silver-white-blue hair, blue eyes, long thighs' },
    ]);
    expect(out).toBe('1girl, smile, silver-white-blue hair, blue eyes, long thighs');
  });

  it('ignores underscore/space differences when deduping', () => {
    const out = ensureVerbatimItems('long_hair, smile', [{ text: 'long hair, breasts' }]);
    expect(out).toBe('long_hair, smile, breasts');
  });
});

describe('character LoRA binding', () => {
  const entries = [
    entry('林知意', { name: 'Anima\\紫发美女.safetensors', strength: 1, trigger: 'adnim, long hair' }),
    entry('User', { name: 'Anima\\白发少女.safetensors', strength: 0.8, trigger: 'wbsn' }),
    entry('路人'),
  ];

  it('collects every bound LoRA name', () => {
    expect([...collectBoundLoraNames(entries)]).toEqual([
      'Anima\\紫发美女.safetensors',
      'Anima\\白发少女.safetensors',
    ]);
    expect(collectBoundLoraNames([entry('无绑定')]).size).toBe(0);
  });

  it('resolves only the characters present in the frame', () => {
    expect(resolveCharacterLoras(['林知意', '不存在'], entries)).toEqual({
      loras: [{ name: 'Anima\\紫发美女.safetensors', strength: 1 }],
      sources: [{ text: 'adnim, long hair', prependFirst: true }],
    });
    // 没绑 LoRA 的角色不产生任何挂载
    expect(resolveCharacterLoras(['路人'], entries)).toEqual({ loras: [], sources: [] });
  });

  it('dedupes a LoRA shared by two characters and keeps the first strength', () => {
    const shared = [
      entry('甲', { name: 'x.safetensors', strength: 0.6, trigger: 'tok' }),
      entry('乙', { name: 'x.safetensors', strength: 1, trigger: 'tok' }),
    ];
    expect(resolveCharacterLoras(['甲', '乙'], shared)).toEqual({
      loras: [{ name: 'x.safetensors', strength: 0.6 }],
      sources: [{ text: 'tok', prependFirst: true }],
    });
  });

  it('strips bound LoRAs from the channel list, then appends the active one', () => {
    const base = [
      { name: 'Anima\\anima-turbo-lora-v0.2.safetensors', strength: 1 },
      { name: 'Anima\\紫发美女.safetensors', strength: 1 },
      { name: 'Anima\\白发少女.safetensors', strength: 1 },
    ];
    const bound = collectBoundLoraNames(entries);
    expect(
      mergeCharacterLoras(base, bound, [{ name: 'Anima\\紫发美女.safetensors', strength: 1 }]),
    ).toEqual([
      { name: 'Anima\\anima-turbo-lora-v0.2.safetensors', strength: 1 },
      { name: 'Anima\\紫发美女.safetensors', strength: 1 },
    ]);
  });

  it('leaves the channel list untouched when nothing is bound', () => {
    const base = [{ name: 'style.safetensors', strength: 0.5 }];
    expect(mergeCharacterLoras(base, new Set(), [])).toEqual(base);
  });
});
