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
Render :$PORT  →  gateway (publik: /health + /v1/*, tukar key)
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
   `/messages` yang diteruskan; manajemen tetap 404 dari luar.

## Deploy

1. Push repo ini ke GitHub.
2. Render → **New** → **Blueprint** → pilih repo.
3. Apply. Tidak ada secret yang perlu diisi — `OFM_CLIENT_KEY` di-generate Render.

## Endpoint

- **Base URL:** `https://<service>.onrender.com/v1`
- **Auth:** `Authorization: Bearer <OFM_CLIENT_KEY>`

Key ada di Render → service → **Environment** → `OFM_CLIENT_KEY`.

`/health` terbuka tanpa auth (dipakai Render) dan tidak membocorkan key —
hanya `{"ok":true,"keyReady":true}`.

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

# toolcall
curl $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free",
       "messages":[{"role":"user","content":"Baca /etc/hostname"}],
       "tools":[{"type":"function","function":{"name":"read",
         "parameters":{"type":"object","properties":{"filePath":{"type":"string"}}}}}]}'
```

## Model (24)

**OpenCode (11, gratis):** `big-pickle` · `deepseek-v4.1-flash-free` ·
`nemotron-3.5-lightning-free` · `nemotron-3.5-super-vl-free` · `mimo-v2.6-flash-free` ·
`hy4-flash-free` · `iceman-free` · `beam-free` · `flint-40b-free` · `longcat-2.5-free` ·
`tidepool-alpha-free`

**Kilo (13, gratis):** `kilo-auto/free` · `inclusionai/ling-3.2-flash:free` ·
`baidu/ernie-5.5-flash-preview:free` · `liquid/lfm-3-1.7b:free` · dll.

## Hasil tes lokal (sebelum push)

| Tes | Hasil |
|---|---|
| `/health` | 200 `{"ok":true,"keyReady":true}` |
| chat | 200, **1,2–2,1s** |
| 5 request beruntun | **5/5 200**, total 8s |
| key salah | **401** |
| management path dari luar | **404** |
| toolcall (`read`) | `{"filePath":"/etc/hostname"}` |
| prompt tokens | **~3.990** (vs 15.351 di router sendiri) |

## Jebakan yang sudah dilewati

1. **`disk:` butuh plan berbayar.** Di plan Free, Render menolak dengan
   *"disks are not supported for free tier services"*. Blueprint ini memakai
   `plan: starter`, jadi disk 1 GB di `/data` didukung.
2. **Jangan tulis `standaloneLanKey` = `forwardKey`.** Service menganggap pasangan
   yang sama sebagai "belum diset" lalu me-mint ulang tiap boot — sudah diukur:
   key berubah meski disk ada. `start.sh` hanya mengisi `forwardKey`; LAN key
   dibiarkan milik service dan bertahan lewat disk (terverifikasi: boot 1 = boot 2).
3. **Nama tool mengikuti manifest opencode** (`read`, `shell`, `edit`, `write`, `grep`,
   `glob`). Kalau klien mendeklarasikan `read_file`, OFM menolak:
   *"the model answered by calling read instead of writing an answer"*.
4. **Plan Free tidur** setelah ~15 menit idle (cold start 30–50 detik) dan bisa
   di-suspend kalau trafik keluarnya dianggap tidak wajar. `plan: starter` tidak
   tidur — penting karena service ini terus memanggil upstream.
5. **Jangan commit secret** — repo upstream membawa Google OAuth client secret bawaan
   (untuk channel Gemini); sudah diganti placeholder supaya lolos secret scanning.

## Lisensi

Mengikuti upstream (MIT). Lihat repo asal untuk teks lengkap dan atribusi.
