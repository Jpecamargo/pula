/**
 * Popup: liga/desliga cada streaming e cada comportamento, e mostra o contador.
 *
 * Escreve em chrome.storage.local; o core.js escuta `onChanged` e aplica na
 * hora, sem recarregar a aba. As chaves aqui têm que bater com as do CONFIG do
 * core — chave desconhecida é ignorada lá do outro lado, então um erro de
 * digitação falha em silêncio.
 *
 * `msg` é a chave de tradução em _locales/<lang>/messages.json. Sem tradução
 * carregada, vale o `label` em português.
 */
'use strict';

const STORAGE_CONFIG_KEY = 'config';
const STORAGE_STATS_KEY = 'stats';

/**
 * Um item por adapter em `adapters/`. O `id` tem que ser idêntico ao
 * `adapter.id`, senão o toggle grava numa chave que ninguém lê.
 *
 * Fora do YouTube quase todos usam SSAI (anúncio costurado no mesmo stream, sem
 * botão de pular), então lá o trabalho é mutar, esconder overlay e pular
 * abertura — não cortar o anúncio.
 */
const SITES = [
  { id: 'youtube', label: 'YouTube', msg: 'siteYoutube' },
  { id: 'netflix', label: 'Netflix', msg: 'siteNetflix' },
  { id: 'primevideo', label: 'Prime Video', msg: 'sitePrimevideo' },
  { id: 'disneyplus', label: 'Disney+', msg: 'siteDisneyplus' },
  { id: 'max', label: 'Max', msg: 'siteMax' },
  { id: 'twitch', label: 'Twitch', msg: 'siteTwitch' },
  { id: 'globoplay', label: 'Globoplay', msg: 'siteGloboplay' },
  { id: 'crunchyroll', label: 'Crunchyroll', msg: 'siteCrunchyroll' },
  { id: 'paramountplus', label: 'Paramount+', msg: 'siteParamountplus' },
];

/** Só os toggles booleanos. Números (rate, intervalos) continuam no core.js. */
const OPTIONS = [
  { key: 'clickSkipButton', label: 'Clicar em "Pular anúncio"', msg: 'optClickSkip', hint: 'O caminho principal.', hintMsg: 'optClickSkipHint' },
  { key: 'fastForwardUnskippable', label: 'Adiantar anúncio não-pulável', msg: 'optFastForward', hint: 'Joga o playhead pro fim. Só onde o anúncio é vídeo separado.', hintMsg: 'optFastForwardHint' },
  { key: 'muteDuringAds', label: 'Mutar durante o anúncio', msg: 'optMute' },
  { key: 'restoreAudioAfterAd', label: 'Restaurar o áudio depois', msg: 'optRestoreAudio', hint: 'Só se o mute tiver sido nosso.', hintMsg: 'optRestoreAudioHint' },
  { key: 'hideAdOverlays', label: 'Esconder overlays no player', msg: 'optHideOverlays' },
  { key: 'hideFeedAds', label: 'Esconder anúncios fora do player', msg: 'optHideFeed' },
  { key: 'skipIntros', label: 'Pular abertura e recapitulação', msg: 'optSkipIntros', hint: 'Também "próximo episódio".', hintMsg: 'optSkipIntrosHint' },
  { key: 'skipContinueWatching', label: 'Confirmar "continuar assistindo"', msg: 'optContinueWatching' },
  { key: 'dismissAdblockDialog', label: 'Fechar modal anti-adblock', msg: 'optAdblockDialog' },
  { key: 'skipSponsorChapters', label: 'Pular capítulos de patrocínio', msg: 'optSponsorChapters', hint: 'Usa os capítulos do próprio vídeo.', hintMsg: 'optSponsorChaptersHint' },
  { key: 'collectStats', label: 'Contar estatísticas', msg: 'optStats' },
  { key: 'debug', label: 'Logs [Pula] no console', msg: 'optDebug' },
];

/** Espelha os padrões do core.js: o popup abre antes de qualquer gravação. */
const DEFAULTS = Object.fromEntries(OPTIONS.map((opt) => [opt.key, true]));
DEFAULTS.debug = false;
DEFAULTS.sites = Object.fromEntries(SITES.map((site) => [site.id, true]));

/** Tradução com fallback: sem _locales carregado, fica o texto em português. */
function t(key, fallback) {
  try {
    return (key && chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
  } catch {
    return fallback;
  }
}

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

/** Textos estáticos do HTML (títulos de seção, rodapé, botão). */
function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, el.textContent);
  }
}

/**
 * Read-modify-write em vez de reescrever o objeto inteiro: outra aba (ou o
 * core) pode ter gravado outra chave entre a leitura da tela e o clique.
 */
function writeConfig(mutate) {
  chrome.storage.local.get(STORAGE_CONFIG_KEY, (res) => {
    const next = { ...DEFAULTS, ...(res[STORAGE_CONFIG_KEY] || {}) };
    next.sites = { ...DEFAULTS.sites, ...(next.sites || {}) };
    mutate(next);
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: next });
  });
}

function makeToggle({ checked, text, hint, onChange }) {
  const label = document.createElement('label');

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));

  const span = document.createElement('span');
  span.textContent = text;
  if (hint) {
    const em = document.createElement('em');
    em.textContent = hint;
    span.appendChild(em);
  }

  label.append(input, span);
  return label;
}

function renderSites(sites) {
  const container = document.getElementById('sites');
  container.textContent = '';
  for (const site of SITES) {
    container.appendChild(
      makeToggle({
        checked: sites[site.id] !== false,
        text: t(site.msg, site.label),
        onChange: (on) => writeConfig((cfg) => { cfg.sites[site.id] = on; }),
      }),
    );
  }
}

function renderOptions(config) {
  const container = document.getElementById('options');
  container.textContent = '';
  for (const opt of OPTIONS) {
    container.appendChild(
      makeToggle({
        checked: config[opt.key] !== false,
        text: t(opt.msg, opt.label),
        hint: opt.hint ? t(opt.hintMsg, opt.hint) : null,
        onChange: (on) => writeConfig((cfg) => { cfg[opt.key] = on; }),
      }),
    );
  }
}

applyStaticI18n();

chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
  const config = { ...DEFAULTS, ...(res[STORAGE_CONFIG_KEY] || {}) };
  renderSites({ ...DEFAULTS.sites, ...(config.sites || {}) });
  renderOptions(config);
  renderStats(res[STORAGE_STATS_KEY]);
});

// O core grava as estatísticas em lote (1s de atraso), então o popup aberto
// durante um anúncio vê o número subir sozinho.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_STATS_KEY]) renderStats(changes[STORAGE_STATS_KEY].newValue);
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.set({ [STORAGE_STATS_KEY]: {} }, () => renderStats({}));
});
