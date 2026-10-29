# Traim

Web app (HTML, CSS, JS puro, installabile come PWA) per salvare le tue tratte preferite e vedere con un tocco
il treno corrente e i 3 successivi: orari, ritardo, binario, posizione sulla linea, fonte del dato.
Interfaccia in italiano, inglese e tedesco.

## Fonti dati

| Fonte | Copre | Come |
| --- | --- | --- |
| [ViaggiaTreno](http://www.viaggiatreno.it) | Treni Trenitalia in tutta Italia, con ultimo rilevamento reale | API REST non ufficiali. Non permettono chiamate da altri siti (CORS), quindi passano dal proxy `/vt/...` in `dev-server.mjs`, che inoltra solo gli endpoint usati |
| [STA](https://www.suedtirolmobil.info) (EFA) | Tutti i treni in Alto Adige, anche SAD (es. Val Venosta), con orari stimati in tempo reale | `efa.sta.bz.it`, chiamata direttamente dal browser (CORS consentito) |

Per ogni rotta l'app interroga le fonti che coprono entrambe le stazioni e unisce i risultati per numero di treno.
Se un treno è in entrambe vince ViaggiaTreno, che riporta dove il treno è stato davvero rilevato.
Su ogni treno è indicata la fonte.

## Avvio in locale

Serve il server incluso (fa anche da proxy per ViaggiaTreno):

```bash
node dev-server.mjs
```

poi apri http://localhost:8080.

## Pubblicazione

- **App**: ogni push su `main` la pubblica su GitHub Pages (https://lecce.dev/traim/, dominio personalizzato
  dell'account: `flecce.github.io/traim/` fa redirect lì) con
  `.github/workflows/pages.yml`. In GitHub: Settings → Pages → Source: **GitHub Actions**.
- **Proxy ViaggiaTreno**: Deno Deploy, codice in `deno/` (https://traim-proxy.flecce.deno.net). Risponde con i
  CORS per le origini dell'app e tiene in cache per 30 secondi le risposte riuscite (`X-Cache: HIT/MISS`).
  L'app `traim-proxy` su https://console.deno.com è collegata a questo repository e si ripubblica a ogni push;
  l'entrypoint (`deno/main.js`) è definito in `deno.json`, quindi il pannello non va configurato.
- `js/config.js` usa il proxy locale su `localhost` e Deno Deploy altrove.
- Google login: aggiungi `https://lecce.dev` alle "Origini JavaScript autorizzate" del client OAuth.

## Dati salvati

Senza accesso, rotte e impostazioni (lingua, tema) restano nel browser (`localStorage`).
Dopo l'accesso con Google finiscono nel foglio `Traim` sul tuo Drive, con le schede `Routes` e `Settings`
(scaricabile come Excel da Sheets: File → Scarica → .xlsx).

Quando accedi:
- le rotte del dispositivo che non sono su Drive vengono aggiunte; quelle cancellate da un altro dispositivo spariscono;
- per le impostazioni vince la copia modificata più di recente; se su Drive non ci sono, vengono caricate quelle locali.

## Configurare il login Google

1. Vai su [Google Cloud Console](https://console.cloud.google.com/) e crea un progetto.
2. **API e servizi → Libreria**: abilita **Google Sheets API** e **Google Drive API**.
3. **Schermata consenso OAuth**: tipo "Esterno", aggiungi il tuo account tra gli utenti di test.
   Scope usati: `openid`, `email`, `.../auth/drive.file` (l'app vede solo i file che crea lei).
4. **Credenziali → Crea credenziali → ID client OAuth → Applicazione web**.
   In "Origini JavaScript autorizzate" aggiungi `http://localhost:8080`
   (e in futuro l'indirizzo dove pubblichi l'app).
5. Copia l'ID client in `js/config.js` → `googleClientId`.

## Struttura

| File | Cosa fa |
| --- | --- |
| `index.html`, `css/style.css` | Pagina unica, stile mobile-first, tema chiaro/scuro |
| `js/app.js` | Viste e routing (`#/`, `#/new`, `#/route/<id>[/r]`, `#/settings`) |
| `js/trains.js` | Ricerca stazioni e treni su tutte le fonti, unione dei risultati |
| `js/sources/viaggiatreno.js` | Client ViaggiaTreno |
| `js/sources/sta.js` | Client EFA di STA |
| `js/store.js`, `js/settings.js` | Rotte e impostazioni, in locale e su Drive |
| `js/google.js` | Login Google (GIS) e lettura/scrittura del foglio |
| `js/i18n.js` | Testi in it/en/de |
| `js/icons.js` | Icone SVG dell'interfaccia |
| `js/pwa.js`, `sw.js`, `manifest.webmanifest` | Installazione come app e funzionamento offline dell'interfaccia |
| `tools/make-icons.mjs` | Rigenera `icons/*.png` |
| `dev-server.mjs` | Server statico + proxy ViaggiaTreno in locale |
| `deno/` | Proxy ViaggiaTreno pubblicato su Deno Deploy |

## Limiti noti

- ViaggiaTreno non ha un'API ufficiale: può cambiare o bloccare le richieste del proxy in qualsiasi momento.
  STA continua a funzionare per le tratte in Alto Adige.
- ViaggiaTreno non elenca più i treni appena partiti: per quelli in viaggio in Alto Adige il dato arriva da STA.
- La posizione dei treni STA è stimata dagli orari in tempo reale, non da un rilevamento.
- Solo treni diretti (niente cambi).
- ViaggiaTreno (Akamai) può rifiutare le richieste che arrivano da reti cloud: dalla rete Cloudflare
  rispondeva 403. Se succede anche con Deno Deploy, la versione pubblicata mostra solo i treni STA.
  In locale, con `dev-server.mjs`, ViaggiaTreno funziona.
- Il login Google non sopravvive al ricaricamento della pagina: va ripetuto, i dati restano comunque in locale.
