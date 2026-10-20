/**
 * 生成「分镜导演」提示词预设(ComfyUI 口径)。
 *
 * 为什么要脚本而不是手写 JSON:
 * 预设是**整体替换**内置规范 —— 一旦 comfySpec 非空,settings.ts 的 DEFAULT_COMFY_SPEC 就不再参与拼装。
 * 因此预设必须自带内置规范的全部硬约束(同人身份 tag 转义、多人绑定、画面补全、景别一致性…),
 * 否则换预设就等于静默回退到「没有这些规则」的旧状态。
 * 这里直接从源码抽取内置文本再追加分镜增强,保证两者不会漂移。
 *
 * 用法:node docs/presets/build-preset.mjs
 * 输出:docs/presets/分镜导演_ComfyUI_v4.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const settingsPath = path.join(root, 'src/state/settings.ts');

/** 从 settings.ts 里取出内置常量(模板字面量),用 Function 还原成运行时字符串。 */
async function extractConst(name) {
  const src = await readFile(settingsPath, 'utf8');
  const marker = `export const ${name} = \``;
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`未在 settings.ts 中找到 ${name}`);
  const start = at + marker.length;
  const end = src.indexOf('`;', start);
  if (end < 0) throw new Error(`${name} 的模板字面量没有闭合`);
  const body = src.slice(start, end);
  if (body.includes('${')) throw new Error(`${name} 含模板插值,不能用本脚本抽取`);
  return Function(`return \`${body}\`;`)();
}

/* —— 分镜增强:源自分镜师系统世界书,已按柏宝绘协议改写 ——
   已丢弃:状态账本、分镜计划行、image 块结构、回复结构、配置面板、角色锚点表、场景锚点表。
   已改写:角色行 → 单串 tag 内按角色分段;场景句 → nl。 */
const SPEC_ENHANCE = `

【服装来源｜优先级最高,与其它段落冲突时以此为准】
女性角色的整套服装只能来自请求里的【服装库】:从可用条目里挑一套,把该条目的词串整条照抄进 tag,
不得改词、不得只抄一部分、不得自行设计版型/颜色/部件。
不得以「与当前场景不符」为由拒绝使用:库里只有一套就无条件用它;有多套时按正文情境挑最接近的一套。
正文对服装的描写不作为款式来源——正文写她穿卫衣而库里没有卫衣,仍然照抄库里那套。
只有完全没有【服装库】区块、或该角色确实没有可用条目(标注「仅限他人」的不算)时,才按正文写;
正文也没写就不写服装细节。
服装库词串里若自带权重(如 (black nightgown:1.1)),原样保留——那是用户自己写的;
你自己新增的 tag 一律不得使用权重语法。
男性角色的服装按正文写到部件级(版型 + 主色 + 关键部件),同一状态全楼复用同一份。

【单人 / 多人写法】
画面里只有一个人时,**人数 tag 必须写全**:1girl, solo(男性写 1boy, solo)。
这是硬性要求,不是可选项——缺了人数 tag,模型会自由决定画几个人,把同一个人画成两三个。
人数 tag 放在最前(插件已拼入 LoRA 触发词时,紧跟触发词串之后),其后才是镜头、外貌、服装、动作。
单人画面禁止出现任何暗示第二个人的 tag:looking at another、2girls、multiple girls、other girl、crowd 一律不写;
视线只能从 looking at viewer / looking away / looking down / looking up / closed eyes 里选。
画面里只有一个人时,所有特征、服装、动作、表情一律直接裸写,不要用 "X on Y" 的绑定写法:
写 silver hair girl smiling 是错的,单人直接写 smile;写 white sweatshirt 就够,不要写 white sweatshirt on silver hair girl。
两人及以上才需要绑定:把每人的服装、动作、表情绑到该人的发色或瞳色特征词上,避免模型随机分配。
同一个 tag 在一张图里只出现一次,不得重复(如 long hair 写一次就够,不要开头一次、末尾又一次)。

【身份 tag 与 LoRA 触发词】
身份 tag 的括号里**只能是作品名**:写 character name \(copyright name\)。
角色库里的 LoRA 触发词(如 adnim)、库条目标记([locked]、[lora]: 等)都不是作品名,
不得写进身份 tag,也不得转义成 \(adnim\) 这种形态——触发词由插件另行拼入提示词,重复写只会污染画面。
无法从角色卡、世界书或正文可靠确定作品时,按原创角色处理,不写身份 tag。

**带 LoRA 的角色:外貌与身份一律由 LoRA 决定,不写任何身份 tag。**
触发词串的第一词(如 momoyuko)是 LoRA 的激活词,不是角色名,更不是作品名:
禁止写成 名字 \(同名\) 这种形态(如 momoyuko \(momoyuko\))——那是把激活词复制成作品名,属于编造。
作品名与角色名相同不构成任何证据;说不出真实作品名时,一律不写。
也不要重复触发词串里已经写明的部位特征(发色、瞳色、体型),插件会整串拼入。

【分镜与镜头】

一、选拍:先决定画哪几拍,再决定怎么拍
把目标正文按语义切成若干拍(一个动作、一次对话回合、一次状态变化为一拍),逐拍打分:
情绪峰值(哭、笑、怒、羞、惊、崩溃、释然)+3;肢体接触或动作高点(拥抱、推倒、挥击、递物、跌倒)+3;
场景、时间、天气转换 +2;服装或外观状态变化(湿身、脱衣、受伤、变装)+2;新角色或关键物件登场 +2;
关系转折(表白、争执爆发、和解)+2;空间位置明显改变(走入、跑开、坐下、起身)+1;纯对话、无动作 +0。
约束:相邻两拍不同时入选;至少一张取自正文后三分之一;同分时优先选与上一张景别差距更大的;
分数普遍很低时不要硬画人物摆拍,改用镜头补位——正反打、环境插入、物件插入、反应镜头、主观视角。
张数由用户设置决定(1–5 张,可能设了最少张数):按上限取分最高的拍;设了「最少 N 张」时,
即使强候选不足也要从较次但仍可见的瞬间补足,不得少给;没设下限时可以少于上限,不凑数。2 张 = 建立或动作 + 反应;3 张 = 建立或中景 → 动作高点 → 余韵;
4 张 = 在动作与余韵之间加一张物件或局部插入;5 张 = 开头再加一张环境过渡。
上一楼末张的景别,本楼第一张不要重复。

二、镜头类型:每一拍必须归入一类
ES 建立:交代地点与人物位置关系;wide shot / very wide shot / full body;from above 或 from side;深景深,环境词给足。
MS 中景:对话、动作进行中、肢体接触;cowboy shot / upper body;from side 或 three quarter view;背景轻微虚化。
CU 特写:情绪爆发、表情变化、收尾余韵;close-up / portrait;face focus;背景只留一到两个光源或色块。
ECU 极特写:眼睛、手、唇、颤抖的指尖等局部;extreme close-up;只保留被拍摄的部位。
INS 插入:关键道具(掉落的信、碎裂的杯子、燃尽的蜡烛);画面里没有人或只有人的一部分,
  写材质、状态、所处表面与光线;无人时人数写 no humans,这是唯一允许无人画面的类型。
OTS 过肩:from behind + looking at another;前景只留肩与后脑,对面角色清晰。
POV 主观:pov + looking at viewer;第一人称不入画,只画其手或影子,且手部标签仅在正文提到时使用。
SIL 剪影:silhouette、backlighting、wide shot;人物细节极少,用色彩与光线表达。
REV 反应:与上一张同轴线、同光线,换到另一个角色,景别可收紧一级。

三、构图
主体占比:ES 10–35%,MS 40–65%,CU 70–90%。主体放在左或右三分线上,另一侧留给环境或对话对象,
  {{#nl}}nl 里写出 on the left third of the frame。{{/nl}}{{^nl}}关掉自然语言时改用 tag 表达位置:left side / right side / center / foreground / background。{{/nl}}人物看向哪一侧,那一侧留出空间。
三层纵深:前景(虚化的物件、植物、肩膀)→ 中景(人物)→ 远景(墙、窗、天空),每张至少写出两层。
from below 表强势与压迫,from above 表渺小与被俯视;对称表对峙,dutch angle 表不安且一张最多一次。
走廊、桥、路、桌沿当引导线;门框、窗框、拱门当框中框——{{#nl}}都在 nl 里写。{{/nl}}{{^nl}}关掉自然语言时不写这些描述性内容,只用 framing / doorway / window 这类 tag 点到为止。{{/nl}}
一图一焦:不要同时写 face focus 与 hand focus;需要同时表现脸与手时用 cowboy shot 且不写焦点,在 nl 里说明。

四、光线与色彩
每个场景先定主光源,所有人与物的受光方向由它决定,同楼各图保持一致;再定一个副光源。
冷暖对比:主光暖则阴影偏冷,反之亦然——{{#nl}}nl 写成 warm orange light from the left, cool blue shadows on the right。{{/nl}}{{^nl}}关掉自然语言时只写 warm lighting / cold shadows 这类光线 tag。{{/nl}}
光线要写方位(from the left / from behind / from above)。夜景至少两个光源,否则画面会糊成一团黑。
天气同时影响光线:雨天加 wet surfaces 与 reflections;雾天加 low contrast,远景发白。
肤色与服装受光色影响,不得在 tag 里同时写互相矛盾的颜色。

五、轴线与连续性
同一场景里两人的画面左右关系不换(180° 规则):谁在画左就一直在画左。换视角只在同一侧的半圆内移动机位。
只有两种情况可以换轴:剧情里明确换位(走到对面、转身绕过),或先插一张中立镜头(俯拍、正面特写)再换。
正反打两张图的左右关系必须一致。

六、互斥:命中任一对,立刻删掉其中之一
景别互斥(full body / wide shot / cowboy shot / upper body / portrait / close-up / extreme close-up 任两个同现)。
视角互斥(from above / from below / from side / from behind 任两个同现;from behind 不得与要求看到正脸的标签同现)。
眼部互斥(closed eyes 与 looking at viewer / eye contact / eye focus / wide-eyed / half-closed eyes)。
嘴部互斥(closed mouth 与 open mouth / parted lips / grin / clenched teeth)。
情绪互斥(smile 与 crying 同现时,必须有 tears of joy 或 laughing 这类合理组合)。
人数互斥(solo 与 2girls / multiple girls;1girl 与 2girls)。
服装互斥(同一部位出现两种服装,以正文当前状态为准)。
发型互斥(short hair 与 long hair;twintails 与 ponytail,除非 low twintails 这类合理组合)。
光线互斥(sunlight 与 night;moonlight 与 sunset,除非描述的是黄昏月出)。
朝向互斥(facing away 与 looking at viewer)。

七、画外裁剪:按景别删掉画面外看不见的 tag 与服装状态
close-up / portrait:只保留头、颈、肩线,删掉胸部以下的服装与体型、下装、鞋袜。
upper body:到腰,删掉鞋袜、下装下摆、腿部特征。cowboy shot:到大腿中段,删掉小腿与鞋袜。
full body:全身,可保留全部标签。wide shot:人物只保留发色、服装主色、姿态,删掉瞳色与表情细节。
from behind:删掉瞳色、嘴部表情、胸前服装细节,保留发型、背部服装与手部动作。
from above:脚与下装弱化。pov:第一人称不入画,不写其外观。

八、硬规则
不加戏:不得添加正文没有的角色、道具、地点、动作;可以补的只有镜头层面的内容(景别、视角、景深、光效、虚化)。
不写否定:不写 no hat、without shoes;要表达没有,就写它的对立状态(barefoot)或者干脆不提。
归属明确:每个外观、服装、表情标签都必须能看出属于谁;双人及以上按角色分段书写并绑定到该角色的特征词上。
一图一事:一张图只有一个景别、一个主视角、一个焦点、一个主要动作。
画外不写:画面里看不到的部位,其标签与服装状态一律删除。
状态连续:服装、湿身、伤痕、手持物、位置、光线只按正文推进,不得无故回弹。
tag 与 nl 之外,不写任何关于插图的解说。

九、内容倾向
优先选择性张力或情色张力最强的画面(这是本预设的默认倾向,用户可在设置里关闭)。
涉及裸露或性行为的角色一律视为成年人;正文写明为未成年人的角色不得作此处理。

十、常见错误对照
无归属标签(2girls, silver hair, blue eyes, white blouse 混在一串)→ 每个角色一段,各自带发色、瞳色、服装。
景别打架(upper body, cowboy shot, close-up)→ 只留一个。
闭眼又写视线(closed eyes, looking at viewer)→ 删掉视线与眼睛焦点。
画外标签(close-up 里写 black skirt, boots)→ 按裁剪表删。
写否定(no shoes)→ barefoot,或干脆不提。
凑数泛词(beautiful, detailed, cute)→ 换成具体细节:hair clinging to cheek、droplets on collarbone。
背景空洞(indoors, window, curtains)→ 换成来自正文的具体物件:rainy window、hanging lanterns、stone fireplace。`;

const THINKING_ENHANCE = `

【分镜自检】输出前逐项过一遍,发现问题直接改,不输出检查过程:
1 人数标签与入镜人数一致;同一角色的外貌在一张图里只写一段,不重复写两遍。
2 每个外观、服装、表情标签都有明确归属。
3 服装与正文当前状态一致;本楼内的状态变化按剧情先后体现,不回弹。
4 景别、视角、焦点各只有一个,且互不冲突。
5 画外裁剪已执行:画面外的部位没有任何 tag。
6 没有否定表达。
7 没有正文里没出现的人物、道具、地点。
8 nl 有位置、有动作、有纵深,短句、肯定句、用名词不用代词。
9 每张图至少有 3 个来自该拍正文的具体细节。
10 同楼各图的景别各不相同,视角至少两种。
11 光源方向与色调前后一致,轴线未被破坏。
12 原创角色没有写身份 tag;同人角色的括号已转义。
13 分级与画面内容相符;涉及裸露或性行为的角色是成年人。
14 没有质量词、画师、年份、负面词(由插件与工作流添加)。
15 没有权重语法,没有下划线,没有分格标签(multiple views / split screen)。
16 女性角色的整套服装来自【服装库】且整串照抄,没有自创款式;男性角色的服装写到部件级。
17 单人画面没有用 "X on Y" 绑定写法;同一张图里没有重复的 tag。
18 身份 tag 的括号里只有作品名,没有 LoRA 触发词,也没有 [locked] / [lora]: 这类库标记。
19 带 LoRA 的角色没有写任何身份 tag,也没有出现「名字 \(同名\)」这种编造形态。
20 单人画面写了 1girl, solo(或 1boy, solo),且没有任何暗示第二个人的 tag。`;

const spec = (await extractConst('DEFAULT_COMFY_SPEC')) + SPEC_ENHANCE;
const thinking = (await extractConst('DEFAULT_COMFY_THINKING')) + THINKING_ENHANCE;

const preset = {
  schemaVersion: 1,
  kind: 'bbi-prompt-preset',
  name: '分镜导演·完整',
  backend: 'comfyui',
  basedOn: '分镜师系统_世界书',
  prompts: { comfySpec: spec, comfyThinking: thinking },
  notes: [
    '内置 ComfyUI 规范与思维链原文保留在前,分镜增强追加在后:预设是整体替换,不带内置就等于丢掉同人身份 tag 转义与多人绑定规则。',
    '源书的 <ledger> 状态账本、分镜计划行、image 块结构、回复结构、配置面板已丢弃:目标系统由插件维护角色库与跨轮状态,模型只输出 JSON。',
    '源书的角色锚点表、锚点生成器、场景锚点表已丢弃:外貌由角色库提供,场景细节改为从正文抽取。',
    '源书的标签数量预算表未收录:与内置规范的 tag 数量口径冲突,以内置为准。',
  ],
};

const outPath = path.join(here, '分镜导演_ComfyUI_v4.json');
await writeFile(outPath, `${JSON.stringify(preset, null, 2)}\n`, 'utf8');
console.log(`写入 ${path.relative(root, outPath)}`);
console.log(`comfySpec ${spec.length} 字符 / comfyThinking ${thinking.length} 字符`);
