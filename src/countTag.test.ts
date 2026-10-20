import { describe, expect, it } from 'vitest';
import { ensureSoloTag } from './countTag';

describe('ensureSoloTag', () => {
  it('单人 + 女性线索 → 补 1girl, solo 到最前', () => {
    expect(ensureSoloTag('medium shot, black nightgown, breasts, smile', { characterCount: 1 })).toBe(
      '1girl, solo, medium shot, black nightgown, breasts, smile',
    );
  });

  it('单人 + 男性线索 → 补 1boy, solo', () => {
    expect(ensureSoloTag('upper body, black shirt, male, smile', { characterCount: 1 })).toBe(
      '1boy, solo, upper body, black shirt, male, smile',
    );
  });

  it('性别判断不出来 → 只补 solo', () => {
    expect(ensureSoloTag('medium shot, room, lamp', { characterCount: 1 })).toBe(
      'solo, medium shot, room, lamp',
    );
  });

  it('线索互相矛盾时也只补 solo(不猜性别)', () => {
    expect(ensureSoloTag('girl, boy, standing', { characterCount: 1 })).toBe('solo, girl, boy, standing');
  });

  it('触发词在首位时插在它后面,不把触发词挤走', () => {
    expect(
      ensureSoloTag('momoyuko, long black hair, breasts, medium shot', {
        characterCount: 1,
        triggerToken: 'momoyuko',
      }),
    ).toBe('momoyuko, 1girl, solo, long black hair, breasts, medium shot');
  });

  it('已有人数 tag 时原样返回', () => {
    const tag = '1girl, solo, medium shot';
    expect(ensureSoloTag(tag, { characterCount: 1 })).toBe(tag);
    expect(ensureSoloTag('2girls, medium shot', { characterCount: 1 })).toBe('2girls, medium shot');
    expect(ensureSoloTag('no humans, letter, desk', { characterCount: 1 })).toBe('no humans, letter, desk');
  });

  it('不是单人(未知 / 0 / 多人)一律不动', () => {
    const tag = 'medium shot, breasts, smile';
    expect(ensureSoloTag(tag, {})).toBe(tag);
    expect(ensureSoloTag(tag, { characterCount: 0 })).toBe(tag);
    expect(ensureSoloTag(tag, { characterCount: 2 })).toBe(tag);
  });

  it('空 tag 不动', () => {
    expect(ensureSoloTag('', { characterCount: 1 })).toBe('');
    expect(ensureSoloTag('   ', { characterCount: 1 })).toBe('   ');
  });

  it('幂等:重复调用不会叠加', () => {
    const once = ensureSoloTag('breasts, medium shot', { characterCount: 1 });
    expect(ensureSoloTag(once, { characterCount: 1 })).toBe(once);
  });

  it('触发词大小写/下划线不同也能认出来', () => {
    expect(
      ensureSoloTag('MomoYuko, breasts, medium shot', { characterCount: 1, triggerToken: 'momoyuko' }),
    ).toBe('MomoYuko, 1girl, solo, breasts, medium shot');
  });

  it('性别线索可以来自 hintText(NAI 的 characters[].tag)', () => {
    expect(ensureSoloTag('x', { characterCount: 1, hintText: '1girl, white dress' })).toBe('1girl, solo, x');
    expect(ensureSoloTag('x', { characterCount: 1, hintText: '1boy, black coat' })).toBe('1boy, solo, x');
  });

  it('不因子串误判性别(cowgirl / bracelet)', () => {
    expect(ensureSoloTag('cowgirl, bracelet', { characterCount: 1 })).toBe('solo, cowgirl, bracelet');
  });
});
