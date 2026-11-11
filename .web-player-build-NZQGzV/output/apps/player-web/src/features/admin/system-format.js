/** Number and time formats shared by 概览, 系统状态 and 积分发放: whole dollars and cents from micro-dollars, ages in plain words. */
export const dollars = (micros) => `$${(micros / 1_000_000).toFixed(2)}`;
export const PROVIDER_LABELS = { deepseek: 'DeepSeek（文字）', fish: 'Fish（语音）' };
export const ageText = (ms) => {
    if (ms === null)
        return '—';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60)
        return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
};
export const dateText = (at) => new Date(at).toISOString().slice(0, 10);
export const dateTimeText = (at) => at === null ? '—' : new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
