import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildAutoTagMessages } from '@/autoTag/prompt';
import { settings, type AutoTagPrompts, type AutoTagSettings } from '@/state/settings';
import type { STContext } from '@/st/context';

/** 从用户真实 ST 设置里取 comfySpec / comfyThinking，保证复现与线上一致。 */
function userPrompts(): AutoTagPrompts {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = readRaw();
  const es = raw.extension_settings ?? raw.extensionSettings ?? {};
  const at = es.baibai_image?.autoTag ?? {};
  const p = at.prompts ?? {};
  return {
    jailbreak: p.jailbreak ?? '',
    naiSpec: p.naiSpec ?? '',
    naiV5Spec: p.naiV5Spec ?? '',
    comfySpec: p.comfySpec ?? '',
    comfyThinking: p.comfyThinking ?? '',
    naiThinking: p.naiThinking ?? '',
    naiV5Thinking: p.naiV5Thinking ?? '',
  };
}

function readRaw(): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const p = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'com.tauritavern.client',
    'data',
    'default-user',
    'settings.json',
  );
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '（上一层，玩家行动）' },
      {
        name: '林知意',
        is_user: false,
        is_system: false,
        mes:
          '少女推开教室的后门，夕阳把整间教室染成橘红色。她靠在门框上，胸口还在微微起伏，显然是跑过来的。\n\n她抬手把被风吹乱的长发别到耳后，目光落在窗边那个空着的座位上，微微皱起眉。\n\n"又迟到了。"她低声说，嘴角却带着一点笑意。',
      },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: '林知意',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  } as unknown as STContext;
}

describe('dump messages for reproduction', () => {
  it('writes the real message array to disk', async () => {
    settings.defaultBackend = 'comfyui';
    const options: AutoTagSettings = {
      enabled: false,
      autoGenerate: false,
      contextMessages: 1,
      maxImages: 5,
      minImages: 3,
      retryCount: 0,
      libraryFilter: 'relevant',
      prompts: userPrompts(),
    } as unknown as AutoTagSettings;

    const messages = await buildAutoTagMessages(context(), 1, options, null, undefined, null, '', undefined);
    const out = {
      messages,
      stats: {
        count: messages.length,
        chars: messages.reduce((n, m) => n + m.content.length, 0),
      },
    };
    writeFileSync('C:/Users/12642/AppData/Local/Temp/huitu-dump-messages.json', JSON.stringify(out, null, 2), 'utf8');
    expect(messages.length).toBeGreaterThan(3);
    // 打印观察
    // eslint-disable-next-line no-console
    console.log('DUMP STATS', JSON.stringify(out.stats));
  });
});
