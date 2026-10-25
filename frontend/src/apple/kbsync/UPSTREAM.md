# Browser kbsync implementation

Ported from Lakr233/AssppWeb PR #98, revision
`67338e316679572de7433573d86a0671c62b9fdd` (linusxiong), whose browser
emulator derives from the SAP work by hubo1989 in PR #89.

The StoreAgent protocol and ent/download request follow majd/ipatool
`3411d57f451f5111ae115641c22f7ed17bbd5fbe`.

The bundled Unicorn runtime is Unicorn 2.1.4 with the TCI/WebAssembly patch
and glue under `frontend/scripts/unicorn-wasm-patch/`. Its upstream is
https://github.com/unicorn-engine/unicorn/tree/2.1.4 and its license notices
are included alongside the vendor files. No Apple executable is committed;
the build extracts fixed public Apple update assets and verifies pinned hashes.

Vendored unicorn.wasm SHA-256:
`697bee7fb581f34c63a367fde85940e49d171655af441092601ede7a1b75b132`.

Local adaptations retain the existing SAP login service, canonical authentication
URLs, server-side credential-free catalog lookups, version metadata caching,
and UI. Asset preparation and worker generation are serialized; known Apple
account/license verdicts do not trigger repeated blob generation or sign-ins.
