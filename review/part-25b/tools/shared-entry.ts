import { renderSharedCard } from '../../../apps/player-web/src/features/share/shared-card.ts';
import { PlayerPrefs } from '../../../apps/player-web/src/features/prefs/player-prefs.ts';
import { startTheme } from '../../../apps/player-web/src/features/prefs/theme.ts';
startTheme(new PlayerPrefs(null));
renderSharedCard(document.getElementById('app')!, {
  name: '陈吉米', latin: 'chen jimi', no: '0412', quote: '别熬了，游戏明天还在。你的黑眼圈可不会自己消失。', durationMs: 11000,
  time: 'UTC+8 22:41', date: '2026.10.12',
  aura: ['#DCD2FF', '#FFD8EE', '#BBA4FF', '#7C4DEB'], night: ['#8B5CFF', '#FF4FB8', '#4B2BC9', '#B18CFF'],
}, { play: () => {} });
