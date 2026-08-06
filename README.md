<img src="icons/icon128.png" alt="Pula" width="128" height="128">

# Pula

Extensão de uso pessoal que pula anúncios do YouTube por manipulação de DOM.
Sem build step, sem dependências, sem rede.

## O que ela faz

- Clica em **"Pular anúncio"** assim que o botão aparece — com fallback por
  texto, que sobrevive ao YouTube renomear a classe
- **Adianta** anúncio não-pulável (playhead pro fim; acelerar é o plano B)
- **Muta** durante o anúncio e devolve o áudio depois — a menos que você tenha
  mexido no volume no meio, aí o controle é seu
- **Esconde** overlays no player e anúncios de feed, home, sidebar e masthead
- Confirma sozinho o **"Vídeo pausado. Continuar assistindo?"**
- Fecha o **modal anti-adblock** se ele aparecer por falso positivo
- Pula **capítulos de patrocínio** usando os capítulos do próprio vídeo — sem
  servidor, sem terceiros
- Avisa no console quando os **seletores quebram**, com os candidatos que achou
- **Popup** com um toggle por comportamento e contador de tempo economizado

Nada de `webRequest`, `declarativeNetRequest` ou bloqueio de host: a página
carrega o anúncio normalmente, então o detector anti-adblock não tem sinal pra
disparar. `storage` é a única permissão, e existe só por causa do popup.

## Estrutura

```
pula/
├── manifest.json      # MV3, content script em document_start, permissão storage
├── content.js         # toda a lógica (CONFIG + seletores no topo)
├── popup.html         # UI de toggles e contador
├── popup.js           # lê/grava chrome.storage.local
├── README.md
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

Os três PNGs são obrigatórios se o `manifest.json` declara o bloco `icons` —
Chrome recusa carregar a extensão com referência a arquivo inexistente.

## Carregar sem compactação

1. `chrome://extensions`
2. Ligue **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** → selecione a pasta `pula/` (a pasta, não o
   `manifest.json`)
4. Abra um vídeo do YouTube. Se já havia uma aba aberta, recarregue-a: content
   scripts só são injetados em navegações posteriores à instalação.

Para conferir que está rodando: DevTools → Console → filtre por `[Pula]` depois
de setar `debug: true` no CONFIG.

## Recarregar depois de editar

Content script (`content.js`) e `manifest.json` seguem caminhos diferentes:

| Editou | O que fazer |
|---|---|
| `content.js` | Botão ⟳ no card da extensão em `chrome://extensions` **e** F5 na aba do YouTube |
| `popup.html` / `popup.js` | Feche e reabra o popup (⟳ só se não pegar) |
| `manifest.json` | Botão ⟳ e depois F5. Se o Chrome reclamar, remova e carregue de novo |
| `icons/` | Botão ⟳ (pode precisar de hard-reload da página `chrome://extensions`) |

O ⟳ sozinho não basta: ele recarrega o pacote da extensão, mas a aba do YouTube
continua com a cópia antiga do content script já injetada. Sempre ⟳ + F5.

Atalho: deixe `chrome://extensions` aberta numa aba fixada e edite direto na
pasta — não existe watcher, mas ⟳ + F5 leva dois segundos.

## Ajustes

Ligar e desligar comportamento: clique no ícone da extensão. O toggle vale na
hora, sem F5.

O resto está no topo do `content.js`:

- `CONFIG` — padrões de cada comportamento, mais os números (`stallWarnMs`,
  `fastForwardFallbackRate`, `safetyNetIntervalMs`)
- `SKIP_BUTTON_SELECTORS` — quando o YouTube renomear a classe do botão, é aqui
- `OVERLAY_HIDE_SELECTORS` / `FEED_HIDE_SELECTORS` — o que some via CSS
- `SPONSOR_CHAPTER_RE` — que título de capítulo conta como patrocínio

Atenção: o popup grava por cima do `CONFIG`. Se você editar um valor booleano no
arquivo e nada mudar, é porque aquela chave já está em `chrome.storage` — mexa
pelo popup.

## Quando quebrar

O YouTube renomeia classe de vez em quando. Quando isso acontecer, o console vai
ter um aviso `[Pula] anúncio ativo há mais de 10000ms...` com a lista de botões
que existem dentro do container de anúncio. Pegue o seletor certo dessa lista e
ponha no topo de `SKIP_BUTTON_SELECTORS`.

Se o aviso não aparecer mas o anúncio também não sumir, o fallback por texto
provavelmente está segurando as pontas — vale atualizar o seletor mesmo assim.
