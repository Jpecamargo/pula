/**
 * Popup: liga/desliga cada comportamento e mostra o contador.
 *
 * Escreve em chrome.storage.local; o content.js escuta `onChanged` e aplica na
 * hora, sem recarregar a aba. As chaves aqui têm que bater com as do CONFIG —
 * chave desconhecida é ignorada lá do outro lado, então um erro de digitação
 * falha em silêncio.
 */
'use strict';

const STORAGE_CONFIG_KEY = 'config';
const STORAGE_STATS_KEY = 'stats';

/** Só os toggles booleanos. Números (rate, intervalos) continuam no content.js. */
const OPTIONS = [
  { key: 'clickSkipButton', label: 'Clicar em "Pular anúncio"', hint: 'O caminho principal.' },
  { key: 'fastForwardUnskippable', label: 'Adiantar anúncio não-pulável', hint: 'Joga o playhead pro fim.' },
  { key: 'muteDuringAds', label: 'Mutar durante o anúncio' },
  { key: 'restoreAudioAfterAd', label: 'Restaurar o áudio depois', hint: 'Só se o mute tiver sido nosso.' },
  { key: 'hideAdOverlays', label: 'Esconder overlays no player' },
  { key: 'hideFeedAds', label: 'Esconder anúncios do feed' },
  { key: 'skipContinueWatching', label: 'Confirmar "continuar assistindo"' },
  { key: 'dismissAdblockDialog', label: 'Fechar modal anti-adblock' },
  { key: 'skipSponsorChapters', label: 'Pular capítulos de patrocínio', hint: 'Usa os capítulos do próprio vídeo.' },
  { key: 'collectStats', label: 'Contar estatísticas' },
  { key: 'debug', label: 'Logs [Pula] no console' },
];

/** Espelha os padrões do content.js: o popup abre antes de qualquer gravação. */
const DEFAULTS = Object.fromEntries(OPTIONS.map((opt) => [opt.key, true]));
DEFAULTS.debug = false;

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function renderStats(stats = {}) {
  document.getElementById('stat-ads').textContent = Number(stats.adsSkipped) || 0;
  document.getElementById('stat-time').textContent = formatDuration(stats.secondsSaved);
  document.getElementById('stat-chapters').textContent = Number(stats.sponsorChaptersSkipped) || 0;
}

function renderOptions(config) {
  const container = document.getElementById('options');
  container.textContent = '';

  for (const opt of OPTIONS) {
    const label = document.createElement('label');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = config[opt.key] !== false;
    input.addEventListener('change', () => {
      chrome.storage.local.get(STORAGE_CONFIG_KEY, (res) => {
        const next = { ...DEFAULTS, ...(res[STORAGE_CONFIG_KEY] || {}), [opt.key]: input.checked };
        chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: next });
      });
    });

    const text = document.createElement('span');
    text.textContent = opt.label;
    if (opt.hint) {
      const hint = document.createElement('em');
      hint.textContent = opt.hint;
      text.appendChild(hint);
    }

    label.append(input, text);
    container.appendChild(label);
  }
}

chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
  renderOptions({ ...DEFAULTS, ...(res[STORAGE_CONFIG_KEY] || {}) });
  renderStats(res[STORAGE_STATS_KEY]);
});

// O content script grava em lote (1s de atraso), então o popup aberto durante
// um anúncio vê o número subir sozinho.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_STATS_KEY]) renderStats(changes[STORAGE_STATS_KEY].newValue);
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.set({ [STORAGE_STATS_KEY]: {} }, () => renderStats({}));
});
