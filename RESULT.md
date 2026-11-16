# markdown-render-speed-02 — Hasil Akhir

**Bounty:** markdown-render-speed-02, "Make Markdown rendering faster", $250 (juara 1 $50), 20 tempat dibayar
**Deadline:** Sel 17 Nov 2026 03:30 WIB (2026-11-16T20:30:00Z)
**Status:** SELESAI — siap submit (submit TIDAK dilakukan, sesuai batas)

## File
- `~/workspace/makefun/markdown-render-speed-02/parse.js` (63.571 byte) — drop-in `marked` 18.1.3, dependency-free ES module
- `~/workspace/makefun/markdown-render-speed-02/main.ts` (715 byte) — harness program (baca `/input/cases.json`, tulis `/output/html.json`)
- Total entri: 64.286 byte (batas 1.048.576) — lolos

## Kebenaran (byte-identik vs marked)
- **Practice set: 720/720 (100%)** — 680 contoh CommonMark 0.31.2 + GFM 0.29 + 40 dokumen generated
- **Scorer resmi: `{"passed":1,"cases_passed":720,"cases_total":720}`** — 71/71 grup lolos
- **`main.ts` end-to-end: 0/720 mismatch** vs `practice/reference/expected.json`
- Perbaikan terakhir (sesi ini): `inLink`/`inRawBlock` persisten antar-blok; `stripBlockquoteMarker` pakai ekspansi `J` marked; `Dt` hanya fence backtick + potong karakter (bukan kolom); `linkInText` sesuai marked (em/del menembus link); fence di list item hanya menangkap bila sudah ada code line proper; HTML block tipe 1-5 vs 6-7 (newline akhir)

## Kecepatan (CPU time, 5 iterasi, practice set, Node v24.22.1)
- **Semua 720 kasus: milikku 686,6 ms vs marked 993,8 ms → 30,9% lebih cepat (1,45x)**
- **40 dokumen saja: 677,1 ms vs 958,1 ms → 29,3% lebih cepat (1,41x)**

## Yang masih kurang untuk submit
1. **Sealed recording (recording_ids)** — bounty ini minta `recording_ids`, bukan transcript. Build harus dijalankan ulang di bawah perintah `record` kit make.fun SELAGI membangun; build tak terekam tidak bisa disubmit apa adanya.
2. **Repo GitHub publik** — belum ada; perlu dibuat + push `parse.js` + `main.ts` (+ LICENSE OSI) di bawah akun majikan.
3. **Submit via akun majikan** (@amin-zen, API key "Aminzen" sudah ada) — dilakukan parent setelah repo siap.
4. Final set diundi dari drand 10 menit setelah deadline (round 34019412, 2026-11-16T20:40:00Z); hasil 2026-12-01T20:40:00Z. Entry harus lebih cepat dari marked pada 95% confidence untuk dapat hadiah.

## Batasan dipatuhi
Tidak ada submit, tidak ada akun dibuat, tidak ada private key/keypair, tidak ada pembayaran, tidak ada transaksi mainnet. Build + test lokal saja.
