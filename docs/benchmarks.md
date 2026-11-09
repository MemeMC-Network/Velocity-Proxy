# Benchmark report

All numbers below were produced by `npm run bench` on the development machine, against the same
server process, the same fixture site and the same Node/Chromium build. Nothing here is estimated.

## Environment

| | |
| --- | --- |
| Host | Windows 10 development machine, 4 physical / 8 logical cores, SSD |
| Node | 22.17.0 |
| Browser | Google Chrome channel 156.0.8078.81, headless, sandbox on |
| Server config | `AUDIO_ENABLED=0`, `MAX_TABS=12`, `MAX_LIVE_TABS=8`, `LOG_LEVEL=warn` |
| Fixtures | local HTTP server: `/article` (40 paragraphs), `/heavy` (2,500 DOM nodes + CSS animation), 1×1 PNG |

The fixture pages are served from loopback, so **network time is effectively zero**. These numbers
measure server work, not internet latency.

## Raw result

```json
{
  "startupMs": 564,
  "light": {
    "singlePageMs": 10,
    "heavyPageMs": 44,
    "singlePayloadKb": 12.8,
    "heavyBlocks": 500,
    "tenPagesWallMs": 14,
    "tenPagesPayloadKb": 301.4,
    "tenTabsWallMs": 473,
    "tabsAfterOpen": 10,
    "serverRssDeltaMb": 33,
    "serverHeapDeltaMb": 22,
    "chromiumProcessesStarted": 0,
    "chromiumMbStarted": 0,
    "idleCpuCorePercent": 0.4
  },
  "chromium": {
    "coldLaunchAndNavMs": 743,
    "firstFrameMs": 488,
    "idleCpuCorePercent": 2.9,
    "heavy": {
      "navMs": 461,
      "fps": 30.6,
      "frameKb": 23,
      "cpuCorePercent": 7.3,
      "serverRssMb": 100
    },
    "fiveTabs": {
      "openMs": [511, 512, 511, 510],
      "liveTabs": 5,
      "processCount": 16,
      "processRssMb": 1158,
      "rssPerTabMb": 231.6
    }
  }
}
```

## What it says

| Measurement | Lightweight | Full browser |
| --- | --- | --- |
| Time to have a page ready | **10 ms** (article), 44 ms (heavy) | **743 ms** cold launch + navigation, 488 ms to first frame |
| Ten pages at once | **14 ms** (fetch API), 473 ms as ten real tabs | not attempted: 10 tabs ≈ 2.3 GB |
| Server memory for 10 tabs | **+33 MB RSS / +22 MB heap** | ~232 MB per tab (~1.16 GB for 5) |
| Chromium processes started | **0** | 16 for 5 tabs |
| Idle CPU | **0.4 %** of one core | 2.9 % of one core (static page) |
| Active CPU | n/a (no rendering) | 7.3 % of one core on an animated page at 30.6 fps |
| Wire payload | 12.8 KB per article | 23 KB per frame × ~30 fps ≈ 5.6 Mbps while animating |

Three things follow from this, and only these three:

1. For text pages, the lightweight engine removes the browser work almost entirely: a page is a
   fetch and a parse, and ten of them cost a few megabytes of server heap.
2. Chromium's cost is dominated by per-tab renderer memory, not by the server process: the Node
   process stayed near 100 MB while 1.16 GB of Chromium memory was in use.
3. A static page still costs idle CPU in Chromium (2.9 % of a core here) because the renderer and
   compositor stay alive; a light tab costs essentially nothing when idle.

## What it does not say

- **It is not a VPS measurement.** A 4-core VPS with no GPU will be slower on Chromium navigation,
  and its `--enable-unsafe-swiftshader` software GL path is not exercised by these text pages. The
  light-engine numbers should transfer well because they are CPU/parse bound on small documents.
- **Audio is disabled** in this run. Audio capture adds `parec`/ffmpeg work per session that is not
  in these figures.
- **The fixture is not the web.** A real article page is bigger than 40 paragraphs and often 10×
  the payload; the ratio (one small JSON vs a stream of JPEGs) holds, the absolute numbers do not.
- **The five-tab phase opened tabs sequentially**; concurrency behaviour at 20 Chromium tabs was not
  measured because the machine would swap, which would make the comparison meaningless.

## Reproducing

```bash
npm run bench      # prints the JSON above
npm run smoke      # 38 end-to-end checks on the full-browser engine
npm run test:light # 12 end-to-end checks on the lightweight engine
```

The benchmark boots its own server on port 8094 with a throwaway data directory and its own fixture
site, and removes both afterwards. It reads memory from `/api/stats` and CPU time from the same
endpoint's `process.cpuUserMs`/`cpuSystemMs`, so the numbers include the proxy itself and not just
the browser.

## Before/after on the streaming path

The earlier optimisation pass (separate from this report) cut the full-browser stream from ~24 Mbps
bursts to a metered stream, by budgeting bytes per second instead of reacting to frame rate:

| | Before | After |
| --- | --- | --- |
| TikTok tab | ~24 Mbps, 2–30 fps swings | ~5.8 Mbps average, 8.9 Mbps peak, ~19 fps |
| Text-heavy page that repaints | 21–24 Mbps | ~13 Mbps, frame rate stepped 30 → 20 |

Those runs used a live destination over the internet, so they are not directly comparable with the
loopback fixture numbers above; they are recorded here for context only.
