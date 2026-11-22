# ofm-free — Our Free Model di Render

Router model AI **tanpa API key, tanpa login, tanpa akun**. Upstream-nya gateway
publik `opencode.ai/inference/v1` (11 model gratis) + `api.kilo.ai` (14 model gratis).

Berdasarkan [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) v2.9.0 (MIT),
dipotong dari 270 MB → 15 MB dengan membuang binary Windows dan build desktop.

## Kenapa ada `start.sh` + `health-shim.mjs`

Service standalone-nya **sengaja hanya bind `127.0.0.1`** — manajemen dan inferensi
loopback by design, bind non-loopback ditolak. Render mengarahkan trafik ke `$PORT`
di `0.0.0.0`. Jadi ada dua hop:

```
Render :$PORT  →  health-shim (publik, jawab /health)
                    ↓
              relay 0.0.0.0:$RELAY_PORT   ← mode LAN resmi dari service
                    ↓
              service 127.0.0.1:18900     ← admin tetap privat
```

Shim diperlukan karena relay membalas **401** untuk health probe Render yang tanpa auth.

## Deploy

1. Push repo ini ke GitHub.
2. Render → **New** → **Blueprint** → pilih repo.
3. Apply. Tidak ada secret yang perlu diisi.

`render.yaml` sudah menyiapkan disk 1 GB di `/data` supaya kunci API dan pengaturan
bertahan antar deploy.

## Endpoint

- **Base URL:** `https://<service>.onrender.com/v1`
- **Auth:** `Authorization: Bearer <LAN key>`

### Cara ambil LAN key

Key dibuat otomatis saat boot pertama. Ada di dashboard manajemen:

```
http://<service>.onrender.com/health     → cek keyReady
```

Untuk key lengkap, buka dashboard: `https://<service>.onrender.com/#login=<token>`
(token tercetak di log Render saat boot, 10 menit, sekali pakai) → menu
**LAN 推理** → salin LAN Key.

Alternatif: baca langsung dari disk lewat Render Shell:

```bash
cat /data/ofm/settings.json | python3 -c "import json,sys;print(json.load(sys.stdin)['standaloneLanKey'])"
```

## Tes

```bash
BASE=https://<service>.onrender.com
KEY=<LAN key>

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
       "tools":[{"type":"function","function":{"name":"read_file",
         "parameters":{"type":"object","properties":{"file_path":{"type":"string"}}}}}]}'
```

## Model (25)

**OpenCode (11, gratis):** `big-pickle` · `deepseek-v4.1-flash-free` ·
`nemotron-3.5-lightning-free` · `nemotron-3.5-super-vl-free` · `mimo-v2.6-flash-free` ·
`hy4-flash-free` · `iceman-free` · `beam-free` · `flint-40b-free` · `longcat-2.5-free` ·
`tidepool-alpha-free`

**Kilo (14, gratis):** `kilo-auto/free` · `inclusionai/ling-3.2-flash:free` ·
`baidu/ernie-5.5-flash-preview:free` · `liquid/lfm-3-1.7b:free` · dll.

## Hasil tes lokal (sebelum push)

| Tes | Hasil |
|---|---|
| `/health` | 200 `{"ok":true,"keyReady":true}` |
| chat | 200, **0,9–1,9s** |
| streaming | SSE normal |
| toolcall | `read_file` + `{"file_path":"/etc/hostname"}` |
| 6 request beruntun | **6/6 200, nol 429** |
| prompt tokens | **~3.990** (vs 15.351 di router sendiri) |

## Catatan

- **Tanpa token apa pun.** `Authorization: Bearer public` untuk upstream — tidak ada
  kredensial yang bisa expired.
- **Render free tier tidur** setelah ~15 menit idle; request pertama bangun 30–50 detik.
- Dashboard manajemen hanya listen loopback — di Render hanya `/health` dan `/v1/*`
  yang bisa diakses dari luar.
- Lisensi mengikuti upstream (MIT) — lihat `LICENSE` di repo asal.
