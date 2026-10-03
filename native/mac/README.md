# macOS voice helpers

Written by the Mac owner during the go/no-go spikes (`hands-research/spikes/ptt`, `spikes/stt`), copied here unchanged.
Measured on the team's Mac (research-spikes.md §2-3): SpeechTranscriber en-US about 0.18-0.24 s, zh-HK 0.33 s warm.

Build once (on the Mac):

```sh
mkdir -p native/mac/bin
swiftc -O native/mac/ptt-helper.swift -o native/mac/bin/ptt-helper
swiftc -O native/mac/stt.swift -o native/mac/bin/stt
native/mac/bin/stt install zh-HK      # one-time Apple model download (~137 s)
native/mac/bin/ptt-helper --check     # prints Input Monitoring / microphone status
```

`src/intake/index.ts` runs `ptt-helper`, and on each key-up runs `stt analyzer <wav> en-US` and `stt analyzer <wav> zh-HK`
in parallel, then hands both transcripts to the parser, which keeps the better parse.
