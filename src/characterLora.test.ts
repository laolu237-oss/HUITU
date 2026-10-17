import { describe, expect, it } from 'vitest';

import {
  collectBoundLoraNames,
  mergeCharacterLoras,
  resolveCharacterLoras,
  withTriggers,
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

describe('character LoRA binding', () => {
  const entries = [
    entry('林知意', { name: 'Anima\\紫发美女.safetensors', strength: 1, trigger: 'adnim' }),
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
      triggers: ['adnim'],
    });
    // 没绑 LoRA 的角色不产生任何挂载
    expect(resolveCharacterLoras(['路人'], entries)).toEqual({ loras: [], triggers: [] });
  });

  it('dedupes a LoRA shared by two characters and keeps the first strength', () => {
    const shared = [
      entry('甲', { name: 'x.safetensors', strength: 0.6, trigger: 'tok' }),
      entry('乙', { name: 'x.safetensors', strength: 1, trigger: 'tok' }),
    ];
    expect(resolveCharacterLoras(['甲', '乙'], shared)).toEqual({
      loras: [{ name: 'x.safetensors', strength: 0.6 }],
      triggers: ['tok'],
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

  it('prepends triggers in order, without duplicating', () => {
    expect(withTriggers('1girl, smile', ['adnim', 'wbsn'])).toBe('adnim, wbsn, 1girl, smile');
    expect(withTriggers('1girl', [])).toBe('1girl');
    expect(withTriggers('', ['adnim'])).toBe('adnim');
  });
});
