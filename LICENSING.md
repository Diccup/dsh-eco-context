# Licensing

This package contains work under two licenses.

## 1. This package — MIT

Everything outside `vendor/` is original work by this package's author,
licensed under the MIT License in [`LICENSE`](./LICENSE):

```
platform/   ours/   engine/   modes/   skills/   deps/   fp/
```

**This includes `engine/`.** The 1.0.0 engine (17 blocks + 3 libs) is written
from scratch and does **not** derive from the upstream context-mode source.

## 2. The upstream license notice — Elastic License 2.0

`vendor/context-mode/` contains **only** the original `LICENSE` file from
`52sujiu/context-mode`, kept under the **Elastic License 2.0** (ELv2) to
honor its attribution and notice requirements.

```
vendor/context-mode/LICENSE
```

**No upstream engine code ships in this package.** The 1.2.x line carried a
675 KB `server.bundle.mjs` built from the upstream source; 1.0.0 removed it
(the engine runs in-process and is original work). The upstream package.json
is retained alongside the license for provenance.

## Notes

- ELv2 is not an open-source license. Because this package no longer contains
  any ELv2-licensed **code** — only the license text and provenance metadata —
  the package as a whole is distributed under MIT, with the upstream notice
  preserved in `vendor/context-mode/` as a courtesy and for traceability.
- If you redistribute the upstream context-mode project itself, its own
  ELv2 terms apply to that project, not to this one.
