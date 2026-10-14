import { describe, expect, it } from 'vitest';

import { buildClosetText, formatOutfitForPrompt } from '@/autoTag/closetAnchors';
import type { ClosetCategory, ClosetOutfit } from '@/state/closet';

/**
 * 服装库「锚定」侧测试:渲染给 AI 的【服装库】文本。
 * 三条与角色库不同的口径必须锁住:
 *   ① 空池整块不下发(返回空串)——没用到衣柜的用户零额外 token;
 *   ② 归属徽标按「仅限角色 / 通用」判定,分类名一并显示;
 *   ③ 分类名当情境信号下发,且只发了真实存在的分类。
 */

function outfit(patch: Partial<ClosetOutfit> = {}): ClosetOutfit {
  return {
    id: 'o1',
    name: '夏制服',
    tags: 'navy blazer, pleated skirt',
    nl: '',
    character: '',
    note: '',
    categoryId: '',
    ...patch,
  };
}

function category(patch: Partial<ClosetCategory> = {}): ClosetCategory {
  return { id: 'c1', name: '校服', parentId: '', ...patch };
}

describe('服装库文本 · 空池', () => {
  it('没有条目时整块不下发', () => {
    expect(buildClosetText([], [])).toBe('');
    expect(buildClosetText([category()], [])).toBe('');
  });
});

describe('服装库文本 · 单条渲染', () => {
  it('通用款带「通用」徽标;填了仅限角色则只给该角色挑', () => {
    expect(formatOutfitForPrompt(outfit(), '')).toBe('- 夏制服（通用）: navy blazer, pleated skirt');
    expect(formatOutfitForPrompt(outfit({ character: '林知意' }), '')).toBe(
      '- 夏制服（仅限 林知意）: navy blazer, pleated skirt',
    );
  });

  it('分类名追加进徽标,与归属徽标用「·」分隔', () => {
    expect(formatOutfitForPrompt(outfit({ character: '林知意' }), '校服')).toBe(
      '- 夏制服（仅限 林知意 · 校服）: navy blazer, pleated skirt',
    );
  });

  it('nl 只在协议含自然语言时附上', () => {
    const withNl = outfit({ nl: 'A girl in a navy blazer.' });
    expect(formatOutfitForPrompt(withNl, '', false)).not.toContain('nl=');
    expect(formatOutfitForPrompt(withNl, '', true)).toContain('｜nl=A girl in a navy blazer.');
    // nl 为空时即便开了 nl 也不占位
    expect(formatOutfitForPrompt(outfit({ nl: '  ' }), '', true)).not.toContain('nl=');
  });
});

describe('服装库文本 · 整块', () => {
  it('含区块头与全部条目词串(AI 照抄用)', () => {
    const text = buildClosetText([], [outfit(), outfit({ id: 'o2', name: '礼服', tags: 'evening gown' })]);
    expect(text).toContain('【服装库】');
    expect(text).toContain('pick ONE set per character and copy its tags verbatim');
    expect(text).toContain('- 夏制服（通用）: navy blazer, pleated skirt');
    expect(text).toContain('- 礼服（通用）: evening gown');
  });

  it('分类名当情境信号:有分类才有信号行,空名分类不进信号行', () => {
    const noCat = buildClosetText([], [outfit()]);
    expect(noCat).not.toContain('分类名即场景信号');

    const withCat = buildClosetText([category(), category({ id: 'c2', name: '宴会' })], [outfit()]);
    expect(withCat).toContain('分类名即场景信号（校服、宴会）');

    const blank = buildClosetText([category({ name: '   ' })], [outfit()]);
    expect(blank).not.toContain('分类名即场景信号');
  });

  it('指向已删分类的条目按未分类处理,不显示野分类名', () => {
    const text = buildClosetText([category()], [outfit({ categoryId: 'gone' })]);
    expect(text).toBe(
      '【服装库】[system-maintained; user-curated; AI read-only — pick ONE set per character and copy its tags verbatim]\n分类名即场景信号（校服）：正文情境与某个分类明显对应时，优先从该分类里挑。\n- 夏制服（通用）: navy blazer, pleated skirt',
    );
  });

  it('条目在分类里时徽标带上该分类名', () => {
    const text = buildClosetText([category()], [outfit({ categoryId: 'c1' })]);
    expect(text).toContain('- 夏制服（通用 · 校服）: navy blazer, pleated skirt');
  });
});
