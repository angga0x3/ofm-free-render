# ofm-free — Our Free Model di Render

Router model AI **tanpa API key, tanpa login, tanpa akun**. Upstream-nya gateway
publik `opencode.ai/inference/v1` (11 model gratis) + `api.kilo.ai` (14 model gratis).

Berdasarkan [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) v2.9.0 (MIT),
dipotong dari 270 MB → 15 MB dengan membuang binary Windows dan build desktop.

## Arsitektur

Service standalone-nya **sengaja hanya bind `127.0.0.1`** — manajemen dan inferensi
loopback by design, bind non-loopback ditolak. Render mengarahkan trafik ke `$PORT`
di `0.0.0.0`. Jadi ada dua hop:

```
Render :$PORT  →  gateway (publik: /health + /v1/*, tukar key, retry, filter model mati)
                     ↓
               relay 0.0.0.0:$RELAY_PORT   ← mode LAN resmi dari service
                     ↓
               service 127.0.0.1:18900     ← admin tetap privat
```

Gateway (`health-shim.mjs`) menyelesaikan tiga hal sekaligus:

1. **Health check** — relay membalas 401 ke probe Render yang tanpa auth.
2. **Key stabil** — klien memakai `OFM_CLIENT_KEY` (env, di-generate Render), gateway
   menukarnya dengan LAN key aktif milik service. Dengan disk, LAN key itu sendiri
   juga bertahan antar deploy.
3. **Batas permukaan** — hanya `/models`, `/chat/completions`, `/responses`,
   `/messages`, `/messages/count_tokens` yang diteruskan; manajemen tetap 404 dari luar.

## Deploy

1. Push repo ini ke GitHub.
2. Render → **New** → **Blueprint** → pilih repo.
3. Apply. Tidak ada secret yang perlu diisi — `OFM_CLIENT_KEY` di-generate Render.

`autoDeploy: true` — setiap push ke branch yang terhubung langsung memicu deploy ulang.

## Endpoint

Base URL: `https://<service>.onrender.com`

Tiga protokol sekaligus, semuanya lewat gateway yang sama:

| Protokol | Path | Auth |
|---|---|---|
| [OI] Chat Completions | `POST /v1/chat/completions` | `Authorization: Bearer` / `x-api-key` |
| [OI] Responses | `POST /v1/responses` | idem |
| Anthropic Messages | `POST /v1/messages` | `x-api-key` + `anthropic-version` |
| Anthropic count_tokens | `POST /v1/messages/count_tokens` | idem |
| Daftar model | `GET /v1/models` | idem |

Key ada di Render → service → **Environment** → `OFM_CLIENT_KEY`.

`/health` terbuka tanpa auth (dipakai Render) dan tidak membocorkan key maupun
port relay internal.

```json
{"ok":true,"service":"ofm-free","version":"1.1.0","keyReady":true,
 "relayReady":true,"deadModels":0,"uptime":42}
```

`?strict=1` membuat `/health` langsung 503 begitu relay key hilang, tanpa masa
tenggang. Tanpa itu, probe tetap 200 selama `OFM_KEY_GRACE_MS` (default 60 detik)
supaya cold start tidak dibunuh sebelum service sempat mencetak LAN key.

## Tes

```bash
BASE=https://<service>.onrender.com
KEY=<OFM_CLIENT_KEY>

# health
curl $BASE/health

# chat
curl $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"2+2?"}]}'

# streaming (thinking muncul di delta.reasoning)
curl -N $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","stream":true,
       "messages":[{"role":"user","content":"hitung 1-5"}]}'

# Anthropic Messages (thinking ada di blok tersendiri, non-stream)
curl $BASE/v1/messages \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","max_tokens":50,
       "messages":[{"role":"user","content":"2+2?"}]}'

# toolcall — nama tool mengikuti manifest opencode (read/shell/edit/write/grep/glob)
curl $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free",
       "messages":[{"role":"user","content":"Baca /etc/hostname"}],
       "tools":[{"type":"function","function":{"name":"read",
         "parameters":{"type":"object","properties":{"filePath":{"type":"string"}}}}}]}'
```

## Tes lokal

```bash
npm run test:gateway
```

Menjalankan `health-shim.mjs` melawan `test/mock-relay.mjs` — relay tiruan yang
meniru dua perilaku upstream asli: menolak saat jenuh (502) dan menolak satu id
model dengan `Model does not support this protocol`. 13 pemeriksaan, tanpa
kredensial dan tanpa jaringan.

## Model (25 hidup, 26 terdaftar)

**OpenCode (11, gratis):** `big-pickle` · `deepseek-v4.1-flash-free` ·
`nemotron-3.5-lightning-free` · `nemotron-3.5-super-vl-free` · `mimo-v2.6-flash-free` ·
`hy4-flash-free` · `iceman-free` · `beam-free` · `flint-40b-free` · `longcat-2.5-free` ·
`tidepool-alpha-free`

**Kilo (13, gratis):** `kilo-auto/free` · `inclusionai/ling-3.2-flash:free` ·
`baidu/ernie-5.5-flash-preview:free` · `liquid/lfm-3-1.7b:free` · dll.

**Tidak hidup:** `jev-1.13-free` — upstream menolak dengan
`Model does not support this protocol` di ketiga protokol. Gateway menandainya
mati selama `OFM_DEAD_MODEL_TTL_MS` (default 30 menit), mengeluarkannya dari
`/v1/models` (header `x-ofm-filtered: 1`), dan menjawab 400 yang jelas tanpa
memutar request ke upstream. `GET /v1/models?all=1` menampilkan daftar mentah.

Model `*-vl` terdaftar tapi endpoint image-nya mati di upstream
(`422 Upstream request failed: Endpoint is unavailable`) — jangan andalkan vision.

## Hasil tes lokal (sebelum push)

| Tes | Hasil |
|---|---|
| `test/gateway.test.mjs` | **13/13 lulus** |
| `/health` | 200, tanpa port relay, tanpa key |
| chat | 200, `"OK"` |
| 12 request serentak | **12/12 200** (mock relay dibatasi 4 konkuren) |
| streaming | SSE utuh sampai `[DONE]`, `delta.reasoning` ikut |
| `/v1/messages` | 200, blok `thinking` + `text`, `stop_reason` benar |
| `/v1/responses` | 200, `phase: final_answer` |
| toolcall (`read`) | `{"filePath":"/etc/hostname"}` |
| model mati | 400 lokal, 9 ms, lalu hilang dari listing |
| restart | LAN key sama, `dead-models.json` bertahan |
| SIGTERM | semua port lepas < 3 detik, tanpa proses zombie |

## Jebakan yang sudah dilewati

1. **`disk:` butuh plan berbayar.** Di plan Free, Render menolak dengan
   *"disks are not supported for free tier services"*. Blueprint ini memakai
   `plan: starter`, jadi disk 1 GB di `/data` didukung.
2. **Jangan tulis `standaloneLanKey` = `forwardKey`.** Service menganggap pasangan
   yang sama sebagai "belum diset" lalu me-mint ulang tiap boot — sudah diukur:
   key berubah meski disk ada. `start.sh` hanya mengisi `forwardKey`; LAN key
   dibiarkan milik service dan bertahan lewat disk (terverifikasi: boot 1 = boot 2).
3. **`forwardKey` bukan `OFM_CLIENT_KEY`.** `generateValue` Render menghasilkan
   base64 (`/`, `+`, `=`). Aman di header, tapi nilai itu juga dioper ke pemanggil
   internal sebagai nilai config. `start.sh` memakai random lokal untuk
   `forwardKey`, dan `OFM_CLIENT_KEY` tetap string opaque yang hanya lewat header.
4. **Nama tool mengikuti manifest opencode** (`read`, `shell`, `edit`, `write`, `grep`,
   `glob`). Kalau klien mendeklarasikan `read_file`, OFM menolak:
   *"the model answered by calling read instead of writing an answer"*.
5. **Plan Free tidur** setelah ~15 menit idle (cold start 30–50 detik) dan bisa
   di-suspend kalau trafik keluarnya dianggap tidak wajar. `plan: starter` tidak
   tidur — penting karena service ini terus memanggil upstream.
6. **Jangan commit secret** — repo upstream membawa Google OAuth client secret bawaan
   (untuk channel Gemini); sudah diganti placeholder supaya lolos secret scanning.
7. **`exec` membuat service jadi PID 1**, sehingga trap tidak pernah jalan dan port
   relay bisa tetap terikat saat redeploy cepat; boot berikutnya lalu gagal dengan
   `LAN relay could not start (EADDRINUSE)` dan menyajikan 502. Sekarang tiap anak
   punya process group sendiri dan shutdown menunggu (maks 10 detik) sebelum KILL.
8. **System prompt ~3.970 token disuntik upstream** di wire chat dan responses
   (`prompt_tokens: 3984` untuk `"hi"`). Wire Anthropic **tidak** menyuntiknya
   (`input_tokens: 16`), jadi jalur `/v1/messages` adalah yang paling hemat dan
   satu-satunya yang mengembalikan thinking di non-stream.
9. **Burst > 4 konkuren membuat upstream membalas 502**, bukan 429. Gateway
   menyangga body (maks 32 MiB) dan mengulang maks `OFM_RETRIES` (default 2) selama
   belum ada byte yang dikirim ke klien.

## Variabel environment

| Variabel | Default | Fungsi |
|---|---|---|
| `OFM_CLIENT_KEY` | — (wajib) | key yang dipakai klien |
| `OFM_HOME` | `$PWD/ofm-data` | direktori data service |
| `OFM_INTERNAL_PORT` | `18900` | port loopback service |
| `OFM_RELAY_PORT` | `18901` | port relay LAN |
| `OFM_RETRIES` | `2` | pengulangan saat relay 502/503 |
| `OFM_UPSTREAM_TIMEOUT_MS` | `300000` | timeout ke relay |
| `OFM_MAX_BODY_BYTES` | `33554432` | batas body request |
| `OFM_DEAD_MODEL_TTL_MS` | `1800000` | lama model mati disembunyikan |
| `OFM_KEY_GRACE_MS` | `60000` | masa tenggang `/health` saat key belum ada |

## Lisensi

Mengikuti upstream (MIT). Lihat repo asal untuk teks lengkap dan atribusi.
