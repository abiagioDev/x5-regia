# X5 Regia

Editor di reframing per i video 360° di **Insta360 X5** (file `.insv`), pensato per fare "regia" dopo le riprese: movimenti di camera morbidi come quelli di un operatore, keyframe, tracking di persone e oggetti, export in qualsiasi formato.

*A reframing editor for Insta360 X5 360° footage (`.insv`): operator-like camera moves, keyframes, person/object tracking, gyro stabilization and GPU export. macOS / Apple Silicon. UI in Italian.*

## Cosa fa

- **Apre direttamente i `.insv`** (due fisheye 8K) e li cuce con un modello delle lenti stimato sui video reali, con giunta sfumata.
- **Stabilizzazione dal giroscopio** della camera: orizzonte sempre dritto, anche a mano libera.
- **Movimenti "da operatore"**: accelerano e atterrano morbidi, durata proporzionale alla distanza, leggero allargamento nei passaggi lunghi.
- **Keyframe** con tre modi di arrivo: *Movimento*, *Scivola dal precedente*, *Stacco*.
- **Soggetti e tracking** (Apple Vision): disegni un riquadro attorno a una persona/oggetto e la camera la segue.
- **Formati**: 16:9, 9:16, 1:1, 4:5, 4:3, 3:2, 2.39:1 o personalizzato; 720p–4K; HEVC, H.264, ProRes 422.
- **Export su GPU** dall'originale 8K, più veloce del tempo reale su Apple Silicon.

## Requisiti

- macOS con Apple Silicon
- Python 3.10+
- [ffmpeg](https://ffmpeg.org) (`brew install ffmpeg`)

## Avvio

```bash
git clone https://github.com/abiagioDev/x5-regia.git
cd x5-regia
./"Avvia X5 Regia.command"
```

Si apre `http://localhost:8360`. I video vengono cercati sulla Scrivania; per un'altra cartella:

```bash
X5_MEDIA=/percorso/ai/video ./"Avvia X5 Regia.command"
```

## Come si usa

| Tasto | Azione |
|---|---|
| `Spazio` | play / pausa |
| `←` `→` | frame precedente / successivo (`⇧` = 5 s) |
| `↑` `↓` | keyframe precedente / successivo |
| `K` | keyframe con la vista attuale |
| `1`–`9` | movimento verso il soggetto (`⇧` = stacco) |
| `T` | disegna un riquadro e segui una persona/oggetto |
| `A` `S` `D` `F` | taglio stretto / medio / largo / totale |
| `⌘Z` / `⇧⌘Z` | annulla / ripeti |

## Come funziona

| File | Ruolo |
|---|---|
| `server.py` | server locale: copie leggere per l'anteprima, giroscopio, progetti, job di tracking ed export |
| `lens.py` | modello delle lenti X5 e cucitura |
| `export_worker.py` | render GPU (OpenGL) dall'originale, codifica hardware VideoToolbox |
| `tracker.py` | tracking con Apple Vision su viste prospettiche stabilizzate |
| `calib/fit_lens.py` | stima del modello delle lenti dalla sovrapposizione dei due obiettivi |
| `web/` | interfaccia (WebGL) |

## Licenza

MIT
