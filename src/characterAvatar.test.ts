import { describe, expect, it } from 'vitest';

import { AVATAR_PROMPT, buildAvatarPrompt, isAvatarFile } from '@/characterAvatar';

describe('buildAvatarPrompt', () => {
  it('appends the built-in portrait prompt to the character tag', () => {
    expect(buildAvatarPrompt('adnim, long hair, light purple hair')).toBe(
      `adnim, long hair, light purple hair, ${AVATAR_PROMPT}`,
    );
  });

  it('falls back to the built-in prompt when the character has no appearance', () => {
    expect(buildAvatarPrompt('   ')).toBe(AVATAR_PROMPT);
  });
});

describe('isAvatarFile', () => {
  it('recognises the stable avatar file name in any format', () => {
    expect(isAvatarFile('avatar.png')).toBe(true);
    expect(isAvatarFile('avatar.jpg')).toBe(true);
    expect(isAvatarFile('Avatar.PNG')).toBe(true);
  });

  it('does not swallow ordinary gallery images', () => {
    expect(isAvatarFile('avatar_old.png')).toBe(false);
    expect(isAvatarFile('bbi_abc_0_def-gen.png')).toBe(false);
  });
});
