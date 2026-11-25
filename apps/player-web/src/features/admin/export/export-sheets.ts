/**
 * Part 57: the tables each export carries, in the order the server writes them (a CSV carries one of them; a workbook, all). The server
 * always writes every one of these, empty when the data is not there yet, so a table's place never moves.
 */
export const STATS_SHEETS = ['每日统计', '按角色', '按模型', '每小时', '每日消耗', '消耗明细', '按玩家类型'] as const;
export const CONVERSATION_SHEETS = ['每条消息', '按对话汇总'] as const;
export const CALL_SHEETS = ['模型调用', '外部调用', '向量调用', '结果未知的调用'] as const;
export const INVITE_SHEETS = ['批次', '邀请码', '额度'] as const;
export const REHEARSAL_SHEETS = ['预演轮次', '对话', '评分'] as const;
