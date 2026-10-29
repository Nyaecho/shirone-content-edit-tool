/**
 * 全局可变状态（单一事实源）：跨模块共享的运行时数据。
 * 模块级单例——本应用同一时刻只有一个视图栈，无需多实例。
 */
export const state = {
  devMode: false,
  view: "posts",
  tags: { post: [], moment: [], timeline: [] },
  current: { post: null, moment: null, timeline: null, autosave: null },
  editors: {},
  momentImages: [],
  taxonomies: null, // { tags: [{name,posts,moments,total}], categories: [{name,count}] }，null = 未加载
  checkRemoteAhead: null,
};

/** 时间线：全量节点 + 分类（GET /timeline 一次拉齐；编辑靠快照定位，不单独拉详情） */
export const timelineData = { cache: [], categories: [] };
