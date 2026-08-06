<img src="icons/icon128.png" alt="Pula" width="128" height="128">

# Pula

Extensão de uso pessoal que pula anúncios do YouTube por manipulação de DOM.
Sem build step, sem dependências, sem permissões, sem rede.

## Estrutura

```
pula/
├── manifest.json      # MV3, content script em document_start, zero permissions
├── content.js         # toda a lógica (CONFIG + seletores no topo)
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
| `manifest.json` | Botão ⟳ e depois F5. Se o Chrome reclamar, remova e carregue de novo |
| `icons/` | Botão ⟳ (pode precisar de hard-reload da página `chrome://extensions`) |

O ⟳ sozinho não basta: ele recarrega o pacote da extensão, mas a aba do YouTube
continua com a cópia antiga do content script já injetada. Sempre ⟳ + F5.

Atalho: deixe `chrome://extensions` aberta numa aba fixada e edite direto na
pasta — não existe watcher, mas ⟳ + F5 leva dois segundos.

## Ajustes

Tudo que você vai querer mexer está nos primeiros ~130 linhas do `content.js`:

- `CONFIG` — flags booleanas por comportamento
- `SKIP_BUTTON_SELECTORS` — quando o YouTube renomear a classe do botão, é aqui
- `OVERLAY_HIDE_SELECTORS` / `FEED_HIDE_SELECTORS` — o que some via CSS

Para descobrir o seletor novo quando quebrar: durante um anúncio, DevTools →
inspecione o botão de pular → copie a classe → adicione no topo do array.
