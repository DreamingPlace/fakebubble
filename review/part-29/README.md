# Part 29 screenshots (review only; this branch is never merged)

Taken by `node scripts/check-web-voice-29-browser.ts <dir>` on the console fixture (offline Fish stand-in, free tier on as in production), at 1440 and 1280:

- `voice-fresh-*`: 声音 of a character an import left with a Fish id and no binding: one field (Fish 音色 ID) and 语速, nothing 未保存.
- `voice-prepared-*`: after 准备新素材版本 ("素材版本 1"): per slot 生成 (paid) with 或上传自己的 WAV folded under it.
- `voice-generated-*`, `voice-approved-*`: both lines generated (marked 生成), 试听 loaded, 批准.
- `voice-stale-*`: a changed line makes the version 需重新准备, with the button.
- `voice-unknown-*`: a provider failure leaves the slot 「未确认 · WEB_PROVIDER_WIRE_MISMATCH」.
- `system-security-*`: 系统状态 → 安全 with the limiter overflow count.
