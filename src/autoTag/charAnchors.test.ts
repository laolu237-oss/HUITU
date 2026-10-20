import { describe, expect, it } from 'vitest';

import {
  applyCharRefs,
  applyPositionedCharRefs,
  buildLibraryText,
  formatEntryForPrompt,
  parseConvertedTags,
  resolveCharAnchors,
} from '@/autoTag/charAnchors';
import {
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';

function entry(
  name: string,
  fields: Partial<Record<CharTagField, string>>,
  source: CharTagEntry['source'] = 'ai',
): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source,
    desc: '',
    history: [],
  };
}

describe('formatEntryForPrompt / buildLibraryText', () => {
  it('renders non-empty fields with labels in fixed order', () => {
    const text = formatEntryForPrompt(
      entry('小雪', {
        characterTraits: '1girl',
        facialFeatures: 'long black hair, red eyes',
      }),
    );
    expect(text).toBe('- 小雪: 角色特征=1girl, 面部(正)=long black hair, red eyes');
  });

  it('falls back to raw tag when no structured fields', () => {
    const e = entry('旧角色', {});
    e.raw = '1girl, red eyes';
    expect(formatEntryForPrompt(e)).toBe('- 旧角色: tag=1girl, red eyes');
  });

  it('prefers raw over structured fields (三选一优先级:整串 > 字段)', () => {
    const e = entry('小雪', { characterTraits: '1girl', facialFeatures: 'long black hair' });
    e.raw = '1girl, short silver hair, red eyes';
    expect(formatEntryForPrompt(e)).toBe('- 小雪: tag=1girl, short silver hair, red eyes');
  });

  it('renders only the trigger string for LoRA entries (LoRA > 整串 > 字段)', () => {
    const e = entry('小雪', { characterTraits: '1girl', facialFeatures: 'long black hair' });
    e.raw = '1girl, short silver hair';
    e.lora = { name: 'x.safetensors', strength: 1, trigger: 'adnim, long hair, grey eyes' };
    expect(formatEntryForPrompt(e, true)).toBe(
      '- 小雪 [locked] [lora]: adnim, long hair, grey eyes',
    );
    // 外貌字段与整串一个字都不能漏进提示词
    expect(formatEntryForPrompt(e)).not.toContain('角色特征=');
    expect(formatEntryForPrompt(e)).not.toContain('short silver hair');
  });

  it('builds the library block with a header', () => {
    const text = buildLibraryText([entry('小雪', { characterTraits: '1girl' })]);
    expect(text).toContain('【角色固定外貌库');
    expect(text).toContain('- 小雪: 角色特征=1girl');
  });

  it('returns empty string for no entries', () => {
    expect(buildLibraryText([])).toBe('');
  });

  it('marks locked entries and declares immutability in the header', () => {
    const text = buildLibraryText(
      [entry('小雪', { characterTraits: '1girl' }), entry('张三', { characterTraits: '1boy' })],
      new Set(['小雪']),
    );
    expect(text).toContain('- 小雪 [locked]: 角色特征=1girl');
    expect(text).toContain('- 张三: 角色特征=1boy');
    // [2026-10-20] changes 下线后,锁定条目的说明不再提「不要报 changes」,只声明不可改写
    expect(text).toContain('belong to the global library or the phone-UI appearance cache');
    expect(text).not.toContain('never report changes');
    // 无锁定名时头部保持原样(不带锁定说明)
    expect(buildLibraryText([entry('小雪', { characterTraits: '1girl' })])).not.toContain('immutable');
  });
});

describe('library relevance filter', () => {
  const entries = [
    entry('苏曼', { characterTraits: '1girl' }),
    entry('沈若兰', { characterTraits: '1girl' }),
    entry('林小曼', { characterTraits: '1girl' }),
    entry('小曼', { characterTraits: '1girl' }),
    entry('无关角色', { characterTraits: '1boy' }),
  ];

  it('sends full fields only for characters present in the corpus', () => {
    const text = buildLibraryText(entries, undefined, { corpus: '苏曼走进房间，沈若兰抬头。' });
    expect(text).toContain('## 本楼相关（完整字段，可直接照抄）');
    expect(text).toContain('- 苏曼: 角色特征=1girl');
    expect(text).toContain('- 沈若兰: 角色特征=1girl');
    expect(text).toContain('## 其余已建档');
    // 名单只带名字,不带字段
    expect(text).toContain('无关角色');
    expect(text).not.toContain('- 无关角色:');
  });

  it('masks a short name inside a longer hit', () => {
    const text = buildLibraryText(entries, undefined, { corpus: '林小曼笑了。' });
    expect(text).toContain('- 林小曼: 角色特征=1girl');
    const roster = text.split('## 其余已建档')[1] ?? '';
    expect(roster).toContain('小曼');
    expect(text).not.toContain('- 小曼:');
  });

  it('still matches a short name when it stands alone', () => {
    const text = buildLibraryText(entries, undefined, { corpus: '小曼笑了。' });
    expect(text).toContain('- 小曼: 角色特征=1girl');
  });

  it('always keeps alwaysNames in the full section', () => {
    const text = buildLibraryText(entries, undefined, { corpus: '雨停了。', alwaysNames: ['苏曼'] });
    expect(text).toContain('- 苏曼: 角色特征=1girl');
  });

  it('falls back to the whole library when mode=all or the corpus is blank', () => {
    expect(buildLibraryText(entries, undefined, { corpus: '苏曼', mode: 'all' })).not.toContain(
      '其余已建档',
    );
    expect(buildLibraryText(entries, undefined, { corpus: '   ' })).not.toContain('其余已建档');
  });

  it('keeps the locked marker in both sections', () => {
    const text = buildLibraryText(entries, new Set(['苏曼', '无关角色']), { corpus: '苏曼' });
    expect(text).toContain('- 苏曼 [locked]:');
    expect(text).toContain('无关角色 [locked]');
  });

  it('renders an explicit empty-matched section when nobody hits', () => {
    const text = buildLibraryText(entries, undefined, { corpus: '谁也没来。' });
    expect(text).toContain('（本楼没有命中已建档角色。）');
    expect(text).toContain('## 其余已建档');
  });
});

describe('applyCharRefs', () => {
  const entries = [
    entry('小雪', { characterTraits: '1girl', facialFeatures: 'long black hair, red eyes' }),
    entry('张三', { characterTraits: '1boy' }),
  ];

  it('replaces @name placeholders with the joined tag string', () => {
    const { text, unknown } = applyCharRefs('@小雪, white dress, sitting', entries);
    expect(text).toBe('1girl, long black hair, red eyes, white dress, sitting');
    expect(unknown).toEqual([]);
  });

  it('handles multiple placeholders and mixed content', () => {
    const { text } = applyCharRefs('@张三 and @小雪, classroom', entries);
    expect(text).toBe('1boy and 1girl, long black hair, red eyes, classroom');
  });

  it('strips unknown names and tidies separators', () => {
    const { text, unknown } = applyCharRefs('@路人甲, @小雪, smile', entries);
    expect(unknown).toEqual(['路人甲']);
    expect(text).toBe('1girl, long black hair, red eyes, smile');
  });

  it('handles placeholder at both ends and collapses leftovers', () => {
    const { text } = applyCharRefs('@路人甲, @小雪', entries);
    expect(text).toBe('1girl, long black hair, red eyes');
    const { text: t2 } = applyCharRefs('@小雪, @路人甲', entries);
    expect(t2).toBe('1girl, long black hair, red eyes');
  });

  it('replaces nl placeholders with the tag string when no nl sentence exists', () => {
    const { text } = applyCharRefs('@小雪 in a white dress', entries);
    expect(text).toBe('1girl, long black hair, red eyes in a white dress');
  });

  it('prefers the nl sentence for nl replacement when present', () => {
    const e = entry('小雪', { characterTraits: '1girl' });
    e.nl = 'a petite girl with long black hair';
    const { text } = applyCharRefs('@小雪 sits by the window', [e], 'nl');
    expect(text).toBe('a petite girl with long black hair sits by the window');
  });

  it('nl mode falls back to the tag string when no nl sentence', () => {
    const { text } = applyCharRefs('@小雪 sits by the window', entries, 'nl');
    expect(text).toBe('1girl, long black hair, red eyes sits by the window');
  });
});

describe('parseConvertedTags', () => {
  it('parses structured per-character fields', () => {
    const raw = '{"阿黛尔":{"characterTraits":"1girl","facialFeatures":"short silver hair","eyes":""}}';
    expect(parseConvertedTags(raw)).toEqual({
      阿黛尔: { characterTraits: '1girl', facialFeatures: 'short silver hair' },
    });
  });

  it('tolerates code fences and surrounding prose, drops empty records', () => {
    const raw = '好的:\n```json\n{"阿黛尔":{"facialFeatures":"silver"},"空":{"":"  "}}\n```';
    expect(parseConvertedTags(raw)).toEqual({ 阿黛尔: { facialFeatures: 'silver' } });
  });

  it('sanitizes values with newlines or bbi tags, rejects non-object shapes', () => {
    const raw =
      '{"阿黛尔":{"facialFeatures":"long\\nblack hair"},"坏":{"facialFeatures":"x<bbi_image>y"},"串":{"facialFeatures":"ok"}}';
    expect(parseConvertedTags(raw)).toEqual({
      串: { facialFeatures: 'ok' },
      阿黛尔: { facialFeatures: 'long black hair' },
    });
    expect(parseConvertedTags('{"阿黛尔":"plain string"}')).toEqual({});
    expect(parseConvertedTags('no json')).toEqual({});
  });
});

describe('positioned character state', () => {
  it('renders the library without firing any request', () => {
    // 建档已交给主请求:这层只做本地渲染,不再发外貌转换请求
    const entries = [
      entry('小雪', { characterTraits: '1girl', facialFeatures: 'long black hair, blue eyes' }),
    ];
    const resolved = resolveCharAnchors(entries);
    expect(resolved.entries).toBe(entries);
    expect(resolved.text).toContain('- 小雪: 角色特征=1girl');
    expect(resolveCharAnchors([]).text).toBeNull();
  });

  it('uses the old profile before a permanent change and the new profile after it', () => {
    const base = [
      entry('小雪', { characterTraits: '1girl', facialFeatures: 'long black hair, blue eyes' }),
    ];
    const dyeHair = createCharTagSetOp('小雪', 'facialFeatures', 'long red hair, blue eyes', '染发')!;
    const ops = [{ op: dyeHair, sourceLine: 2 }];

    expect(applyPositionedCharRefs('@小雪, smiling', base, ops, 0).text).toBe(
      '1girl, long black hair, blue eyes, smiling',
    );
    expect(applyPositionedCharRefs('@小雪, smiling', base, ops, 2).text).toBe(
      '1girl, long red hair, blue eyes, smiling',
    );
  });

  it('makes a same-response new profile available across the whole floor', () => {
    // 新角色的固定外貌是本楼全程成立的事实,不是「从某处开始」的变化:
    // 按位置门控会让建档位置之前的图片查不到条目,@占位符被整个剥掉 = 角色没有外貌。
    const profile = createCharTagNewOp({
      name: '阿黛尔',
      fields: {
        ...emptyCharFields(),
        characterTraits: '1girl',
        facialFeatures: 'short silver hair, red eyes',
      },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const ops = [{ op: profile, sourceLine: 2 }];
    const expected = '1girl, short silver hair, red eyes, standing';

    expect(applyPositionedCharRefs('@阿黛尔, standing', [], ops, 0)).toEqual({
      text: expected,
      unknown: [],
    });
    expect(applyPositionedCharRefs('@阿黛尔, standing', [], ops, 2).text).toBe(expected);
  });

  it('ignores AI changes targeting locked (global) names', () => {
    const base = [entry('玩家', { characterTraits: '1boy', facialFeatures: 'short black hair' })];
    const dye = createCharTagSetOp('玩家', 'facialFeatures', 'long red hair', '染发')!;
    const ops = [{ op: dye, sourceLine: 0 }];
    const locked = new Set(['玩家']);
    // 锁定:set 被丢弃,始终用库中值
    expect(applyPositionedCharRefs('@玩家, standing', base, ops, 5, 'tag', locked).text).toBe(
      '1boy, short black hair, standing',
    );
    // 不锁定:照旧按位置生效
    expect(applyPositionedCharRefs('@玩家, standing', base, ops, 5).text).toBe(
      '1boy, long red hair, standing',
    );
  });
});
