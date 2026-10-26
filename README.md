# X5 Regia

Editor di reframing per i video 360° di **Insta360 X5** (file `.insv`), pensato per fare "regia" dopo le riprese: movimenti di camera come quelli di un operatore, keyframe, persone trovate e seguite in automatico, montaggio, audio esterno, colore ed export in qualsiasi formato.

*A reframing editor for Insta360 X5 360° footage (`.insv`): operator-like camera moves, keyframes, automatic person detection and tracking, auto-director, editing, external audio sync, color/LUTs and GPU export. macOS / Apple Silicon. UI in Italian.*

## Funzioni

**Immagine**
- Apre direttamente i `.insv` (due fisheye 8K) e li cuce con un modello delle lenti stimato sui video reali, con giunta sfumata e colore uniformato tra i due obiettivi.
- *Distanza di cucitura* regolabile per chi è vicino alla camera.
- Stabilizzazione dal giroscopio della camera: orizzonte sempre dritto, anche a mano libera.
- Grandangoli senza bordi stirati, *pianetino* e *tunnel*.

**Regia**
- Movimenti "da operatore": accelerano e atterrano morbidi, durata proporzionale alla distanza, leggero allargamento nei passaggi lunghi. Curve di velocità per ogni keyframe.
- Keyframe con tre modi di arrivo: *Movimento*, *Scivola dal precedente*, *Stacco*.
- **Trova persone**: rileva tutte le persone nella sfera (Apple Vision) e le segue per tutto il video; tagli sul corpo (*primo piano*, *mezza figura*, *figura intera*) che si adattano se la persona si avvicina.
- Riquadri disegnati a mano per seguire qualsiasi oggetto.
- **Regia automatica**: dal ritmo della musica (BPM, battute) e da chi si muove di più propone una sequenza di inquadrature da ritoccare.

**Montaggio e audio**
- Progetti con più clip in sequenza, file importati da qualsiasi cartella o dalla scheda SD.
- Intervallo da esportare, tratti da togliere, rallentatori e accelerazioni, annulla/ripeti.
- Forma d'onda sulla timeline.
- **Audio esterno** (mix dello studio, registratore) allineato in automatico all'audio della camera.

**Colore ed export**
- Esposizione, contrasto, saturazione, temperatura, tinta e LUT `.cube`.
- Formati 16:9, 9:16, 1:1, 4:5, 4:3, 3:2, 2.39:1 o personalizzato; 720p–4K; HEVC, H.264, ProRes 422.
- Coda di export (es. 16:9 e 9:16 dalla stessa regia), render su GPU dagli originali 8K, più veloce del tempo reale su Apple Silicon.

## Requisiti

- macOS 13+ con Apple Silicon
- Python 3.10+
- [ffmpeg](https://ffmpeg.org) (`brew install ffmpeg`)

## Installazione

```bash
git clone https://github.com/abiagioDev/x5-regia.git
cd x5-regia
./build_app.sh
```

Crea **X5 Regia.app** nella cartella: doppio clic per aprirla (puoi trascinarla nel Dock). In alternativa, nel browser:

```bash
./"Avvia X5 Regia.command"
```

I `.insv` sulla Scrivania compaiono da soli; gli altri si importano da *+ Nuovo → Importa*. Variabili utili: `X5_MEDIA` (cartella dei video), `X5_OUT` (dove salvare gli export).

## Tasti

| Tasto | Azione |
|---|---|
| `Spazio` | play / pausa |
| `←` `→` | frame (`⇧` = 5 s) · `J` `L` ±2 s |
| `↑` `↓` | keyframe precedente / successivo |
| `K` | keyframe con la vista attuale |
| `1`–`9` | vai al soggetto · `0` tutti · con `⇧` = stacco |
| `A` `S` `D` `F` | stretto / medio / largo / totale (sulle persone: primo piano / mezza figura / figura intera) |
| `P` | trova persone |
| `T` | disegna un riquadro da seguire |
| `I` `O` `X` | segna inizio · fine intervallo · togli il tratto |
| `⌘Z` / `⇧⌘Z` | annulla / ripeti |

## Come funziona

| File | Ruolo |
|---|---|
| `server.py` | server locale: libreria, progetti multi-clip, copie leggere, giroscopio, forma d'onda, job |
| `app.py`, `build_app.sh` | app per Mac (finestra nativa) |
| `lens.py` | modello delle lenti X5, cucitura, uniformazione colore |
| `web/core.glsl` | shader condiviso da anteprima ed export: cucitura, proiezioni, colore, LUT |
| `export_worker.py` | render GPU (OpenGL) dagli originali, codifica hardware VideoToolbox |
| `tracker.py`, `detect.py` | tracking e rilevamento persone con Apple Vision |
| `audiosync.py` | allineamento dell'audio esterno |
| `autodirector.py` | regia automatica |
| `calib/fit_lens.py` | stima del modello delle lenti dalla sovrapposizione dei due obiettivi |
| `web/` | interfaccia (WebGL2) |

## Licenza

MIT
