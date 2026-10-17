<script setup lang="ts">
import { computed } from 'vue';

/**
 * 内联 SVG 图标 —— 不依赖字体库,天然跨 shadow DOM。
 * 统一 24×24 视框、描边风格(currentColor + stroke),
 * 通过 CSS color / font-size(1em=当前字号)继承尺寸与颜色。
 * 新增图标:往 PATHS 里加一条 name -> 内部 <path>/<circle> 标记。
 */
const props = defineProps<{ name: string; size?: number | string }>();

// 仅放路径数据,统一的 svg 外壳在模板里。stroke 风格。
const PATHS: Record<string, string> = {
  // 渠道页:插座/连接
  backend:
    '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-5.5 5.5A5.5 5.5 0 0 1 6.5 11.5V8z"/><path d="M12 17v4"/>',
  // 生成页:图片(山 + 日,经典 image 图标)
  generate:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5 10 12l4 4 3-3 3.5 3.5"/>',
  // NAI 页:羽毛笔
  nai: '<path d="M20 4c-5 0-11 3-13 9-1.2 3.6-1 5.5-1 7l-2 1"/><path d="M20 4c1 5-1 11-7 13-2 .8-4 .8-6 .5"/><path d="M20 4 9 15"/>',
  // 画笔(品牌标/悬浮球默认图标)
  palette:
    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.4-2.2-.6-1.3.2-2.3 1.6-2.3h1.5a4 4 0 0 0 4-4C20.5 7.3 16.7 3.5 12 3.5z"/><circle cx="8" cy="9.5" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="16" cy="9.5" r="1.1"/>',
  // 角色:人像
  characters: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
  // 服装库:衣架(挂钩 + 梯形衣身)。挂在角色管理页标题右侧,与 characters 同量级墨迹
  wardrobe:
    '<path d="M12 8.6V7.4a2 2 0 1 1 2-2"/><path d="M12 8.6 3.9 14.7c-.7.6-.3 1.8.6 1.8h15c.9 0 1.3-1.2.6-1.8L12 8.6z"/>',
  // 请求历史:时钟 + 左上回拨箭头(时间倒流)。墨迹 3.5~20.5,与 characters/settings 同量级
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 7.5V12l3 1.8"/>',
  // 图库:叠放的图片(后卡露边 + 前卡山日),区别于 generate 的单张图
  gallery:
    '<path d="M7.5 3.5H19a1.5 1.5 0 0 1 1.5 1.5v11"/><rect x="3.5" y="6.5" width="13.5" height="12" rx="1.5"/><circle cx="7.3" cy="10.3" r="1.2"/><path d="M4 15.8 8 12l2.8 2.8 2-2 3.7 3.7"/>',
  // 主要角色:五角星(描边=未标记,可点亮)
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9z"/>',
  // 设置:滑块
  settings:
    '<path d="M5 8h9M18 8h1"/><path d="M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  // 导出/分享:箭头向上出托盘
  upload: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // 导入:箭头向下入托盘
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // 复制:重叠文档
  copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/>',
  // 月亮
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
  // 太阳
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  // 关闭
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // 对勾:确认/保存
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  // 新增/加号
  plus: '<path d="M12 5v14M5 12h14"/>',
  // 显示(睁眼)
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  // 隐藏(闭眼/划线)
  'eye-off':
    '<path d="M4 4l16 16"/><path d="M9.6 5.8A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.8 15.8 0 0 1-3.3 3.9"/><path d="M6.3 8.1A15.9 15.9 0 0 0 2.5 12S6 18.5 12 18.5a8.5 8.5 0 0 0 3.2-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  // 向下箭头(折叠指示)
  chevron: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  // 文本行:提示词面板开关(楼层卡片浮钮)
  text: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6"/>',
  // 更多操作:竖三点(楼层卡片触屏收纳钮,点开展开竖排菜单)。
  // 组件根是 fill=none 描边风格,圆点太小描边会成空心环,故自身覆盖为实心。
  more: '<circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none"/>',
  // 返回:向左箭头(视图回退,如服装库回角色库)
  back: '<path d="M20 12H5"/><path d="m10 7-5 5 5 5"/>',
  // 搜索:放大镜
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  // 多选:勾选清单(左侧对勾 + 右侧行,一眼看出「勾选多条」)
  checklist: '<path d="M3.5 6.5 5 8l2.5-2.5M3.5 12.5 5 14l2.5-2.5M3.5 18.5 5 20l2.5-2.5"/><path d="M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5"/>',
  // 宫格:库管理入口(卡片网格),区别于 gallery 的叠图
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  // 连接/测试
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z M12 16v5"/>',
  // 刷新/拉取
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16M20 20v-4h-4"/>',
  // 删除/垃圾桶:墨迹 x 4~20 / y 4.5~19.5,与 copy(4~19 / 4~20)、download(4~20 / 4~20)
  // 光学尺寸对齐——原来只到 y 6~18.5,同一按钮组里挨着 copy/download 会明显矮一号,
  // 按钮像素尺寸相同也看得出来。桶身仍向下收窄,减轻视觉分量。
  trash: '<path d="M4 6.5h16M9.5 6.5v-2h5v2M6.5 6.5l.9 13h9.2l.9-13"/>',
  // 编辑/铅笔:斜跨 4.5~19.5,墨迹比原来铺满,视觉分量与垃圾桶相当(否则铅笔显小一号)
  edit: '<path d="M4.5 19.5h4L19 9 15 5 4.5 15.5z"/><path d="M13 7 17 11"/>',
  // 闪耀/梦幻(粉彩主题)
  sparkles:
    '<path d="M12 4c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z"/><path d="M18.5 14c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z"/>',
};

const inner = computed(() => PATHS[props.name] ?? '');
const dim = computed(() => (props.size ? (typeof props.size === 'number' ? `${props.size}px` : props.size) : '1em'));
</script>

<template>
  <svg
    class="bbi-icon"
    :style="{ width: dim, height: dim }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.bbi-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.15em;
}
</style>
