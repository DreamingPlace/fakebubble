/**
 * The administrator console's 玩家统计 and 消耗表 (Part 22c). Counts, days, models, characters' display names and money only: no
 * principal id, marker, email, nickname, IP hash or message content appears in any of these shapes.
 */
export const STATS_RANGES = [7, 30, 90];
/**
 * Part 22d. Who a reply was for, in priority order (first match wins at admission, then frozen): 测试组 test · 不限量 unlimited ·
 * 每天补充 daily_refill · 注册 registered · 访客 guest. There is no 管理员: nothing links an administrator to a player.
 */
export const STATS_USER_TYPES = ['test', 'unlimited', 'daily_refill', 'registered', 'guest'];
/** 总览 chart: what is counted and over what window. 24h is hourly (the last 24 UTC hours); 7d and 14d are daily. */
export const CHART_METRICS = ['replies', 'chat_users'];
export const CHART_RANGES = ['24h', '7d', '14d'];
